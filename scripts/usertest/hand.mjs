#!/usr/bin/env node
/**
 * A HUMAN hand, on top of `driver.mjs`'s synthetic one.
 *
 * The driver's hand is a laboratory hand: it teleports to a coordinate, holds it to the
 * micrometre, closes its fingers instantly and completely, and holds perfectly still while it
 * does. Everything passes against that hand. Nothing about it is true.
 *
 * A real visitor's hand is held up in the air at the end of an arm and it never stops moving —
 * postural sway of a per cent or so of the screen at around a hertz, a faster tremor on top,
 * and a lurch toward the body at the moment the fingers close. Those are the three things that
 * break a touchless click, and none of them can be seen with a hand that does not shake:
 *
 *   - drift while held  → the press is reclassified as a drag and the click is silently eaten
 *   - drift at the seam → the release lands on the neighbouring target
 *   - a shallow close   → the aperture never crosses the threshold, so nothing happens at all
 *
 * So this layer animates the simulator inside the page — every frame, not per command — with
 * sway, tremor, a reach that takes as long as an arm takes, and a pinch that closes over about
 * a fifth of a second to a depth the caller chooses. What it cannot do is see: whether a real
 * camera would have READ the gesture is measured separately (`npm run check:pointer`).
 */
import { sleep } from "./driver.mjs";

/** Hand profiles, in screen fractions of sway/tremor amplitude. */
export const HANDS = {
  /** Braced, deliberate — an elbow resting, someone who has done this before. */
  steady: { sway: 0.004, tremor: 0.0012, pinchLurch: 0.004, depth: 0.45 },
  /** The default visitor: arm unsupported, mildly self-conscious, aiming carefully. */
  typical: { sway: 0.009, tremor: 0.0025, pinchLurch: 0.010, depth: 0.55 },
  /** Tired arm, or someone standing further back and reaching. */
  shaky: { sway: 0.018, tremor: 0.005, pinchLurch: 0.018, depth: 0.62 },
  /** A pinch that never quite closes — the posture the camera cannot read. */
  timid: { sway: 0.009, tremor: 0.0025, pinchLurch: 0.010, depth: 0.82 },
};

/**
 * What the CAMERA does to all of that, which is the half a perfect simulator quietly skips.
 *
 * A webcam metres away does not report a clean aperture: two fingertips a couple of
 * centimetres apart are, at that range, a signal about the size of the noise, so the ratio the
 * detector thresholds against jitters — and it drops the hand outright for a few frames at a
 * time. Both are why a pinch "sometimes does nothing": a shallow pinch buried in noise never
 * crosses 0.74, and a hand lost mid-press releases without a click (`releasedByLoss`).
 *
 * `none` is the laboratory: what the harness measured before this existed, and the reason it
 * reported everything as working. Recorded ground truth for the far case is in
 * `scripts/fixtures/pinch-trials.json` — pinch alone recovers 12 of 21 deliberate attempts.
 */
export const CAMERAS = {
  none: { ratioNoise: 0, dropoutPerSec: 0, dropoutMs: 0, depthBias: 0, depthSpread: 0 },
  /** ~1 m, the hand filling a decent part of the frame. */
  near: { ratioNoise: 0.05, dropoutPerSec: 0.25, dropoutMs: 90, depthBias: 0.05, depthSpread: 0.07 },
  /** ~2 m — the measured degradation: the pinch is barely above the noise floor. */
  far: { ratioNoise: 0.13, dropoutPerSec: 0.9, dropoutMs: 140, depthBias: 0.19, depthSpread: 0.13 },
};

/**
 * How much SHALLOWER than intended this particular pinch reads.
 *
 * Per-frame noise alone was not enough to reproduce what a real camera does, and testing
 * against it reported everything as working. The dominant error is not jitter within one
 * attempt, it is that a whole ATTEMPT reads too open: at two metres the fingertips are barely
 * resolved, so the same deliberate pinch comes back as 0.55 once and 0.95 the next time, and
 * the second one never crosses the 0.74 threshold no matter how long it is held.
 *
 * `depthBias`/`depthSpread` are set so a typical hand on the `far` camera lands near the
 * measured recovery rate — 12 of 21 deliberate pinches — from `scripts/fixtures/pinch-trials.json`.
 */
export function attemptDepth(profile, camera, attempt = 0) {
  if (!camera.depthSpread) return profile.depth;
  // Deterministic per attempt, so a failing run can be repeated exactly.
  const r = (Math.sin(attempt * 12.9898 + 78.233) * 43758.5453) % 1;
  const u = Math.abs(r);
  const gauss = (u - 0.5) * 2.4; // flat-ish, with the tails that matter
  return profile.depth + camera.depthBias + gauss * camera.depthSpread;
}

/**
 * Install the animator in the page. Must be re-run after every navigation, because it lives in
 * the page (the simulator itself survives, the animator does not).
 */
export async function installHuman(k, profile = HANDS.typical, camera = CAMERAS.none) {
  await k.evaluate(`(() => {
    if (window.__human && window.__human.raf) cancelAnimationFrame(window.__human.raf);
    const H = (window.__human = {
      ratioNoise: ${camera.ratioNoise},
      dropoutPerSec: ${camera.dropoutPerSec},
      dropoutMs: ${camera.dropoutMs},
      dropUntil: 0,
      seed: 20260820,
      target: { u: 0.5, v: 0.5 },
      from: { u: 0.5, v: 0.5 },
      t0: performance.now(),
      travelMs: 1,
      sway: ${profile.sway},
      tremor: ${profile.tremor},
      lurch: { u: 0, v: 0 },
      aperture: 1.44,
      apFrom: 1.44,
      apTo: 1.44,
      apT0: performance.now(),
      apMs: 1,
      phase: [0.3, 1.9, 4.1, 2.7, 5.3, 0.8],
      raf: 0,
    });
    const ease = (t) => 1 - Math.pow(1 - t, 3); // reach: fast out, settling in
    const step = () => {
      H.raf = requestAnimationFrame(step);
      const now = performance.now();
      const t = (now - H.t0) / 1000;

      // Reach.
      const p = Math.min(1, (now - H.t0) / H.travelMs);
      const e = ease(p);
      const bu = H.from.u + (H.target.u - H.from.u) * e;
      const bv = H.from.v + (H.target.v - H.from.v) * e;

      // Sway (slow, postural) + tremor (fast, physiological). Two axes, different phases, so
      // the hand wanders on a small ellipse instead of sliding along one line.
      const su =
        H.sway * (0.62 * Math.sin(2 * Math.PI * 0.7 * t + H.phase[0]) +
                  0.38 * Math.sin(2 * Math.PI * 1.9 * t + H.phase[1]));
      const sv =
        H.sway * (0.62 * Math.sin(2 * Math.PI * 0.55 * t + H.phase[2]) +
                  0.38 * Math.sin(2 * Math.PI * 2.3 * t + H.phase[3]));
      const tu = H.tremor * Math.sin(2 * Math.PI * 9.5 * t + H.phase[4]);
      const tv = H.tremor * Math.sin(2 * Math.PI * 11.5 * t + H.phase[5]);

      const clamp = (v) => (v < 0.01 ? 0.01 : v > 0.99 ? 0.99 : v);
      window.__handSim.aim = {
        u: clamp(bu + su + tu + H.lurch.u),
        v: clamp(bv + sv + tv + H.lurch.v),
      };

      // Fingers.
      const ap = Math.min(1, (now - H.apT0) / H.apMs);
      H.aperture = H.apFrom + (H.apTo - H.apFrom) * (ap * ap * (3 - 2 * ap));

      // ...as the camera sees them. Deterministic pseudo-noise, so a run is repeatable.
      H.seed = (H.seed * 1664525 + 1013904223) >>> 0;
      const r1 = H.seed / 4294967296;
      H.seed = (H.seed * 1664525 + 1013904223) >>> 0;
      const r2 = H.seed / 4294967296;
      // Box–Muller, so the excursions have a tail rather than a hard edge.
      const g = Math.sqrt(-2 * Math.log(r1 + 1e-9)) * Math.cos(2 * Math.PI * r2);
      window.__handSim.aperture = Math.max(0.05, H.aperture + g * H.ratioNoise);

      // Tracking drops the hand entirely now and then.
      if (H.dropoutPerSec > 0 && now > H.dropUntil && r2 < H.dropoutPerSec / 60) {
        H.dropUntil = now + H.dropoutMs;
      }
      window.__handSim.present = now > H.dropUntil;
    };
    H.raf = requestAnimationFrame(step);
  })()`);
}

/**
 * Point at a screen pixel the way an arm does: a reach of a couple of hundred milliseconds,
 * then a hand that keeps moving.
 *
 * There is no "settled" to wait for — a hand that shakes never converges — so this waits the
 * reach out and then long enough for the filter to catch up, and reports the residual wobble
 * so a caller can tell "the pointer is on the target, wandering" from "the pointer is lost".
 */
export async function reachPx(k, x, y, { travelMs = 480, settleMs = 420 } = {}) {
  const size = await k.evaluate(`({ w: innerWidth, h: innerHeight })`);
  await k.evaluate(`(() => {
    const H = window.__human;
    const s = window.__handState();
    H.from = { u: s.x, v: s.y };
    H.target = { u: ${x} / ${size.w}, v: ${y} / ${size.h} };
    H.t0 = performance.now();
    H.travelMs = ${travelMs};
  })()`);
  await sleep(travelMs + settleMs);
}

/**
 * A pinch as a person makes one: fingers close over about 180 ms to `depth`, the hand lurches
 * a little as they do, it is held for a moment, and then it opens.
 *
 * `depth` is the aperture reached, in the units the detector thresholds against (ON below
 * 0.74, OFF above 0.88). 0.45 is a firm pinch; 0.82 is a polite one that never latches.
 */
export async function pinchClick(
  k,
  { depth = 0.55, closeMs = 180, holdMs = 420, openMs = 150, lurch = 0.01, settleMs = 1500 } = {},
) {
  await k.evaluate(`(() => {
    const H = window.__human;
    H.apFrom = H.aperture; H.apTo = ${depth}; H.apT0 = performance.now(); H.apMs = ${closeMs};
    // The hand pulls slightly toward the body as the fingers close. Direction varies; this
    // takes a fixed diagonal so a run is reproducible.
    H.lurchTo = { u: -${lurch} * 0.6, v: ${lurch} };
    H.lurch = { u: 0, v: 0 };
    const t0 = performance.now();
    const ramp = () => {
      const p = Math.min(1, (performance.now() - t0) / ${closeMs + holdMs});
      H.lurch = { u: H.lurchTo.u * p, v: H.lurchTo.v * p };
      if (p < 1) requestAnimationFrame(ramp);
    };
    requestAnimationFrame(ramp);
  })()`);
  await sleep(closeMs + holdMs);
  await k.evaluate(`(() => {
    const H = window.__human;
    H.apFrom = H.aperture; H.apTo = 1.44; H.apT0 = performance.now(); H.apMs = ${openMs};
  })()`);
  await sleep(openMs + 120);
  // The hand comes back off the lurch once the fingers are open, the way a real one does.
  await k.evaluate(`(() => { window.__human.lurch = { u: 0, v: 0 }; })()`);
  // Release edge, then the app's pixel transition, which swaps the view ~800 ms later.
  await sleep(settleMs);
}

/** How far the cursor wandered over a second of holding still — the wobble a target must absorb. */
export async function measureWobble(k, ms = 1000) {
  return k.evaluate(`new Promise((res) => {
    const xs = [], ys = [];
    const t0 = performance.now();
    const tick = () => {
      const s = window.__handState();
      xs.push(s.x); ys.push(s.y);
      if (performance.now() - t0 < ${ms}) requestAnimationFrame(tick);
      else res({
        spanX: Math.max(...xs) - Math.min(...xs),
        spanY: Math.max(...ys) - Math.min(...ys),
        n: xs.length,
      });
    };
    requestAnimationFrame(tick);
  })`);
}
