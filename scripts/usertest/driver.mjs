#!/usr/bin/env node
/**
 * A hand, driven by a script. The harness the user-test agents run on.
 *
 * Chrome is launched against a throwaway profile and killed by pid, so a browser the user has
 * open with their own tabs is never touched.
 *
 * The synthetic hand is installed with `addScriptToEvaluateOnNewDocument`, which matters: the
 * pointer decides whether to open a camera the first time it mounts, so anything installed
 * after navigation is already too late and the page would sit there asking for a webcam.
 */
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function openKiosk({ url, width = 1600, height = 900 }) {
  const profile = await mkdtemp(join(tmpdir(), "usertest-"));
  const port = 9400 + Math.floor(Math.random() * 500);
  const chrome = spawn(
    CHROME,
    [
      "--headless=new",
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profile}`,
      `--window-size=${width},${height}`,
      "--hide-scrollbars",
      "--no-first-run",
      "--enable-unsafe-swiftshader",
      "about:blank",
    ],
    { stdio: "ignore" },
  );

  let ws = null;
  for (let i = 0; i < 80 && !ws; i += 1) {
    await sleep(250);
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      ws = list.find((t) => t.type === "page")?.webSocketDebuggerUrl ?? null;
    } catch {
      /* not up yet */
    }
  }
  if (!ws) {
    chrome.kill("SIGTERM");
    throw new Error("chrome debug endpoint never came up");
  }

  const sock = new WebSocket(ws);
  await new Promise((res, rej) => {
    sock.onopen = res;
    sock.onerror = () => rej(new Error("debug socket failed"));
  });

  let id = 0;
  const pending = new Map();
  const problems = [];
  sock.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg.result);
      pending.delete(msg.id);
      return;
    }
    if (msg.method === "Runtime.exceptionThrown") {
      const d = msg.params?.exceptionDetails;
      problems.push(`exception: ${d?.exception?.description ?? d?.text ?? "unknown"}`);
    }
    if (msg.method === "Runtime.consoleAPICalled" && msg.params?.type === "error") {
      const text = (msg.params.args ?? []).map((a) => a.value ?? a.description ?? "").join(" ");
      problems.push(`console.error: ${text}`);
    }
  };
  const send = (method, params = {}) =>
    new Promise((res) => {
      const n = ++id;
      pending.set(n, res);
      sock.send(JSON.stringify({ id: n, method, params }));
    });

  const evaluate = async (expression) => {
    const r = await send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (r?.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? "threw");
    return r?.result?.value;
  };

  await send("Page.enable");
  await send("Runtime.enable");
  // The hand has to exist before the app's first render, or the pointer takes the camera path.
  await send("Page.addScriptToEvaluateOnNewDocument", {
    source: `window.__handSim = { aim: { u: 0.5, v: 0.5 }, pinching: false, present: true, label: "None" };`,
  });
  await send("Page.navigate", { url });
  await sleep(3500); // the app mounts, and presence needs to persist past enterMs

  const api = {
    evaluate,
    problems,
    /** Point the hand at a screen position, in unit coordinates, and wait for it to arrive. */
    async aim(u, v, { settle = true } = {}) {
      await evaluate(`window.__handSim.aim = { u: ${u}, v: ${v} }`);
      if (!settle) return;
      // Wait for the smoothing to actually get there rather than guessing at a sleep.
      for (let i = 0; i < 60; i += 1) {
        await sleep(50);
        const d = await evaluate(
          `(() => { const s = window.__handState(); return Math.hypot(s.x - ${u}, s.y - ${v}); })()`,
        );
        if (typeof d === "number" && d < 0.006) return;
      }
    },
    async aimPx(x, y, opts) {
      const size = await evaluate(`({ w: innerWidth, h: innerHeight })`);
      return api.aim(x / size.w, y / size.h, opts);
    },
    /** A complete click: close, hold past the press debounce, open. */
    async pinch({ holdMs = 600 } = {}) {
      await evaluate(`window.__handSim.pinching = true`);
      await sleep(holdMs);
      await evaluate(`window.__handSim.pinching = false`);
      // The release edge, then the app's pixel transition, which swaps the view about 800ms
      // later. Checking sooner reports the old page and reads as a click that did nothing.
      await sleep(1300);
    },
    /** Make a fist instead — the other click posture. */
    async fist({ holdMs = 600 } = {}) {
      await evaluate(`window.__handSim.label = "Closed_Fist"`);
      await sleep(holdMs);
      await evaluate(`window.__handSim.label = "None"`);
      await sleep(1300); // release edge + the pixel transition, before the view actually swaps
    },
    /**
     * Scroll by leaning: hold, move away from the grab point, stay there, come back, release.
     * `dy` is how far the hand leans, in screen fractions; positive leans down.
     */
    async leanScroll(dy, { holdMs = 1500 } = {}) {
      const s = await evaluate(`window.__handState()`);
      const u = s.x;
      const v = s.y;
      await evaluate(`window.__handSim.pinching = true`);
      await sleep(500); // past the press debounce, so the grab is registered
      await evaluate(`window.__handSim.aim = { u: ${u}, v: ${Math.min(0.97, Math.max(0.03, v + dy))} }`);
      await sleep(holdMs);
      await evaluate(`window.__handSim.aim = { u: ${u}, v: ${v} }`);
      await sleep(250);
      await evaluate(`window.__handSim.pinching = false`);
      await sleep(350);
    },
    /** Take the hand out of shot entirely. */
    async handAway(ms = 2000) {
      await evaluate(`window.__handSim.present = false`);
      await sleep(ms);
    },
    async handBack(ms = 800) {
      await evaluate(`window.__handSim.present = true`);
      await sleep(ms);
    },
    async state() {
      return evaluate(`window.__handState()`);
    },
    async close() {
      sock.close();
      chrome.kill("SIGTERM");
      await sleep(300);
      await rm(profile, { recursive: true, force: true });
    },
  };
  return api;
}
