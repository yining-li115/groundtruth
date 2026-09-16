import { OneEuroPoint } from "./oneEuro";
import { isUsableBox, quantile, type ReachFit } from "./reachFit";
import { DEFAULT_BOX, type BoxConfig } from "./calibration";

/**
 * The measured profile of one installation — everything the gesture pipeline needs to know
 * that is a fact about the room rather than about the code.
 *
 * The kiosk's constants were all fitted honestly, and every one of them was fitted against ONE
 * camera, at ONE distance, on ONE pair of hands. That is fine as a default and wrong as a law:
 *
 *   - The interaction box was tuned from what a standing adult can reach, which says nothing
 *     about what THIS lens, at THIS mounting height, can see. Inside a metre the shipped box
 *     hands the bottom edge of the screen to a region outside the frame (see `reachFit.ts`).
 *   - The pinch thresholds come from six recordings taken at 0.5 m. The archive shows a
 *     deliberate pinch HELD for six seconds never driving the feature below 0.70, which is why
 *     `PINCH_ON` had to be dragged up to 0.74 — a number sitting inside the closed-pinch
 *     distribution rather than in the gap below it (`docs/vision-audit.md` §6).
 *   - The 1€ filter's `minCutoff` was tuned against that camera's noise. A different sensor,
 *     or the same one two metres further back, has a different amount of it.
 *   - `confidence()` is handed `palmNorm * 1280` — a hard-coded assumption about a camera that
 *     is simply false on a 640-wide one, and makes the two warnings that exist for the distance
 *     problem unable to fire (audit finding F1).
 *
 * None of that is recoverable from a single frame, because it depends on the lens, the mounting
 * and the person. So it is measured, once, by watching somebody do four things — stand still,
 * hold a hand still, sweep it around, and open and close it — and everything downstream reads
 * the answer instead of a constant.
 *
 * PURE. No DOM, no camera, no React, no storage. The functions here are the part that can be
 * wrong in a way nobody sees: a threshold fitted a hair too high is a wall that ignores every
 * third gesture, and it looks exactly like a wall that is working.
 */

/** Bump when the meaning of a field changes, so stored profiles from an older build are
 *  discarded rather than silently misread. */
export const PROFILE_VERSION = 2; // 2: the pointing joint moved from the palm centre to the wrist

export interface CameraFacts {
  /** `MediaDeviceInfo.deviceId` — the key a profile is stored under */
  deviceId: string;
  /** human-readable, for the operator's readout only */
  label: string;
  /** what the browser ACTUALLY decoded, not what was requested */
  frameW: number;
  frameH: number;
  /** measured end-to-end rate of the vision loop, in Hz */
  fps: number;
}

export interface PinchFit {
  /** latch closed below this aperture/palm ratio */
  on: number;
  /** release above this */
  off: number;
  /** where this person's open hand actually sits */
  open: number;
  /** ...and the tightest their closing hand reached */
  closed: number;
  /** separation between the two clouds, in pooled standard deviations */
  separation: number;
  /** false when the two clouds overlap — this camera cannot read this person's pinch */
  usable: boolean;
}

export interface JitterFit {
  /** how far the RAW mapped cursor wandered under a still hand, in screen fractions (RMS) */
  raw: number;
  /** ...and how far it wanders once filtered at the chosen cutoff */
  filtered: number;
  /** the 1€ filter cutoff that measurement chose */
  minCutoff: number;
  /** a dwell radius that a still hand will not leave by accident */
  dwellRadius: number;
}

export interface CalibrationProfile {
  version: number;
  measuredAt: number;
  camera: CameraFacts;
  box: BoxConfig;
  /** which sides of the box the CAMERA limited rather than the arm — worth saying out loud */
  clippedBy: ReachFit["clippedBy"];
  pinch: PinchFit;
  jitter: JitterFit;
  /** the visitor's palm width in real camera pixels at the distance they stood */
  palmPx: number;
  /** what the measurement concluded the click posture should be */
  clickGesture: "pinch" | "fist" | "either";
}

// ---------------------------------------------------------------------------- pinch

/**
 * The smallest usable gap between an open hand and a closed one, in ratio units.
 *
 * Below this there is nowhere to put a threshold that is not inside one of the two clouds, and
 * a threshold inside a cloud is a coin toss dressed up as a decision. The shipped default sits
 * at 0.74 against a measured closed-pinch cloud centred on 0.758 — which is exactly this
 * failure, and exactly why the fist path exists.
 */
const MIN_GAP = 0.08;
/** ...and how separated they must be relative to their own spread. */
const MIN_SEPARATION = 1.2;

/**
 * Fit this person's pinch thresholds from their own hand, on this camera.
 *
 * `open` is every ratio recorded while they were asked to hold the hand open; `closing` is
 * every ratio recorded while they were asked to open and close it. The closing set contains
 * both postures by construction — that is the point, it is what they actually do when told to
 * pinch — so the closed cloud is taken from its LOW tail rather than its middle.
 *
 * Thresholds land inside the gap rather than at the edge of either cloud, with the release
 * point further out than the latch point so the hysteresis band is the gap itself.
 */
export function fitPinch(open: number[], closing: number[]): PinchFit {
  const o = open.filter(Number.isFinite);
  const c = closing.filter(Number.isFinite);
  const blank: PinchFit = {
    on: 0.74,
    off: 0.88,
    open: Number.NaN,
    closed: Number.NaN,
    separation: 0,
    usable: false,
  };
  if (o.length < 20 || c.length < 20) return blank;

  const openMid = quantile(o, 0.5);
  // The bottom of the open cloud, not its middle: the threshold has to clear the noisiest open
  // frames, or a resting hand latches a click on its own.
  const openLo = quantile(o, 0.08);
  // The tightest the closing hand reliably got. q15 rather than the minimum, because the
  // minimum is one frame and one frame is not a posture anybody can repeat.
  const closedHi = quantile(c, 0.15);

  const gap = openLo - closedHi;
  const separation = pooledSeparation(o, c.filter((v) => v <= closedHi + gap * 0.5));
  const usable = gap >= MIN_GAP && separation >= MIN_SEPARATION;

  if (!usable) return { ...blank, open: openMid, closed: closedHi, separation };

  return {
    // Inside the gap, nearer the closed side: crossing it should take a real closing movement,
    // not a relaxed hand drifting.
    on: closedHi + gap * 0.35,
    off: closedHi + gap * 0.8,
    open: openMid,
    closed: closedHi,
    separation,
    usable: true,
  };
}

/** Cohen's d — how far apart two clouds are in units of their own spread. */
function pooledSeparation(a: number[], b: number[]): number {
  if (a.length < 2 || b.length < 2) return 0;
  const mean = (v: number[]) => v.reduce((s, n) => s + n, 0) / v.length;
  const varr = (v: number[], m: number) =>
    v.reduce((s, n) => s + (n - m) * (n - m), 0) / (v.length - 1);
  const ma = mean(a);
  const mb = mean(b);
  const pooled = Math.sqrt(
    ((a.length - 1) * varr(a, ma) + (b.length - 1) * varr(b, mb)) / (a.length + b.length - 2),
  );
  return pooled > 1e-9 ? Math.abs(ma - mb) / pooled : 0;
}

// ---------------------------------------------------------------------------- jitter

/**
 * How much a still cursor is allowed to wander, in screen fractions.
 *
 * Roughly 0.3% of the screen — about six pixels on a 4K wall. Below that nobody reads it as
 * movement; above it the cursor visibly shimmers, which reads as the tracking being bad even
 * when the tracking is fine.
 */
const JITTER_TARGET = 0.003;
/** Candidate cutoffs, low (smooth, laggy) to high (responsive, shaky). */
const CUTOFF_STEPS = [0.1, 0.15, 0.2, 0.3, 0.4, 0.6, 0.8, 1.2, 1.6];

/**
 * Choose the 1€ filter's `minCutoff` by running the REAL filter over the REAL recording.
 *
 * Not a formula. The published guidance is to lower `minCutoff` until a still hand produces a
 * still cursor, which is a measurement dressed up as advice — so this performs it: replay the
 * held-still segment through the actual filter at each candidate cutoff, and take the HIGHEST
 * one that keeps the residual under target. Highest, because cutoff is bought with lag, and
 * lag is the thing a visitor feels on every single movement.
 *
 * `beta` is deliberately not fitted here. It scales with the units of the input, not with the
 * camera, and the shipped value was measured against recorded fast sweeps (0.007 left the
 * cursor 1299px behind at 4K; 10 left it 59px). A still hand contains no speed for beta to act
 * on, so this recording cannot say anything about it.
 */
export function fitJitter(
  samples: Array<{ x: number; y: number; t: number }>,
  beta: number,
): JitterFit {
  const fallback: JitterFit = {
    raw: Number.NaN,
    filtered: Number.NaN,
    minCutoff: 0.4,
    dwellRadius: 0.035,
  };
  if (samples.length < 30) return fallback;

  const raw = rms(samples.map((s) => ({ x: s.x, y: s.y })));
  let chosen = CUTOFF_STEPS[0]!;
  let chosenResidual = Number.POSITIVE_INFINITY;
  for (const cutoff of CUTOFF_STEPS) {
    const filter = new OneEuroPoint({ minCutoff: cutoff, beta, dCutoff: 1 });
    const out = samples.map((s) => filter.filter(s.x, s.y, s.t));
    // Drop the first few frames: the filter is still converging from its first sample, and
    // that transient is not jitter.
    const settled = out.slice(Math.min(10, out.length - 1));
    const residual = rms(settled);
    if (residual <= JITTER_TARGET) {
      chosen = cutoff;
      chosenResidual = residual;
    }
    // keep going: we want the HIGHEST cutoff that still passes, and the list is ascending
  }
  if (!Number.isFinite(chosenResidual)) {
    // Nothing was quiet enough. Take the smoothest available and report what it managed, so the
    // operator sees a number instead of a silent default.
    const filter = new OneEuroPoint({ minCutoff: CUTOFF_STEPS[0]!, beta, dCutoff: 1 });
    const out = samples.map((s) => filter.filter(s.x, s.y, s.t));
    chosen = CUTOFF_STEPS[0]!;
    chosenResidual = rms(out.slice(Math.min(10, out.length - 1)));
  }

  return {
    raw,
    filtered: chosenResidual,
    minCutoff: chosen,
    // Three times the residual, floored: a dwell that fires when the hand has not moved is
    // worse than one that needs a moment longer, and the floor keeps a very quiet camera from
    // producing a radius so tight that ordinary breathing cancels the dwell.
    dwellRadius: Math.max(0.02, Math.min(0.09, chosenResidual * 3)),
  };
}

/** Root-mean-square distance from the mean of a set of points. */
function rms(points: Array<{ x: number; y: number }>): number {
  if (!points.length) return Number.NaN;
  const mx = points.reduce((s, p) => s + p.x, 0) / points.length;
  const my = points.reduce((s, p) => s + p.y, 0) / points.length;
  const sum = points.reduce((s, p) => s + (p.x - mx) ** 2 + (p.y - my) ** 2, 0);
  return Math.sqrt(sum / points.length);
}

// ---------------------------------------------------------------------------- frame counts

/**
 * The three gates that are counted in FRAMES rather than milliseconds, converted using the rate
 * this loop was actually measured at.
 *
 * They were written as frame counts and they behave as time: "eight frames after a tracking
 * gap" is a quarter of a second at 30fps and half a second at 15. On a machine sharing its GPU
 * with a gaussian renderer that is not a hypothetical difference, and the failure it produces —
 * a pinch that will not latch for half a second after every tracking blink — is invisible.
 */
export function framesFor(ms: number, fps: number): number {
  const rate = Number.isFinite(fps) && fps > 1 ? fps : 30;
  return Math.max(1, Math.round((ms / 1000) * rate));
}

// ---------------------------------------------------------------------------- validation

export function isUsableProfile(p: unknown): p is CalibrationProfile {
  if (!p || typeof p !== "object") return false;
  const v = p as Partial<CalibrationProfile>;
  return (
    v.version === PROFILE_VERSION &&
    typeof v.measuredAt === "number" &&
    !!v.camera &&
    typeof v.camera.deviceId === "string" &&
    isUsableBox(v.box) &&
    !!v.pinch &&
    typeof v.pinch.on === "number" &&
    typeof v.pinch.off === "number" &&
    v.pinch.on < v.pinch.off &&
    !!v.jitter &&
    typeof v.jitter.minCutoff === "number" &&
    v.jitter.minCutoff > 0
  );
}

/** What the pipeline runs on before anything has been measured. */
export const DEFAULT_PROFILE_BOX = DEFAULT_BOX;
