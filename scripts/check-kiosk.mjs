#!/usr/bin/env node
/**
 * End-to-end check of the kiosk, in a real browser (`npm run check:kiosk`).
 *
 * The synthetic harness (`check:pointer`) proves the pointing state machine behaves. It says
 * nothing about whether the page it drives actually works — whether the camera pipeline
 * starts, whether the views render, whether the things a hand has to hit are on screen and
 * reachable. That needs a browser, and doing it by hand means standing up, waving at a
 * screen, and still not knowing which of the six views quietly threw.
 *
 * So Chrome runs headless with a FAKE camera (`--use-fake-device-for-media-stream`), which
 * makes `getUserMedia` resolve and the whole vision pipeline load and run against a synthetic
 * stream. No hands appear in a test pattern, so this cannot test tracking — it tests
 * everything around it: that nothing throws, that every view renders its controls, and that
 * navigation driven by real clicks lands where it should.
 *
 * As with the screenshot tool, Chrome is launched against a throwaway profile and killed by
 * pid, so a browser the user has open with their own tabs is never touched.
 */
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const BASE = process.argv[2] ?? "http://localhost:5173";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
let checks = 0;
function ok(label, cond, detail = "") {
  checks += 1;
  if (cond) console.log(`  ✓ ${label}`);
  else {
    failures += 1;
    console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

/** Console messages we expect and do not want counted as failures. */
const BENIGN = [
  /Feedback manager requires a model/i,
  /Using NORM_RECT without IMAGE_DIMENSIONS/i,
  /XNNPACK/i,
  /TensorFlow Lite/i,
  /GPU delegate/i,
  /Download the React DevTools/i,
  /WebGL.*deprecated/i,
];

async function main() {
  const profile = await mkdtemp(join(tmpdir(), "kioskcheck-"));
  const port = 9300 + Math.floor(Math.random() * 400);
  const chrome = spawn(
    CHROME,
    [
      "--headless=new",
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profile}`,
      "--window-size=1600,900",
      "--hide-scrollbars",
      "--no-first-run",
      "--enable-unsafe-swiftshader",
      // The camera. Without these the kiosk has no input at all and every check below is
      // really a check of the permission prompt.
      "--use-fake-ui-for-media-stream",
      "--use-fake-device-for-media-stream",
      "--autoplay-policy=no-user-gesture-required",
      "about:blank",
    ],
    { stdio: "ignore" },
  );

  try {
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
        if (!BENIGN.some((re) => re.test(text))) problems.push(`console.error: ${text}`);
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
      if (r?.exceptionDetails) {
        return { error: r.exceptionDetails.exception?.description ?? "threw" };
      }
      return r?.result?.value;
    };

    await send("Page.enable");
    await send("Runtime.enable");

    const goto = async (url, waitMs = 6000) => {
      problems.length = 0;
      await send("Page.navigate", { url });
      await sleep(waitMs);
    };

    // ---------------------------------------------------------------- showreel
    console.log("\nshowreel (the idle screen, and the way in)\n");
    await goto(`${BASE}/?calibrate=0`, 9000);

    ok(
      "the camera actually started",
      (await evaluate(`!!document.querySelector('video.gt-hand-cam')?.srcObject`)) === true,
    );
    ok(
      "the vision models loaded without an error banner",
      (await evaluate(`!document.querySelector('.gt-hand-error')`)) === true,
      await evaluate(`document.querySelector('.gt-hand-error')?.textContent ?? ''`),
    );
    ok(
      "the standing invitation is shown while nobody is there",
      (await evaluate(`!!document.querySelector('.sf-invite')`)) === true,
    );
    ok(
      "the way in exists but is not offered to nobody",
      (await evaluate(
        `(() => { const e = document.querySelector('.sf-enter');
           return !!e && !e.classList.contains('is-on'); })()`,
      )) === true,
    );
    ok("no page errors on the idle screen", problems.length === 0, problems[0]);

    // Entering is a real click on the real button, the same call the hand pointer makes.
    await evaluate(`document.querySelector('.sf-enter__btn').click()`);
    await sleep(2500);
    ok(
      "clicking it enters the site",
      (await evaluate(`!!document.querySelector('[data-kiosk-menu], .bc-home, main')`)) === true,
    );

    // ---------------------------------------------------------------- home
    console.log("\nthe home page carries the whole menu\n");
    await goto(`${BASE}/?enter=1&calibrate=0`, 5000);

    // The five colour columns became the dark board's five rows (`scenes/HomeBoard`); the
    // property being checked is unchanged — every destination stands on the home page, at a
    // size a hand can hit, and clicking one opens it.
    const rows = await evaluate(`document.querySelectorAll('.hb-row').length`);
    ok("every section stands on the home page", rows === 5, `${rows} rows`);

    const shortest = await evaluate(
      `(() => {
         const h = [...document.querySelectorAll('.hb-row')]
           .map((c) => Math.round(c.getBoundingClientRect().height));
         return Math.min(...h);
       })()`,
    );
    // These are the primary targets of the whole kiosk, aimed at by a hand from metres away.
    // Full column width already, so height is the only dimension that can be got wrong.
    ok(`the shortest row is still a big target (${shortest}px)`, shortest >= 100, `${shortest}px`);

    ok(
      "the home does not also carry a menu toggle (it would be a door into this room)",
      (await evaluate(`!document.querySelector('.hb .sm-toggle')`)) === true,
    );
    ok("no page errors on the home", problems.length === 0, problems[0]);

    // A real click on a real row, the same call the hand pointer makes.
    await evaluate(`document.querySelectorAll('.hb-row')[4].click()`);
    await sleep(2500);
    ok(
      "clicking a row opens that section",
      (await evaluate(`!!document.querySelector('.bc-home')`)) === true,
    );

    // ---------------------------------------------------------------- sections
    console.log("\nevery section renders, and can be left again\n");
    for (const view of ["people", "research", "projects", "publications", "teaching"]) {
      await goto(`${BASE}/?view=${view}&calibrate=0`, 5000);
      // The site shell only shows once someone has come in; deep links start at the showreel.
      await evaluate(`document.querySelector('.sf-enter__btn')?.click()`);
      await sleep(2000);

      const back = await evaluate(`!!document.querySelector('.bc-home')`);
      // Not "has an h1": the sections were built with different layouts and some title
      // themselves in other ways. What matters is that real content arrived.
      const chars = await evaluate(`(document.body.innerText ?? '').trim().length`);
      ok(`${view}: renders content`, typeof chars === "number" && chars > 200, `${chars} chars`);
      ok(`${view}: has a reachable way back`, back === true);
      ok(`${view}: no page errors`, problems.length === 0, problems[0]);

      // The Home control must be present AND actually clickable. "Is it in the DOM" would
      // not have caught either of the two overlaps found here: a debug button pinned to the
      // same corner, and a section's own filter bar running straight through it.
      //
      // It is now a clipped quarter-ellipse rather than a pill, so this probes the centre of
      // its bounding box — which is inside the clip (0.5² + 0.5² < 1) and therefore a point
      // `elementFromPoint` will only return if nothing is painted over it.
      const reachable = await evaluate(
        `(() => {
           const b = document.querySelector('.bc-home');
           if (!b) return 'missing';
           const r = b.getBoundingClientRect();
           const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
           return b.contains(hit) || hit === b ? 'ok' : 'covered by ' + (hit?.className || hit?.tagName);
         })()`,
      );
      ok(`${view}: the Home button is not covered by anything`, reachable === "ok", String(reachable));
      ok(
        `${view}: no leftover MENU toggle`,
        (await evaluate(`!document.querySelector('.sm-toggle')`)) === true,
      );

      if (back) {
        const size = await evaluate(
          `(() => { const r = document.querySelector('.bc-home').getBoundingClientRect();
             return Math.round(Math.min(r.width, r.height)); })()`,
        );
        // Apple's floor for a target aimed by eye is 60pt; a hand from metres away is no more
        // precise. The corner region is far past that — this is the floor, not the target, and
        // it exists so that shrinking it back to a button would fail loudly.
        ok(`${view}: the way back is big enough to hit (${size}px)`, size >= 44, `${size}px`);
      }
    }

    // ------------------------------------------------- the corner glow follows the page
    //
    // The Home corner is white on the dark sections and brand violet on the light ones, and it
    // used to decide that once, from the section root, when `view` changed. A DETAIL view can
    // be a different theme from the section that owns it and does not change `view` at all —
    // opening a person swapped the page to a dark profile while the glow stayed violet.
    console.log("\nthe Home corner is painted against the page it is on\n");
    {
      await goto(`${BASE}/?view=people&calibrate=0`, 5000);
      await evaluate(`document.querySelector('.sf-enter__btn')?.click()`);
      await sleep(2000);
      const onList = await evaluate(`document.querySelector('.bc-home')?.className ?? 'missing'`);
      ok("people (light) gets the violet glow", String(onList).includes("bc-home--light"), String(onList));

      const opened = await evaluate(`(() => {
        const card = document.querySelector('.ppl-card');
        if (!card) return 'no card';
        card.click();
        return 'clicked';
      })()`);
      await sleep(1200);
      const onDetail = await evaluate(`document.querySelector('.bc-home')?.className ?? 'missing'`);
      ok(
        "...and a person's dark detail flips it to white",
        opened === "clicked" && String(onDetail).includes("bc-home--dark"),
        `${opened} → ${onDetail}`,
      );
    }

    // -------------------------------------------- detail-page previous / next wings
    //
    // These are not arrow-sized controls: the hand is allowed to land anywhere in the light
    // bleeding in from the relevant edge. Keep the geometry and the hit-testing honest on both
    // consumers of the shared DetailPager. In particular, enlarging the left wing must not
    // steal the Home corner, and enlarging either wing must not steal a fist-scroll begun in
    // the middle of the article.
    console.log("\ndetail-page arrows have hand-sized hit regions with safe ownership\n");
    for (const view of ["projects", "publications"]) {
      await goto(`${BASE}/?view=${view}&enter=1&calibrate=0`, 4000);
      const opened = await evaluate(`(() => {
        const item = document.querySelectorAll('.menu__item')[1];
        if (!item) return false;
        item.click();
        return true;
      })()`);
      await sleep(800);

      const geometry = await evaluate(`(() => {
        const prev = document.querySelector('.dp-wing--prev');
        const next = document.querySelector('.dp-wing--next');
        if (!prev || !next) return { error: 'missing wings' };
        const pr = prev.getBoundingClientRect();
        const nr = next.getBoundingClientRect();
        const owns = (selector, x, y) =>
          !!document.elementFromPoint(x, y)?.closest(selector);
        return {
          count: document.querySelectorAll('.dp-wing').length,
          widthRatio: Math.min(pr.width, nr.width) / innerWidth,
          heightRatio: Math.min(pr.height, nr.height) / innerHeight,
          prevInnerEdge: owns('.dp-wing--prev', pr.left + pr.width * 0.86, pr.top + pr.height / 2),
          prevUpperEdge: owns('.dp-wing--prev', pr.left + pr.width * 0.25, pr.top + pr.height * 0.12),
          nextInnerEdge: owns('.dp-wing--next', nr.right - nr.width * 0.86, nr.top + nr.height / 2),
          nextUpperEdge: owns('.dp-wing--next', nr.right - nr.width * 0.25, nr.top + nr.height * 0.12),
          centreFree: !owns('.dp-wing', innerWidth / 2, innerHeight * 0.37),
          homeWins: owns('.bc-home', 2, innerHeight * 0.63),
        };
      })()`);

      ok(`${view}: a detail opens for pager checks`, opened === true && !geometry?.error,
        String(geometry?.error ?? opened));
      ok(
        `${view}: pager is at least 21.5vw × 53vh`,
        geometry?.count === 2 && geometry.widthRatio >= 0.215 && geometry.heightRatio >= 0.53,
        `${Math.round((geometry?.widthRatio ?? 0) * 1000) / 10}vw × ` +
          `${Math.round((geometry?.heightRatio ?? 0) * 1000) / 10}vh`,
      );
      ok(
        `${view}: the enlarged visible wings are actually hittable to their edges`,
        geometry?.prevInnerEdge === true && geometry.prevUpperEdge === true &&
          geometry.nextInnerEdge === true && geometry.nextUpperEdge === true,
        JSON.stringify(geometry),
      );
      ok(
        `${view}: pager leaves article scrolling and Home ownership intact`,
        geometry?.centreFree === true && geometry.homeWins === true,
        JSON.stringify(geometry),
      );
    }

    // ---------------------------------------------------------------- scrolling
    console.log("\nthe pages can actually be scrolled by a drag\n");
    await goto(`${BASE}/?view=people&calibrate=0`, 5000);
    await evaluate(`document.querySelector('.sf-enter__btn')?.click()`);
    await sleep(2000);
    const scrollable = await evaluate(
      `document.documentElement.scrollHeight > window.innerHeight + 50`,
    );
    ok("a section is taller than the screen (so scrolling matters)", scrollable === true);
    const moved = await evaluate(
      `(async () => { const y0 = window.scrollY; window.scrollTo(0, 600);
         await new Promise(r => setTimeout(r, 1200)); return window.scrollY - y0; })()`,
    );
    ok("scrolling moves the page", typeof moved === "number" && moved > 100, `moved ${moved}px`);

    // ---------------------------------------------------------------- scrollable
    console.log("\nevery section has something the drag can actually scroll\n");
    for (const view of ["people", "research", "projects", "publications", "teaching"]) {
      await goto(`${BASE}/?view=${view}&enter=1&calibrate=0`, 4500);
      // A section has to be navigable by hand SOMEHOW: either the document scrolls, or
      // something under the cursor does, or it is browsed by controls (the research slider has
      // prev/next buttons). What must never happen is the case this check was written for —
      // a fixed full-screen layout whose only scroller is an inner container the gesture was
      // not addressing, where dragging silently did nothing at all.
      const target = await evaluate(
        `(() => {
           if (document.documentElement.scrollHeight > window.innerHeight + 50) return 'page';
           let el = document.elementFromPoint(window.innerWidth / 2, window.innerHeight / 2);
           while (el && el !== document.body) {
             const oy = getComputedStyle(el).overflowY;
             if (/(auto|scroll|overlay)/.test(oy) && el.scrollHeight > el.clientHeight + 2) {
               return 'element:' + (el.className || el.tagName);
             }
             el = el.parentElement;
           }
           if (document.querySelector('.rsl-button, [aria-label*="ext"]')) return 'controls';
           // Nothing to scroll is fine only if there is nothing being HIDDEN. Content that
           // overflows a clipped box is content a visitor can never reach by any gesture,
           // which is a worse bug than a scroll that does not work — at least that one is
           // visible.
           const clipped = [...document.querySelectorAll('*')].find((n) => {
             const st = getComputedStyle(n);
             return (
               st.overflow === 'hidden' &&
               n.scrollHeight > n.clientHeight + 40 &&
               n.clientHeight > window.innerHeight * 0.4
             );
           });
           if (clipped) return 'CLIPPED:' + (clipped.className || clipped.tagName);
           return 'fits';
         })()`,
      );
      ok(
        `${view}: navigable by hand (${target})`,
        typeof target === "string" && !target.startsWith("CLIPPED") && target !== "none",
        String(target),
      );
    }

    // ---------------------------------------------------------------- experiments
    console.log("\nthe tuning pages still work\n");
    for (const exp of ["handlab", "pointer"]) {
      await goto(`${BASE}/?exp=${exp}&calibrate=0`, 7000);
      ok(`/?exp=${exp}: renders`, (await evaluate(`document.body.children.length > 0`)) === true);
      ok(`/?exp=${exp}: no page errors`, problems.length === 0, problems[0]);
    }

    sock.close();
  } finally {
    chrome.kill("SIGTERM"); // this pid only — never a broad pkill
    await sleep(300);
    await rm(profile, { recursive: true, force: true });
  }

  console.log(`\n${checks - failures}/${checks} passed\n`);
  if (failures) process.exit(1);
}

main().catch((e) => {
  console.error("check-kiosk:", e.message);
  process.exit(1);
});
