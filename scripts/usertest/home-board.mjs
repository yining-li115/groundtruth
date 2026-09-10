#!/usr/bin/env node
/**
 * User test: the home board, driven by a synthetic hand.
 *
 * The home page is the one screen every visitor meets, and the only one where a failure is
 * fatal — if a row cannot be hit, or a pinch lands on the wrong one, the wall is a poster.
 * So this drives the REAL page (the app shell, `?enter=1`) through the real pointer: the
 * thresholds, the press debounce, the 1€ filter, the hover marking and the pixel transition
 * all run exactly as they ship. Only the camera is replaced.
 *
 * What it asks:
 *   1. geometry     — are the rows as large as the design claims?
 *   2. coverage     — is EVERY point of a row live, including its corners and its arrow?
 *   3. activation   — does a pinch (and a fist) open the section the row names, and does
 *                     Back come home?
 *   4. inertness    — does anything on the left side navigate when pinched? (It must not.)
 *   5. boundaries   — does the same pixel report the same row from above and from below?
 *   6. persistence  — does losing the hand for a moment change what is selected?
 *
 * Run with the dev server up:  node scripts/usertest/home-board.mjs
 */
import { openKiosk, sleep } from "./driver.mjs";

const URL = process.env.KIOSK_URL ?? "http://localhost:5173/?enter=1&calibrate=0";
const ROWS = ["research", "people", "projects", "publications", "teaching"];

const findings = [];
const note = (level, what) => {
  findings.push({ level, what });
  console.log(`${level === "FAIL" ? "✗" : level === "WARN" ? "!" : "·"} ${what}`);
};

/** Which section the shell is showing, read off the DOM rather than trusted from the click. */
const VIEW = `(() => {
  if (document.querySelector('.hb')) return 'home';
  if (document.querySelector('.ppl')) return 'people';
  if (document.querySelector('.rsl')) return 'research';
  if (document.querySelector('.projects')) return 'projects';
  if (document.querySelector('.publications')) return 'publications';
  if (document.querySelector('.tch-row')) return 'teaching';
  return 'unknown';
})()`;

/** What is under a screen point, and which row (if any) owns it. */
const hitAt = (x, y) => `(() => {
  const el = document.elementFromPoint(${x}, ${y});
  if (!el) return { row: -1, tag: 'none' };
  const row = el.closest('.hb-row');
  const rows = [...document.querySelectorAll('.hb-row')];
  return {
    row: row ? rows.indexOf(row) : -1,
    tag: el.tagName.toLowerCase() + (el.className && typeof el.className === 'string' ? '.' + el.className.split(' ')[0] : ''),
  };
})()`;

/** Which row the POINTER thinks it is on, and which one is lit. */
const MARKED = `(() => {
  const rows = [...document.querySelectorAll('.hb-row')];
  return {
    hovered: rows.findIndex((r) => r.classList.contains('gt-hover')),
    active: rows.findIndex((r) => r.classList.contains('is-active')),
  };
})()`;

async function main() {
  const k = await openKiosk({ url: URL, width: 1600, height: 900 });
  try {
    const view0 = await k.evaluate(VIEW);
    if (view0 !== "home") throw new Error(`expected the home board, got '${view0}'`);

    const size = await k.evaluate(`({ w: innerWidth, h: innerHeight })`);

    // ---------------------------------------------------------------- 1. geometry
    const geo = await k.evaluate(`(() => {
      const rows = [...document.querySelectorAll('.hb-row')].map((r) => {
        const b = r.getBoundingClientRect();
        return { x: b.x, y: b.y, w: b.width, h: b.height };
      });
      const card = document.querySelector('.hb-menu__card').getBoundingClientRect();
      const col = document.querySelector('.hb-menu').getBoundingClientRect();
      return { rows, card: { x: card.x, y: card.y, w: card.width, h: card.height },
               col: { x: col.x, w: col.width } };
    })()`);
    if (geo.rows.length !== 5) note("FAIL", `expected 5 rows, found ${geo.rows.length}`);
    const minH = Math.min(...geo.rows.map((r) => r.h));
    const minW = Math.min(...geo.rows.map((r) => r.w));
    note(
      "INFO",
      `rows: ${geo.rows.length} · smallest ${Math.round(minW)}×${Math.round(minH)}px ` +
        `(${((minH / size.h) * 100).toFixed(1)}% of screen height)`,
    );
    // A hand held up at 1.5 m wobbles by a couple of per cent of the screen; a target under
    // ~10% of screen height is one a visitor has to hold still for.
    if (minH / size.h < 0.1) note("FAIL", `rows are only ${(minH / size.h) * 100}% of height`);
    const deadLeft = geo.card.x - geo.col.x;
    const deadRight = geo.col.x + geo.col.w - (geo.card.x + geo.card.w);
    note(
      "INFO",
      `dead margin around the board: ${Math.round(deadLeft)}px left, ${Math.round(deadRight)}px right, ` +
        `${Math.round(geo.card.y)}px above, ${Math.round(size.h - (geo.card.y + geo.card.h))}px below`,
    );

    // ---------------------------------------------------------------- 2. coverage
    const XS = [0.04, 0.2, 0.5, 0.8, 0.96];
    const YS = [0.12, 0.5, 0.88];
    let probes = 0;
    const dead = [];
    const wrong = [];
    const unmarked = [];
    for (let i = 0; i < geo.rows.length; i += 1) {
      const r = geo.rows[i];
      for (const fx of XS) {
        for (const fy of YS) {
          const x = Math.round(r.x + r.w * fx);
          const y = Math.round(r.y + r.h * fy);
          const hit = await k.evaluate(hitAt(x, y));
          probes += 1;
          if (hit.row === -1) dead.push({ i, fx, fy, tag: hit.tag });
          else if (hit.row !== i) wrong.push({ i, fx, fy, got: hit.row });
          await k.aimPx(x, y);
          const m = await k.evaluate(MARKED);
          if (m.hovered !== i) unmarked.push({ i, fx, fy, hovered: m.hovered });
          else if (m.active !== i) unmarked.push({ i, fx, fy, active: m.active });
        }
      }
    }
    note("INFO", `coverage: ${probes} points probed across the five rows`);
    if (dead.length)
      note("FAIL", `${dead.length}/${probes} points hit nothing: ${JSON.stringify(dead.slice(0, 6))}`);
    if (wrong.length)
      note("FAIL", `${wrong.length}/${probes} points belong to the wrong row: ${JSON.stringify(wrong.slice(0, 6))}`);
    if (unmarked.length)
      note(
        "FAIL",
        `${unmarked.length}/${probes} points did not light their row: ${JSON.stringify(unmarked.slice(0, 6))}`,
      );
    if (!dead.length && !wrong.length && !unmarked.length)
      note("INFO", "every probed point is live, owned by its own row, and lights it");

    // ---------------------------------------------------------------- 5. boundaries
    /**
     * On a shared edge between two rows, which row lights is genuinely ambiguous — the cursor
     * sits on a one-pixel line and a hand wobbles by far more than that, so either answer is
     * honest. What must NEVER differ is the row that lights and the row a pinch would open:
     * that is the failure a visitor experiences as "I clicked the one that was highlighted and
     * got the other one". So the seam is approached from both sides and the two are compared
     * at the cursor's own sub-pixel position.
     */
    // Read AFTER the smoothing has stopped creeping and inside a frame the page has already
    // rendered — otherwise this compares the app's state from frame N with a hit test taken a
    // sub-pixel later, and reports the cursor's own settling as a disagreement.
    const AGREE = `new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(() => {
      const s = window.__handState();
      const px = s.x * innerWidth;
      const py = s.y * innerHeight;
      const rows = [...document.querySelectorAll('.hb-row')];
      const hit = document.elementFromPoint(px, py)?.closest('.hb-row');
      res({
        opens: hit ? rows.indexOf(hit) : -1,
        lit: rows.findIndex((r) => r.classList.contains('is-active')),
      });
    })))`;
    const mismatched = [];
    for (let i = 1; i < geo.rows.length; i += 1) {
      const y = Math.round(geo.rows[i].y); // the seam itself
      const x = Math.round(geo.rows[i].x + geo.rows[i].w * 0.35);
      for (const from of ["above", "below"]) {
        const off = Math.round(geo.rows[i].h * 0.4) * (from === "above" ? -1 : 1);
        await k.aimPx(x, y + off);
        await k.aimPx(x, y);
        await sleep(300); // let the 1€ filter stop creeping across the seam
        const a = await k.evaluate(AGREE);
        if (a.opens !== a.lit) mismatched.push({ seam: i, from, ...a });
      }
    }
    if (mismatched.length)
      note("FAIL", `on a seam the lit row is not the row that opens: ${JSON.stringify(mismatched)}`);
    else
      note(
        "INFO",
        `all ${geo.rows.length - 1} seams: the lit row is the row that opens, from either side`,
      );

    // ---------------------------------------------------------------- 3. activation
    for (let i = 0; i < ROWS.length; i += 1) {
      const r = geo.rows[i];
      await k.aimPx(Math.round(r.x + r.w * 0.5), Math.round(r.y + r.h * 0.5));
      await k.pinch();
      const got = await k.evaluate(VIEW);
      if (got !== ROWS[i]) {
        note("FAIL", `row ${i + 1} (${ROWS[i]}) opened '${got}'`);
      } else {
        note("INFO", `row ${i + 1} → ${ROWS[i]} ✓`);
      }
      // Back home, through the control every page carries.
      const back = await k.evaluate(`(() => {
        const b = document.querySelector('.bc-home');
        if (!b) return null;
        const r = b.getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
      })()`);
      if (!back) {
        note("FAIL", `no Back control on '${got}' — the visitor is stranded`);
        await k.evaluate(`location.href = ${JSON.stringify(URL)}`);
        await sleep(3500);
        continue;
      }
      await k.aimPx(back.x, back.y);
      await k.pinch();
      const home = await k.evaluate(VIEW);
      if (home !== "home") note("FAIL", `Back from ${ROWS[i]} landed on '${home}'`);
    }

    // The other click posture. Whichever one a visitor happens to make, the row must open —
    // the wall can be switched between them at run time (`?click=fist`), so both are tested.
    {
      const r = geo.rows[1];
      await k.aimPx(Math.round(r.x + r.w * 0.5), Math.round(r.y + r.h * 0.5));
      await k.fist();
      const got = await k.evaluate(VIEW);
      if (got !== ROWS[1]) note("FAIL", `a fist on row 2 opened '${got}'`);
      else note("INFO", `a fist opens a row too (row 2 → ${ROWS[1]})`);
      const back = await k.evaluate(`(() => {
        const b = document.querySelector('.bc-home');
        if (!b) return null;
        const r = b.getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
      })()`);
      if (back) {
        await k.aimPx(back.x, back.y);
        await k.pinch();
      }
      if ((await k.evaluate(VIEW)) !== "home") {
        await k.evaluate(`location.href = ${JSON.stringify(URL)}`);
        await sleep(3500);
      }
    }

    // ---------------------------------------------------------------- 4. inertness
    const spots = await k.evaluate(`(() => {
      const pick = (sel) => {
        const e = document.querySelector(sel);
        if (!e) return null;
        const r = e.getBoundingClientRect();
        return { sel, x: r.x + r.width / 2, y: r.y + r.height / 2 };
      };
      return [pick('.hb-headline'), pick('.hb-blurb'), pick('.hb-brand'), pick('.hb-shot')].filter(Boolean);
    })()`);
    for (const s of spots) {
      await k.aimPx(s.x, s.y);
      await k.pinch();
      const got = await k.evaluate(VIEW);
      if (got !== "home") {
        note("FAIL", `pinching ${s.sel} navigated to '${got}' — the left side must be inert`);
        await k.evaluate(`location.href = ${JSON.stringify(URL)}`);
        await sleep(3500);
      }
    }
    note("INFO", `left column: ${spots.length} spots pinched, none of them navigates`);

    // ---------------------------------------------------------------- 6. persistence
    const r2 = geo.rows[3];
    await k.aimPx(Math.round(r2.x + r2.w * 0.5), Math.round(r2.y + r2.h * 0.5));
    const before = await k.evaluate(MARKED);
    await k.handAway();
    const away = await k.evaluate(MARKED);
    const viewAway = await k.evaluate(VIEW);
    await k.handBack();
    if (viewAway !== "home") note("FAIL", `losing the hand navigated to '${viewAway}'`);
    if (away.active !== before.active)
      note("FAIL", `selection changed while the hand was gone: ${before.active} → ${away.active}`);
    else note("INFO", `selection survives the hand leaving (row ${away.active + 1} stays lit)`);

    // ---------------------------------------------------------------- console
    if (k.problems.length) {
      note("FAIL", `${k.problems.length} console errors`);
      k.problems.slice(0, 8).forEach((p) => console.log(`    ${p}`));
    } else {
      note("INFO", "no console errors or exceptions");
    }

    const fails = findings.filter((f) => f.level === "FAIL").length;
    console.log(`\n${fails ? `${fails} FAILURES` : "all checks passed"}`);
    process.exitCode = fails ? 1 : 0;
  } finally {
    await k.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
