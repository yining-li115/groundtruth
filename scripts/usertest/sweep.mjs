#!/usr/bin/env node
/**
 * The whole site, driven by a hand that shakes.
 *
 * `home-board.mjs` asks whether the home page works. This asks the harder question of every
 * page: with a hand that sways, trembles and lurches as the fingers close — the hand a visitor
 * actually has — does a pinch land as a click, does it land on the thing that was aimed at,
 * and does anything happen when it does?
 *
 * Three failures are reported separately, because they feel completely different at the wall:
 *
 *   MISSED   the pinch never registered — nothing happened, no feedback, the visitor pinches
 *            again and eventually walks off ("I pointed at it and nothing happened")
 *   STRAYED  the click landed on something other than what was aimed at — the wobble carried
 *            the release off the target ("it opened the wrong one")
 *   INERT    the click landed on the intended control and the page did not change ("it took my
 *            click and did nothing with it")
 *
 * It also measures every control on every page against the hand's own wobble, because a target
 * smaller than the tremor is not a target — no amount of tuning downstream can fix it.
 *
 * Run with the dev server up:
 *   node scripts/usertest/sweep.mjs [--hand steady|typical|shaky|timid] [--camera none|near|far]
 */
import { openKiosk, sleep } from "./driver.mjs";
import {
  CAMERAS,
  HANDS,
  attemptDepth,
  installHuman,
  measureWobble,
  pinchClick,
  reachPx,
} from "./hand.mjs";

const BASE = process.env.KIOSK_URL ?? "http://localhost:5173";
const handArg = process.argv.includes("--hand")
  ? process.argv[process.argv.indexOf("--hand") + 1]
  : "typical";
const PROFILE = HANDS[handArg] ?? HANDS.typical;
const camArg = process.argv.includes("--camera")
  ? process.argv[process.argv.indexOf("--camera") + 1]
  : "near";
const CAMERA = CAMERAS[camArg] ?? CAMERAS.near;
/** How many controls to try per page. Keeps a full sweep to a few minutes. */
const SAMPLE = Number(process.env.SAMPLE ?? 6);

const rows = [];
let attempt = 0;
/** One pinch, as this hand and this camera would deliver it. */
const tryPinch = (k) =>
  pinchClick(k, { depth: attemptDepth(PROFILE, CAMERA, attempt++), lurch: PROFILE.pinchLurch });
const log = (...a) => console.log(...a);

/** Everything the pointer treats as a control (the same selector `HandControl` hovers). */
const HOVERABLE = '[data-hover], button, a, [role="button"], input, label';

/** A stable, readable name for an element. */
const DESCRIBE = `(el) => {
  if (!el) return 'none';
  // Pointer state classes are stripped: the pointer ADDS 'gt-hover'/'is-hover' to whatever it
  // is over, so a name built from the first class changes the moment the hand arrives, and a
  // control compared before and after the reach looks like a different element.
  const stable = typeof el.className === 'string'
    ? el.className.trim().split(/\\s+/).filter((c) => !/^(gt-hover|is-hover|is-active|is-on)$/.test(c))
    : [];
  const cls = stable.length ? '.' + stable[0] : '';
  const txt = (el.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 24);
  return el.tagName.toLowerCase() + cls + (txt ? ' "' + txt + '"' : '');
}`;

/** A cheap signature of what the page is showing, to tell "something happened" from "nothing". */
const SIGNATURE = `(() => {
  const t = (document.body.innerText || '').replace(/\\s+/g, ' ');
  return t.length + '|' + t.slice(0, 120) + '|' + Math.round(scrollY);
})()`;

async function goto(k, url, ms = 3800) {
  await k.evaluate(`location.href = ${JSON.stringify(url)}`);
  await sleep(ms);
  await installHuman(k, PROFILE, CAMERA);
  // Record what a click actually reaches, in the capture phase, before any handler runs.
  await k.evaluate(`(() => {
    window.__lastClick = null;
    if (!window.__clickTap) {
      window.__clickTap = true;
      document.addEventListener('click', (e) => {
        const d = ${DESCRIBE};
        window.__lastClick = { at: performance.now(), what: d(e.target), path: (() => {
          const p = []; let n = e.target;
          while (n && n !== document.body && p.length < 6) { p.push(d(n)); n = n.parentElement; }
          return p;
        })() };
      }, true);
    }
  })()`);
}

/** Visible controls on this page, with their boxes, largest first. */
async function controls(k) {
  return k.evaluate(`(() => {
    const d = ${DESCRIBE};
    return [...document.querySelectorAll('${HOVERABLE}')]
      .map((el) => { const b = el.getBoundingClientRect(); return { el, b }; })
      .filter(({ b }) => b.width > 4 && b.height > 4 &&
        b.top < innerHeight - 4 && b.bottom > 4 && b.left < innerWidth - 4 && b.right > 4)
      .map(({ el, b }, i) => ({
        i, what: d(el), x: b.x + b.width / 2, y: b.y + b.height / 2,
        w: Math.round(b.width), h: Math.round(b.height),
      }));
  })()`);
}

async function main() {
  const k = await openKiosk({ url: `${BASE}/?enter=1`, width: 1600, height: 900 });
  try {
    await installHuman(k, PROFILE, CAMERA);
    await reachPx(k, 800, 450);
    const wob = await measureWobble(k, 1500);
    const wobblePx = { x: wob.spanX * 1600, y: wob.spanY * 900 };
    log(
      `\nhand: ${handArg} · camera: ${camArg} — holding still, the cursor wanders ` +
        `${(wob.spanX * 100).toFixed(2)}% × ${(wob.spanY * 100).toFixed(2)}% of the screen ` +
        `(${wobblePx.x.toFixed(0)}×${wobblePx.y.toFixed(0)} px at this size)\n`,
    );

    const PAGES = [
      { view: "home", url: `${BASE}/?enter=1` },
      { view: "people", url: `${BASE}/?enter=1&view=people` },
      { view: "research", url: `${BASE}/?enter=1&view=research` },
      { view: "projects", url: `${BASE}/?enter=1&view=projects` },
      { view: "publications", url: `${BASE}/?enter=1&view=publications` },
      { view: "teaching", url: `${BASE}/?enter=1&view=teaching` },
    ];

    for (const page of PAGES) {
      await goto(k, page.url);
      const all = await controls(k);
      // A control must be bigger than the hand's own wobble to be aimable at all.
      const tiny = all.filter((c) => c.w < wobblePx.x * 1.5 || c.h < wobblePx.y * 1.5);
      log(`${page.view}: ${all.length} controls on screen, ${tiny.length} smaller than the wobble`);
      if (tiny.length) {
        const worst = [...tiny].sort((a, b) => a.w * a.h - b.w * b.h).slice(0, 4);
        worst.forEach((c) => log(`    small: ${c.w}×${c.h}px  ${c.what}`));
        rows.push({ page: page.view, kind: "SMALL", n: tiny.length, detail: worst[0].what });
      }

      // Spread the sample across the page rather than taking the first N of one list.
      const step = Math.max(1, Math.floor(all.length / SAMPLE));
      const picked = all.filter((_, i) => i % step === 0).slice(0, SAMPLE);

      for (const c of picked) {
        await goto(k, page.url);
        const before = await k.evaluate(SIGNATURE);
        await reachPx(k, c.x, c.y);
        // What is under the cursor at the moment of the pinch — the wobble may already have
        // carried it off the control before a finger moved.
        const aimed = await k.evaluate(`(() => {
          const s = window.__handState();
          const d = ${DESCRIBE};
          return d(document.elementFromPoint(s.x * innerWidth, s.y * innerHeight));
        })()`);
        await tryPinch(k);
        const after = await k.evaluate(SIGNATURE);
        const click = await k.evaluate(`window.__lastClick`);

        const landed = click?.path?.some((p) => p === c.what) ?? false;
        if (!click) {
          log(`  MISSED  ${c.what} (${c.w}×${c.h}) — the pinch produced no click at all`);
          rows.push({ page: page.view, kind: "MISSED", detail: c.what });
        } else if (!landed) {
          log(`  STRAYED ${c.what} → hit ${click.what} (aimed at ${aimed})`);
          rows.push({ page: page.view, kind: "STRAYED", detail: `${c.what} → ${click.what}` });
        } else if (after === before) {
          log(`  INERT   ${c.what} — clicked, page unchanged`);
          rows.push({ page: page.view, kind: "INERT", detail: c.what });
        } else {
          log(`  ok      ${c.what}`);
        }
      }
    }

    // ---------------------------------------------------------------- detail pages
    // The deepest screens, where a visitor is most stuck if a control fails: open a few and
    // check that the way back out works with the same shaking hand.
    for (const view of ["projects", "publications", "people"]) {
      await goto(k, `${BASE}/?enter=1&view=${view}`);
      const list = (await controls(k)).filter((c) => c.w > 60 && c.h > 24);
      const openers = list.slice(0, 3);
      for (const o of openers) {
        await goto(k, `${BASE}/?enter=1&view=${view}`);
        const before = await k.evaluate(SIGNATURE);
        await reachPx(k, o.x, o.y);
        await k.evaluate(`window.__lastClick = null`);
        await tryPinch(k);
        const after = await k.evaluate(SIGNATURE);
        // A pinch this camera never read is not evidence about the control. Retry once, then
        // give up on this opener rather than blaming it.
        if (!(await k.evaluate(`!!window.__lastClick`))) {
          await tryPinch(k);
          if (!(await k.evaluate(`!!window.__lastClick`))) continue;
        }
        if ((await k.evaluate(SIGNATURE)) === before) continue; // not an opener, skip quietly
        // Some of these "openers" are the brand block, which navigates home. That is a way
        // out, not a trap.
        if (await k.evaluate(`!!document.querySelector('.hb')`)) {
          log(`  ok      ${view}: ${o.what} goes home`);
          continue;
        }
        const inDetail = await controls(k);
        const backs = inDetail.filter((c) => /back|close|home|←|✕|×/i.test(c.what));
        if (!backs.length) {
          log(`  TRAPPED ${view}: ${o.what} opened something with no way back`);
          rows.push({ page: `${view}/detail`, kind: "TRAPPED", detail: o.what });
          continue;
        }
        const b = backs[0];
        await reachPx(k, b.x, b.y);
        await k.evaluate(`window.__lastClick = null`);
        await tryPinch(k);
        if (!(await k.evaluate(`!!window.__lastClick`))) await tryPinch(k); // the camera, not the button
        const out = await k.evaluate(SIGNATURE);
        if (!(await k.evaluate(`!!window.__lastClick`))) {
          log(`  MISSED  ${view}: two pinches on '${b.what}' were never read`);
          rows.push({ page: `${view}/detail`, kind: "MISSED", detail: b.what });
        } else if (out === after) {
          log(`  STUCK   ${view}: '${b.what}' did not close the detail`);
          rows.push({ page: `${view}/detail`, kind: "STUCK", detail: b.what });
        } else {
          log(`  ok      ${view}: detail from ${o.what} opens and closes`);
        }
      }
    }

    // ---------------------------------------------------------------- repeatability
    // The complaint this whole harness exists for: "I pinch and sometimes nothing happens."
    // Ten pinches at the same big target, counted.
    await goto(k, `${BASE}/?enter=1`);
    const target = (await controls(k))[1];
    const TRIES = 12;
    let pinchHits = 0;
    let silent = 0;
    for (let i = 0; i < TRIES; i += 1) {
      await goto(k, `${BASE}/?enter=1`);
      await reachPx(k, target.x, target.y);
      await k.evaluate(`window.__lastClick = null`);
      // Watch the cursor for ANY acknowledgement while the fingers close — a pinch that fails
      // silently is a different (and worse) failure from one that visibly did not take.
      await k.evaluate(`(() => {
        window.__ack = 0;
        const el = document.querySelector('.gt-hand');
        const watch = () => {
          if (!el) return;
          const d = el.dataset;
          const len = parseFloat((document.querySelector('.gt-hand__dwell')?.style.strokeDasharray || '0').split(' ')[0]) || 0;
          if (d.pinched === 'true' || d.dwelling === 'true' || len > 1) window.__ack = Math.max(window.__ack, len || 1);
          window.__ackRaf = requestAnimationFrame(watch);
        };
        watch();
      })()`);
      await tryPinch(k);
      const hit = await k.evaluate(`!!window.__lastClick`);
      const ack = await k.evaluate(`(cancelAnimationFrame(window.__ackRaf), window.__ack)`);
      if (hit) pinchHits += 1;
      else if (!ack) silent += 1;
    }
    // The other posture, on the same target. The fist is a whole-hand shape rather than two
    // fingertips, so the camera reads it where it cannot read a pinch — this is the number
    // that decides which gesture the wall should ask for.
    let fistHits = 0;
    for (let i = 0; i < TRIES; i += 1) {
      await goto(k, `${BASE}/?enter=1`);
      await reachPx(k, target.x, target.y);
      await k.evaluate(`window.__lastClick = null`);
      await k.fist({ holdMs: 500 });
      if (await k.evaluate(`!!window.__lastClick`)) fistHits += 1;
    }
    log(`\nrepeatability on '${target.what}':`);
    log(`    pinch ${pinchHits}/${TRIES}   fist ${fistHits}/${TRIES}`);
    log(
      `    of the ${TRIES - pinchHits} pinches that did not click, ${silent} gave the visitor ` +
        `no feedback at all`,
    );
    if (silent) rows.push({ page: "cursor", kind: "SILENT", n: silent, detail: "no feedback" });
    if (pinchHits < TRIES)
      rows.push({ page: "home", kind: "MISSED", n: TRIES - pinchHits, detail: "pinch repeat" });

    // ---------------------------------------------------------------- phantoms
    // The other half of "I don't know what happened": a click nobody asked for. A noisy
    // aperture can cross the threshold on its own, so the hand is parked on a live control,
    // open, and left there.
    await goto(k, `${BASE}/?enter=1`);
    const park = (await controls(k))[2];
    await reachPx(k, park.x, park.y);
    await k.evaluate(`window.__lastClick = null`);
    await sleep(8000);
    const phantom = await k.evaluate(`window.__lastClick`);
    if (phantom) {
      log(`\nPHANTOM: an open hand parked on '${park.what}' clicked it by itself`);
      rows.push({ page: "home", kind: "PHANTOM", detail: park.what });
    } else {
      log(`\nphantoms: an open hand parked on a live control for 8s fired nothing`);
    }

    // ---------------------------------------------------------------- report
    log("");
    if (k.problems.length) {
      log(`console errors (${k.problems.length}):`);
      k.problems.slice(0, 6).forEach((p) => log(`    ${p}`));
      rows.push({ page: "-", kind: "CONSOLE", n: k.problems.length, detail: k.problems[0] });
    }
    const by = (kind) => rows.filter((r) => r.kind === kind).length;
    log(
      `summary — missed ${by("MISSED")} (camera, not the page) · strayed ${by("STRAYED")} · ` +
        `inert ${by("INERT")} · trapped ${by("TRAPPED")} · stuck ${by("STUCK")} · ` +
        `silent ${by("SILENT")} · phantom ${by("PHANTOM")} · ` +
        `pages with sub-wobble controls ${by("SMALL")}`,
    );
    process.exitCode = rows.some((r) =>
      ["STRAYED", "TRAPPED", "STUCK", "PHANTOM", "SILENT"].includes(r.kind),
    )
      ? 1
      : 0;
  } finally {
    await k.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
