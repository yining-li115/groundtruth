#!/usr/bin/env node
/**
 * Turn recorded vision runs into the numbers the audit asks for.
 *
 *   node scripts/vision-audit.mjs vision-pinch-2m-*.json vision-fist-2m-*.json …
 *   node scripts/vision-audit.mjs --fixture      # re-derive the findings from the 0.5m archive
 *
 * WHAT IT REPORTS, and why in this shape. The interesting quantities are CONDITIONAL, because
 * a pinch can fail at three unrelated places and the fix for each is a different kind of
 * thing. Reporting one blended "pinch success rate" hides exactly the distinction the whole
 * exercise exists to make:
 *
 *   Hand Recall                    — did the camera find a hand at all?     → optics/placement
 *   Pinch Recall | Hand Detected   — given a hand, was the posture read?    → the feature
 *   Press  Recall | Pinch Detected — given the posture, did policy allow it? → thresholds/debounce
 *   Click  Recall | Press          — given a press, did a click come out?    → drag/target policy
 *
 * Multiply the four together and you get the end-to-end figure, which is the only one a
 * visitor experiences and the least useful one to try to fix.
 *
 * Ground truth comes from the run file's own attempt windows: the screen prompted at a known
 * instant, so an attempt that produced no trace at all is still an attempt and still in the
 * denominator. That is the difference between measuring recall and measuring precision.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, basename } from "node:path";

const args = process.argv.slice(2);
const here = dirname(fileURLToPath(import.meta.url));

if (!args.length || args.includes("--help")) {
  console.log("usage: node scripts/vision-audit.mjs <run.json…> | --fixture");
  process.exit(args.length ? 0 : 1);
}

if (args.includes("--fixture")) {
  fixtureReport();
  process.exit(0);
}

const runs = args.filter((a) => !a.startsWith("--")).map((f) => ({ file: f, run: load(f) }));
for (const { file, run } of runs) report(file, run);
if (runs.length > 1) combined(runs);

// ---------------------------------------------------------------------------

function load(file) {
  const run = JSON.parse(readFileSync(file, "utf8"));
  if (run.version !== 1) throw new Error(`${file}: unknown run version ${run.version}`);
  return run;
}

/** Column index by name, so a reordered recording still reads correctly. */
function cols(run) {
  const at = {};
  run.columns.forEach((c, i) => (at[c] = i));
  return at;
}

function report(file, run) {
  const c = cols(run);
  const { spec, camera } = run;
  const per = spec.periodMs;

  line();
  console.log(`${basename(file)}`);
  console.log(
    `  ${spec.kind} × ${spec.attempts} @ ${spec.distanceM || "?"}m` +
      `${spec.note ? `  (${spec.note})` : ""}   ${run.startedAt}`,
  );
  console.log(
    `  camera  requested ${camera.requested.width}×${camera.requested.height}` +
      `   ACTUAL ${camera.videoWidth}×${camera.videoHeight}` +
      `   settings ${camera.settings.width ?? "?"}×${camera.settings.height ?? "?"}` +
      ` @${fmt(camera.settings.frameRate, 0)}` +
      `   measured ${fmt(camera.measuredFps, 1)}fps`,
  );
  if (camera.videoWidth !== camera.requested.width) {
    console.log(
      `  ⚠ the camera did NOT honour the request. Every per-pixel figure below is at` +
        ` ${camera.videoWidth}px wide, not ${camera.requested.width}px.`,
    );
  }

  const attempts = run.attempts.map((a) => analyse(a, run, c));
  const rest = spec.kind === "rest";

  // --- the layered recall table --------------------------------------------------------
  const n = attempts.length;
  const hand = attempts.filter((a) => a.handFrac >= 0.5).length;
  const latched = attempts.filter((a) => a.handFrac >= 0.5 && a.rawLatched).length;
  const pressed = attempts.filter((a) => a.rawLatched && a.pressed).length;
  const clicked = attempts.filter((a) => a.pressed && a.clicked).length;
  const endToEnd = attempts.filter((a) => a.clicked).length;

  if (!rest) {
    console.log("");
    console.log(`  LAYER                              n      rate`);
    console.log(`  1 Hand Recall                   ${pad(hand)}/${pad(n)}   ${rate(hand, n)}`);
    console.log(`  2 Pinch Recall | Hand           ${pad(latched)}/${pad(hand)}   ${rate(latched, hand)}`);
    console.log(`  3 Press Recall | Pinch          ${pad(pressed)}/${pad(latched)}   ${rate(pressed, latched)}`);
    console.log(`  4 Click Recall | Press          ${pad(clicked)}/${pad(pressed)}   ${rate(clicked, pressed)}`);
    console.log(`  = END TO END                    ${pad(endToEnd)}/${pad(n)}   ${rate(endToEnd, n)}`);

    const lat = attempts.filter((a) => a.pressed).map((a) => a.pressAt - a.cueAt);
    const lat2 = attempts.filter((a) => a.pressed && a.closeAt >= 0).map((a) => a.pressAt - a.closeAt);
    console.log("");
    console.log(
      `  latency cue→press      median ${fmt(median(lat), 0)}ms   p95 ${fmt(p95(lat), 0)}ms   (includes human reaction)`,
    );
    console.log(
      `  latency close→press    median ${fmt(median(lat2), 0)}ms   p95 ${fmt(p95(lat2), 0)}ms   (the system's own share)`,
    );
  }

  // --- false positives -------------------------------------------------------------------
  const stray = run.events.filter(
    (e) =>
      e.type === "click" &&
      e.detail.startsWith("hit") &&
      !run.attempts.some((a) => e.t >= a.cueAt && e.t < a.endAt),
  ).length;
  if (rest) {
    const fp = attempts.filter((a) => a.clicked).length;
    console.log("");
    console.log(`  FALSE POSITIVES     ${fp}/${n} rest windows produced a click   ${rate(fp, n)}`);
    console.log(`  ...plus ${stray} outside any window (${fmt((stray / ((n * per) / 60000)) || 0, 2)}/min)`);
  } else if (stray) {
    console.log(`  ⚠ ${stray} click(s) landed OUTSIDE an attempt window — false positives.`);
  }

  // --- where the failures went -----------------------------------------------------------
  const why = new Map();
  for (const a of attempts) {
    if (a.clicked !== rest) continue;
    for (const r of a.rejects) why.set(r, (why.get(r) ?? 0) + 1);
  }
  if (why.size) {
    console.log("");
    console.log("  rejections inside the failed attempts:");
    for (const [k, v] of [...why].sort((a, b) => b[1] - a[1])) {
      console.log(`    ${String(v).padStart(4)}×  ${k}`);
    }
  }

  // --- the feature comparison, which is the point of Phase 4 ------------------------------
  const ok = attempts.filter((a) => a.rawLatched);
  const bad = attempts.filter((a) => a.handFrac >= 0.5 && !a.rawLatched);
  console.log("");
  console.log("  PINCH FEATURE, per attempt, at its deepest point in the window");
  console.log("                        ratio3D(ships)   ratio2D    ratioPx   aperturePx   palmPx");
  featRow("  recognised   ", ok);
  featRow("  NOT recognised", bad);
  console.log("");
  console.log(
    "  separation (recognised vs not), in pooled SDs — bigger is a feature worth switching to:",
  );
  for (const k of ["minRatio3", "minRatio2", "minRatioPx"]) {
    console.log(`    ${k.padEnd(12)} d = ${fmt(cohen(ok.map((a) => a[k]), bad.map((a) => a[k])), 2)}`);
  }

  function featRow(label, set) {
    console.log(
      `${label} n=${String(set.length).padStart(3)}   ` +
        [
          median(set.map((a) => a.minRatio3)),
          median(set.map((a) => a.minRatio2)),
          median(set.map((a) => a.minRatioPx)),
          median(set.map((a) => a.minAperturePx)),
          median(set.map((a) => a.medPalmPx)),
        ]
          .map((v) => fmt(v, 2).padStart(9))
          .join("  "),
    );
  }
}

/** Everything about one prompted attempt, from the frames and events inside its window. */
function analyse(a, run, c) {
  const inWin = (t) => t >= a.cueAt && t < a.endAt;
  const rows = run.frames.filter((f) => inWin(f[c.t]));
  const evs = run.events.filter((e) => inWin(e.t));
  const val = (f, k) => (f[c[k]] === -1 ? Number.NaN : f[c[k]]);

  const handRows = rows.filter((f) => f[c.hand] === 1);
  const press = evs.find((e) => e.type === "press");
  // Only a click that reached something interactive counts. `inert`/`nothing` are dispatched
  // events that the page had no handler for — a success everywhere inside the pipeline and a
  // failure in front of the screen, which is the only place that matters.
  const click = evs.find((e) => e.type === "click" && e.detail.startsWith("hit"));
  const rawRow = rows.find((f) => f[c.raw] === 1);
  // "Closing" starts at the first frame whose feature has dropped meaningfully below the
  // open reference — the system's own share of latency is measured from there, not from the
  // prompt, because the prompt also contains a human deciding to move.
  const closeRow = rows.find((f) => Number.isFinite(val(f, "ratio3")) && val(f, "ratio3") < 1.1);

  return {
    i: a.i,
    cueAt: a.cueAt,
    frames: rows.length,
    handFrac: rows.length ? handRows.length / rows.length : 0,
    rawLatched: !!rawRow,
    pressed: !!press,
    pressAt: press ? press.t : Number.NaN,
    closeAt: closeRow ? closeRow[c.t] : -1,
    clicked: !!click,
    rejects: [...new Set(evs.filter((e) => e.type === "reject").map((e) => e.detail.split(" ")[0]))],
    minRatio3: min(handRows.map((f) => val(f, "ratio3"))),
    minRatio2: min(handRows.map((f) => val(f, "ratio2"))),
    minRatioPx: min(handRows.map((f) => val(f, "ratioPx"))),
    minAperturePx: min(handRows.map((f) => val(f, "aperturePx"))),
    medPalmPx: median(handRows.map((f) => val(f, "palmPx"))),
  };
}

function combined(runs) {
  line();
  console.log("ACROSS ALL RUNS — the distance curve, which is the decision this is for");
  console.log("");
  console.log("  dist   kind    hand      pinch|hand   press|pinch  click|press   end-to-end   palmPx");
  for (const { run } of runs.sort((a, b) => a.run.spec.distanceM - b.run.spec.distanceM)) {
    const c = cols(run);
    const at = run.attempts.map((a) => analyse(a, run, c));
    const n = at.length;
    const h = at.filter((a) => a.handFrac >= 0.5).length;
    const l = at.filter((a) => a.handFrac >= 0.5 && a.rawLatched).length;
    const p = at.filter((a) => a.rawLatched && a.pressed).length;
    const k = at.filter((a) => a.pressed && a.clicked).length;
    const e = at.filter((a) => a.clicked).length;
    console.log(
      `  ${String(run.spec.distanceM).padStart(4)}m  ${run.spec.kind.padEnd(6)} ` +
        [rate(h, n), rate(l, h), rate(p, l), rate(k, p), rate(e, n)].map((s) => s.padStart(10)).join("  ") +
        `  ${fmt(median(at.map((a) => a.medPalmPx)), 0).padStart(7)}`,
    );
  }
  console.log("");
  console.log("  Read the columns, not the last one. A row that collapses in `hand` is a lens.");
  console.log("  A row that collapses in `pinch|hand` is the feature. A row that collapses in");
  console.log("  `press|pinch` or `click|press` is policy, and policy is free to change.");
}

/**
 * `--fixture`: re-derive the audit's Phase-4 findings from the 0.5 m archive that the shipping
 * thresholds were fitted to. Kept in this file so the claims in docs/vision-audit.md can be
 * re-run rather than believed.
 */
function fixtureReport() {
  const fx = JSON.parse(readFileSync(join(here, "fixtures/pinch-trials.json"), "utf8"));
  line();
  console.log("THE ARCHIVE THE SHIPPING THRESHOLDS WERE FITTED TO");
  console.log(`  ${fx.note}`);
  console.log("");
  const dists = new Set(fx.trials.map((t) => t.distanceM));
  console.log(`  recorded distances: ${[...dists].join(", ")}m`);
  console.log(
    `  → every trial is at 0.5 m. There is NO recorded data at 1.5–2.5 m, which is the`,
  );
  console.log(`    range the kiosk actually operates in and the range this audit is about.`);
  console.log("");
  console.log("  trial              expect  frames  lost   ratio min / med / max   dips(prom≥0.1)");
  for (const t of fx.trials) {
    const v = t.s.map((s) => s[1]).filter((x) => x !== null);
    const lost = t.s.length - v.length;
    console.log(
      `  ${(t.kind + " #" + t.id).padEnd(18)} ${String(t.expected).padStart(6)}` +
        ` ${String(t.s.length).padStart(7)} ${String(lost).padStart(5)}` +
        `   ${v.length ? `${fmt(min(v), 3)} / ${fmt(median(v), 3)} / ${fmt(Math.max(...v), 3)}` : "—".padEnd(21)}` +
        `   ${v.length ? dips(v, 0.1) : 0}`,
    );
  }
  console.log("");
  console.log("  THE TWO RESULTS THAT MATTER:");
  console.log("");
  console.log("  1. A pinch CLOSED AND HELD for six seconds (#1) never dips at all: the ratio");
  console.log("     stays between 0.70 and 0.80 for the whole recording. Two fingertips in");
  console.log("     contact should drive this feature toward ~0.1. At half a metre that is not");
  console.log("     a resolution limit — it is the feature refusing to close, and the prime");
  console.log("     suspect is the z term, which MediaPipe infers rather than measures.");
  console.log("");
  console.log("  2. The ten-rep trials (#3, #4) contain only 4 and 7 excursions of ANY");
  console.log("     prominence, and the shipping detector recovers exactly 4 and 7. Widening");
  console.log("     the release threshold from 0.88 all the way to 1.2 changes nothing:");
  for (const t of fx.trials.filter((x) => x.kind === "pinch-reps")) {
    const s = t.s.map((x) => x[1]);
    const row = [0.88, 0.95, 1.0, 1.1, 1.2]
      .map((off) => `OFF=${off}:${latches(s, 0.74, off)}`)
      .join("  ");
    console.log(`       #${t.id} (${t.expected} performed)   ${row}`);
  }
  console.log("");
  console.log("     So the thresholds were never the binding constraint. The standing");
  console.log("     conclusion — 'no threshold pair beats 4/10 and 7/10, therefore the camera");
  console.log("     cannot see a pinch' — draws an OPTICS verdict from a FEATURE measurement,");
  console.log("     taken at a distance where optics was never in question.");
  console.log("");
  console.log("  What the archive cannot tell us, and why the new runs exist: whether the six");
  console.log("  and three missing reps were never performed, or were performed and left no");
  console.log("  trace. Nothing in the file timestamps the intent. The guided run does.");
  line();
}

// --- small stats ----------------------------------------------------------------------

function finite(a) {
  return a.filter((v) => Number.isFinite(v));
}
function min(a) {
  const v = finite(a);
  return v.length ? Math.min(...v) : Number.NaN;
}
function median(a) {
  const v = finite(a).sort((x, y) => x - y);
  return v.length ? v[Math.floor((v.length - 1) / 2)] : Number.NaN;
}
function p95(a) {
  const v = finite(a).sort((x, y) => x - y);
  return v.length ? v[Math.min(v.length - 1, Math.round(0.95 * (v.length - 1)))] : Number.NaN;
}
function cohen(a, b) {
  const A = finite(a);
  const B = finite(b);
  if (A.length < 2 || B.length < 2) return Number.NaN;
  const m = (x) => x.reduce((p, q) => p + q, 0) / x.length;
  const sd = (x) => Math.sqrt(x.reduce((p, q) => p + (q - m(x)) ** 2, 0) / x.length);
  const pooled = Math.sqrt((sd(A) ** 2 + sd(B) ** 2) / 2);
  return pooled < 1e-9 ? Number.NaN : (m(B) - m(A)) / pooled;
}
/** How many latch events a fixed hysteresis pair produces over a ratio series. */
function latches(series, on, off) {
  let held = false;
  let n = 0;
  for (const v of series) {
    if (v === null) continue;
    if (!held && v < on) {
      held = true;
      n += 1;
    } else if (held && v > off) held = false;
  }
  return n;
}
/** Count dips by prominence — threshold-free evidence of how many events a signal contains. */
function dips(series, prom) {
  const m = series.map((_, i) => {
    const w = series.slice(Math.max(0, i - 1), i + 2).sort((a, b) => a - b);
    return w[Math.floor(w.length / 2)];
  });
  let n = 0;
  let i = 0;
  while (i < m.length) {
    let lo = i;
    while (lo + 1 < m.length && m[lo + 1] <= m[lo]) lo += 1;
    let k = lo;
    while (k + 1 < m.length && m[k + 1] >= m[k] - 1e-9) k += 1;
    if (m[k] - m[lo] >= prom) n += 1;
    i = k <= i ? i + 1 : k;
  }
  return n;
}
function fmt(v, d) {
  return Number.isFinite(v) ? v.toFixed(d) : "—";
}
function pad(v) {
  return String(v).padStart(3);
}
function rate(a, b) {
  return b > 0 ? `${((a / b) * 100).toFixed(0)}% ` : "  n/a";
}
function line() {
  console.log("\n" + "─".repeat(88));
}
