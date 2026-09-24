#!/usr/bin/env node
/**
 * User test: the home board, driven by a synthetic hand.
 *
 * The home page is the one screen every visitor meets, and the only one where a failure is
 * fatal — if a row cannot be hit, or a fist lands on the wrong one, the wall is a poster.
 * So this drives the REAL page (the app shell, `?enter=1`) through the real pointer: the
 * thresholds, the press debounce, the 1€ filter, the hover marking and the pixel transition
 * all run exactly as they ship. Only the camera is replaced.
 *
 * What it asks:
 *   1. geometry     — are the rows as large as the design claims?
 *   2. coverage     — is EVERY point of a row live, including its corners and its arrow?
 *   3. activation   — does the production fist gesture open every section, and does its
 *                     labelled Home header return home?
 *   4. scrolling    — on a real reading page, does a held fist + upward lean move the page?
 *   5. inertness    — does anything on the left side navigate when closed on? (It must not.)
 *   6. boundaries   — does the same pixel report the same row from above and from below?
 *   7. persistence  — does losing the hand for a moment change what is selected?
 *
 * Run with the dev server up:  node scripts/usertest/home-board.mjs
 */
import { openKiosk, sleep } from "./driver.mjs";

/**
 * KIOSK_URL is a BASE, not a full address, and the query is appended here.
 *
 * It used to be the whole URL with the parameters baked into the default, which meant pointing
 * the run at a production preview (`KIOSK_URL=http://localhost:4173`) silently dropped
 * `enter=1` and `calibrate=0` — the run landed on the setup screen and reported the home board
 * missing. A harness that fails for a reason that has nothing to do with the thing under test
 * is worse than no harness.
 */
const BASE = (process.env.KIOSK_URL ?? "http://localhost:5173").replace(/\/+$/, "");
// The wall ships with fist as its click posture. Test that exact policy here; pinch recognition
// has its own deterministic fixtures, while this browser suite proves every production target
// can be used repeatedly with natural Closed_Fist -> None cycles.
const URL = `${BASE}/?enter=1&calibrate=0&click=fist`;
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

    // ---------------------------------------------------------------- 6. boundaries
    /**
     * On a shared edge between two rows, which row lights is genuinely ambiguous — the cursor
     * sits on a one-pixel line and a hand wobbles by far more than that, so either answer is
     * honest. What must NEVER differ is the row that lights and the row a fist would open:
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
      await k.fist();
      const got = await k.evaluate(VIEW);
      if (got !== ROWS[i]) {
        note("FAIL", `row ${i + 1} (${ROWS[i]}) opened '${got}'`);
      } else {
        note("INFO", `row ${i + 1} → ${ROWS[i]} ✓`);
      }

      // Teaching is ordinary document content: no fake button beneath the hand and no nested
      // carousel to absorb the gesture. It is therefore the cleanest production proof that a
      // close on content becomes a scroll, while the exact same close on a control above became
      // a click. Moving the hand upward follows the touch/direct-manipulation sign convention
      // and must move the document down.
      if (got === "teaching") {
        const probe = await k.evaluate(`(() => {
          const blocked = '[data-hover], button, a, [role="button"], input, label';
          const candidates = [
            { x: innerWidth * 0.56, y: innerHeight * 0.66 },
            { x: innerWidth * 0.68, y: innerHeight * 0.58 },
            { x: innerWidth * 0.46, y: innerHeight * 0.72 },
          ];
          const point = candidates.find(({ x, y }) => {
            const el = document.elementFromPoint(x, y);
            return el && !el.closest(blocked);
          });
          const root = document.documentElement;
          return point ? {
            ...point,
            before: window.scrollY,
            max: Math.max(0, root.scrollHeight - innerHeight),
          } : null;
        })()`);
        if (!probe) {
          note("FAIL", "Teaching has no inert content point for the scroll gesture");
        } else if (probe.max < 80) {
          note("FAIL", `Teaching has only ${Math.round(probe.max)}px of scroll range`);
        } else {
          await k.aimPx(probe.x, probe.y);
          await k.leanScroll(-0.2, { holdMs: 1100 });
          await sleep(250);
          const after = await k.evaluate(`window.scrollY`);
          if (after <= probe.before + 30) {
            note(
              "FAIL",
              `fist + upward lean did not scroll Teaching down (${Math.round(probe.before)} → ${Math.round(after)}px)`,
            );
          } else {
            note(
              "INFO",
              `fist + upward lean scrolls Teaching (${Math.round(probe.before)} → ${Math.round(after)}px)`,
            );
          }
        }
      }

      // Home through the labelled control in every section's reserved header.
      const homeControl = await k.evaluate(`(() => {
        const b = document.querySelector('[data-section-home]');
        if (!b) return null;
        if (${JSON.stringify(ROWS[i])} === 'teaching') {
          window.__teachingHomeClicks = 0;
          b.addEventListener('click', () => { window.__teachingHomeClicks += 1; }, true);
        }
        const r = b.getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
      })()`);
      if (!homeControl) {
        note("FAIL", `no Home header on '${got}' — the visitor is stranded`);
        await k.evaluate(`location.href = ${JSON.stringify(URL)}`);
        await sleep(3500);
        continue;
      }

      // The decisive click-vs-scroll case is a close begun ON a control while its page can
      // scroll. Closing Home must not activate it yet; moving the still-closed hand must turn
      // that same transaction into scroll, and opening must never resurrect the pending click.
      // This is exactly the grammar that an immediate-on-close implementation destroys.
      if (got === "teaching") {
        const beforeControlScroll = await k.evaluate(`window.scrollY`);
        await k.aimPx(homeControl.x, homeControl.y);
        const scrollGesture = await k.leanScroll(0.2, { holdMs: 900, blinkMs: 90 });
        await sleep(250);
        const afterControlScroll = await k.evaluate(`({
          y: window.scrollY,
          view: ${VIEW},
          clicks: window.__teachingHomeClicks ?? 0,
        })`);
        if (
          afterControlScroll?.view !== "teaching" ||
          afterControlScroll?.clicks !== 0 ||
          afterControlScroll?.y >= beforeControlScroll - 30
        ) {
          note(
            "FAIL",
            `a fist drag begun on Home did not remain a pure scroll: ${JSON.stringify({ before: beforeControlScroll, ...afterControlScroll })}`,
          );
        } else {
          note(
            "INFO",
            `Home stays pending while held, becomes scroll, and does not click on release (${Math.round(beforeControlScroll)} → ${Math.round(afterControlScroll.y)}px)`,
          );
        }
        if (
          scrollGesture?.blinkState?.pinched !== true ||
          typeof scrollGesture?.blinkState?.ownerId !== "number" ||
          scrollGesture?.blinkState?.ownerVisible !== false
        ) {
          note(
            "FAIL",
            `the active scroll did not survive its short tracking blink: ${JSON.stringify(scrollGesture?.blinkState)}`,
          );
        } else {
          note("INFO", "the held scroll survives a brief closed-fist tracking blink");
        }
      }

      await k.aimPx(homeControl.x, homeControl.y);
      await k.fist();
      const home = await k.evaluate(VIEW);
      if (home !== "home") note("FAIL", `Home from ${ROWS[i]} landed on '${home}'`);
      if (got === "teaching") {
        const homeClicks = await k.evaluate(`window.__teachingHomeClicks ?? 0`);
        if (homeClicks !== 1) {
          note("FAIL", `a stationary close→open on Home clicked ${homeClicks} times`);
        } else {
          note("INFO", "a stationary close→open on Home clicks exactly once");
        }
      }
    }

    // ---------------------------------------------------------------- 5. inertness
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
      await k.fist();
      const got = await k.evaluate(VIEW);
      if (got !== "home") {
        note("FAIL", `closing on ${s.sel} navigated to '${got}' — the left side must be inert`);
        await k.evaluate(`location.href = ${JSON.stringify(URL)}`);
        await sleep(3500);
      }
    }
    note("INFO", `left column: ${spots.length} spots closed on, none of them navigates`);

    // ---------------------------------------------------------------- 7. persistence
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
