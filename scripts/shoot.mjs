#!/usr/bin/env node
/**
 * Screenshot a local page from a throwaway Chrome.
 *
 * Two things this is careful about. It launches its own instance against a temporary
 * --user-data-dir and kills only that process by pid, so a browser the user has open — with
 * their tabs in it — is never touched. And it drives the page over the DevTools protocol
 * rather than using --screenshot, because that flag races a WebGL render loop: it either
 * captures the first blank frame or hangs waiting for a page that never goes idle.
 *
 * Usage: shoot.mjs <url> <out.png> [waitMs] [scrollY]
 */
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const [url, out, waitArg, scrollArg, sizeArg] = process.argv.slice(2);
if (!url || !out) throw new Error("usage: shoot.mjs <url> <out.png> [waitMs] [scrollY]");
const waitMs = Number(waitArg ?? 9000);
const scrollY = Number(scrollArg ?? 0);
// A layout that only holds at one window size is not a layout. `1920x1080` etc.
const size = (sizeArg ?? "1600,900").replace("x", ",");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const profile = await mkdtemp(join(tmpdir(), "shoot-"));
  const port = 9200 + Math.floor(Math.random() * 500);
  const chrome = spawn(
    CHROME,
    [
      "--headless=new",
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profile}`,
      `--window-size=${size}`,
      "--hide-scrollbars",
      "--no-first-run",
      "--enable-unsafe-swiftshader",
      // A synthetic camera, so the kiosk's hand control starts instead of rendering its
      // "camera unavailable" state over whatever is being photographed.
      "--use-fake-ui-for-media-stream",
      "--use-fake-device-for-media-stream",
      "about:blank",
    ],
    { stdio: "ignore", detached: false },
  );

  try {
    // wait for the debug endpoint
    let ws = null;
    for (let i = 0; i < 60 && !ws; i += 1) {
      await sleep(250);
      try {
        const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
        ws = list.find((t) => t.type === "page")?.webSocketDebuggerUrl ?? null;
      } catch {
        /* not up yet */
      }
    }
    if (!ws) throw new Error("chrome debug endpoint never came up");

    const sock = new WebSocket(ws);
    await new Promise((res, rej) => {
      sock.onopen = res;
      sock.onerror = () => rej(new Error("debug socket failed"));
    });

    let id = 0;
    const pending = new Map();
    sock.onmessage = (m) => {
      const msg = JSON.parse(m.data);
      if (msg.id && pending.has(msg.id)) {
        pending.get(msg.id)(msg.result);
        pending.delete(msg.id);
      }
    };
    const send = (method, params = {}) =>
      new Promise((res) => {
        const n = ++id;
        pending.set(n, res);
        sock.send(JSON.stringify({ id: n, method, params }));
      });

    await send("Page.enable");
    await send("Page.navigate", { url });
    await sleep(waitMs); // let the scene load and the loop settle
    if (scrollY) {
      await send("Runtime.evaluate", { expression: `window.scrollTo(0, ${scrollY})` });
      await sleep(2500); // the scroll is smoothed, so give it time to arrive
    }
    const shot = await send("Page.captureScreenshot", { format: "png" });
    await writeFile(out, Buffer.from(shot.data, "base64"));
    console.log(`shot ${out}`);
    sock.close();
  } finally {
    chrome.kill("SIGTERM"); // this pid only — never a broad pkill
    await sleep(300);
    await rm(profile, { recursive: true, force: true });
  }
}

main().catch((e) => {
  console.error("shoot:", e.message);
  process.exit(1);
});
