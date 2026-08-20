import { JOINT, type Landmark } from "../../lib/vision/mediapipe";

/**
 * The measurement math behind the hand lab — no React, no DOM, so the numbers can be
 * re-derived offline from a recorded trial and the instrument can be trusted.
 *
 * The question this file exists to answer is narrow: CAN A PINCH BE READ AT KIOSK DISTANCE?
 * Everything else (jitter, reach, detection rate) is supporting evidence for the same
 * decision, because a pinch that is technically detectable but only while the hand is dead
 * still, or only in the middle of the frame, is not a pinch a passer-by can use.
 *
 * Two deliberate choices about WHAT is measured:
 *
 * 1. Distances come from MediaPipe's WORLD landmarks (metres, origin at the hand's centre),
 *    never from the normalised frame coordinates. In frame units a pinch measured at three
 *    metres and a wide-open hand measured at one metre produce the same number, so any
 *    threshold tuned at one standing distance is wrong at every other. The lab reports the
 *    normalised figure too — but only as the control that shows why it can't be used.
 *
 * 2. The headline figure is a RATIO — pinch aperture over palm width — not the raw metric
 *    distance. World landmarks are a model's estimate of hand scale, and that estimate is
 *    itself noisy; dividing by another distance measured on the same hand in the same frame
 *    cancels the shared scale error, and has the side benefit of being right for a child's
 *    hand and an adult's alike.
 */

/** One frame of measurements. Kept flat and numeric so a trial serialises to plain JSON. */
export interface Sample {
  /** ms since the trial started */
  t: number;
  /** thumb tip → index tip, in metres (world landmarks) */
  pinchWorld: number;
  /** the same aperture in frame units — the control that shows scale dependence */
  pinchNorm: number;
  /** palm width (index MCP → pinky MCP) in metres — the scale reference */
  span: number;
  /** pinchWorld / span. The scale-free headline figure. */
  ratio: number;
  /** index fingertip in frame units [0,1] — the raw pointer signal, for jitter */
  ix: number;
  iy: number;
  /** wrist in frame units [0,1] — for the reach box */
  wx: number;
  wy: number;
  /** face box width as a fraction of the frame — a proxy for how far away the visitor is */
  faceW: number;
  /** how many hands were tracked this frame */
  hands: number;
  /** how long both models took on this frame */
  inferMs: number;
}

export interface Stat {
  n: number;
  mean: number;
  sd: number;
  min: number;
  max: number;
  /** 5th/95th percentile — the honest "range in practice", immune to a single bad frame */
  p05: number;
  p95: number;
}

const EMPTY: Stat = { n: 0, mean: 0, sd: 0, min: 0, max: 0, p05: 0, p95: 0 };

export function stat(values: number[]): Stat {
  const v = values.filter(Number.isFinite);
  if (!v.length) return EMPTY;
  const n = v.length;
  const mean = v.reduce((a, b) => a + b, 0) / n;
  const variance = v.reduce((a, b) => a + (b - mean) ** 2, 0) / n;
  const sorted = [...v].sort((a, b) => a - b);
  const at = (q: number) => sorted[Math.min(n - 1, Math.max(0, Math.round(q * (n - 1))))]!;
  return { n, mean, sd: Math.sqrt(variance), min: sorted[0]!, max: sorted[n - 1]!, p05: at(0.05), p95: at(0.95) };
}

/**
 * Discriminability (Cohen's d) between the open-hand and pinched distributions — how many
 * pooled standard deviations apart the two states sit.
 *
 * This is THE number. A threshold can only separate two states if the states are actually
 * separated; d is that separation expressed in units of the noise that has to be cut through.
 * Reading it: below ~2 the two clouds overlap enough that any threshold produces constant
 * false triggers, around 3 a threshold with hysteresis works, above 4 it is comfortable.
 */
export function discriminability(open: Stat, pinched: Stat): number {
  if (!open.n || !pinched.n) return 0;
  const pooled = Math.sqrt((open.sd ** 2 + pinched.sd ** 2) / 2);
  if (pooled < 1e-9) return Number.POSITIVE_INFINITY;
  return (open.mean - pinched.mean) / pooled;
}

/** Verdict bands for `discriminability` — the decision rule, written down rather than eyeballed. */
export function pinchVerdict(d: number): { band: "good" | "marginal" | "bad"; text: string } {
  if (d >= 3) return { band: "good", text: "可用 — 阈值+迟滞能稳定分开两态" };
  if (d >= 2) return { band: "marginal", text: "勉强 — 需要更宽迟滞，并保留 Dwell 兜底" };
  return { band: "bad", text: "不可用 — 两态重叠，改用 Dwell 停留触发" };
}

/** Thumb tip → index tip. Returns NaN when the frame has no usable landmark set. */
export function aperture(lm: Landmark[] | undefined): number {
  const a = lm?.[JOINT.thumbTip];
  const b = lm?.[JOINT.indexTip];
  if (!a || !b) return Number.NaN;
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

/**
 * Palm width: index MCP → pinky MCP. Used as the scale reference rather than a finger length
 * because the knuckles are rigid relative to one another — a curled or splayed finger changes
 * its own length, which would make the reference move with the very gesture being measured.
 */
export function palmSpan(world: Landmark[] | undefined): number {
  const a = world?.[JOINT.indexMcp];
  const b = world?.[JOINT.pinkyMcp];
  if (!a || !b) return Number.NaN;
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

/**
 * The pinch state machine used to live here as a fixed-threshold latch. It moved to
 * `lib/vision/calibration.ts` as `PinchCalibrator` once the thresholds became self-calibrating
 * — the lab measures with exactly the detector the interaction will ship with, so a number
 * that looks good here cannot quietly differ from the one in the product.
 */

/**
 * Jitter translated into the only unit that matters for the decision: how many pixels the
 * cursor would wander on the real screen while the visitor holds their hand still.
 *
 * A standard deviation in frame units means nothing on its own — the same 0.004 is invisible
 * on a phone and a twitching 8-pixel cursor on a 2m wall. `gain` is how much of the screen
 * one unit of frame travel covers, i.e. the interaction box mapping we would ship.
 */
export function jitterPx(sdFrame: number, screenPx: number, gain = 1): number {
  return sdFrame * screenPx * gain;
}

/** The box the hand actually swept — what an interaction box would have to fit inside. */
export function reachBox(samples: Sample[]): { x0: number; x1: number; y0: number; y1: number; w: number; h: number } {
  const xs = samples.map((s) => s.wx).filter(Number.isFinite);
  const ys = samples.map((s) => s.wy).filter(Number.isFinite);
  if (!xs.length || !ys.length) return { x0: 0, x1: 0, y0: 0, y1: 0, w: 0, h: 0 };
  const x0 = Math.min(...xs);
  const x1 = Math.max(...xs);
  const y0 = Math.min(...ys);
  const y1 = Math.max(...ys);
  return { x0, x1, y0, y1, w: x1 - x0, h: y1 - y0 };
}

/** Fraction of frames in which at least one hand was tracked. */
export function detectionRate(samples: Sample[]): number {
  if (!samples.length) return 0;
  return samples.filter((s) => s.hands > 0).length / samples.length;
}

/**
 * Tracking dropouts: runs of hand-less frames longer than `gapMs`.
 *
 * Counted separately from the detection rate because the two fail differently. A steady 92%
 * detection rate is usable; the same 92% arriving as one 400ms blackout mid-gesture is a
 * cursor that vanishes exactly when someone is trying to click.
 */
export function dropouts(samples: Sample[], gapMs = 100): { count: number; longestMs: number } {
  let count = 0;
  let longest = 0;
  let runStart: number | null = null;
  for (const s of samples) {
    if (s.hands === 0) {
      if (runStart === null) runStart = s.t;
    } else if (runStart !== null) {
      const len = s.t - runStart;
      if (len >= gapMs) {
        count += 1;
        longest = Math.max(longest, len);
      }
      runStart = null;
    }
  }
  if (runStart !== null) {
    const len = (samples[samples.length - 1]?.t ?? runStart) - runStart;
    if (len >= gapMs) {
      count += 1;
      longest = Math.max(longest, len);
    }
  }
  return { count, longestMs: longest };
}

/** What one recorded trial produced. Summary is derived; `samples` is kept so it can be re-derived. */
export interface Trial {
  id: number;
  /** which step of the protocol this was */
  kind: TrialKind;
  /** how far the visitor stood, in metres — typed in, since nothing on the kiosk can measure it */
  distanceM: number;
  durationMs: number;
  /** deliberate pinches the protocol asked for (pinch-reps only), for a miss count */
  expectedReps: number | null;
  detectedReps: number;
  ratio: Stat;
  pinchWorld: Stat;
  pinchNorm: Stat;
  span: Stat;
  faceW: Stat;
  jitterXFrame: number;
  jitterYFrame: number;
  reach: ReturnType<typeof reachBox>;
  detection: number;
  drops: ReturnType<typeof dropouts>;
  fps: number;
  inferMs: Stat;
  samples: Sample[];
}

export type TrialKind = "still-open" | "still-pinch" | "pinch-reps" | "sweep" | "walkby";

/** The protocol. Order matters: the two baselines first, because everything else is judged against them. */
export const PROTOCOL: ReadonlyArray<{
  kind: TrialKind;
  label: string;
  hint: string;
  seconds: number;
  expectedReps: number | null;
}> = [
  {
    kind: "still-open",
    label: "1 · 张开静止",
    hint: "手抬起，手指自然张开，尽量别动 — 量「张开」基线和静止抖动",
    seconds: 6,
    expectedReps: null,
  },
  {
    kind: "still-pinch",
    label: "2 · 捏住静止",
    hint: "拇指和食指指尖真正碰上、捏紧不放，尽量别动 — 量「捏合」基线",
    seconds: 6,
    expectedReps: null,
  },
  {
    kind: "pinch-reps",
    label: "3 · 捏 10 次",
    hint: "不紧不慢地捏合再松开，正好 10 次 — 数漏检和误触",
    seconds: 15,
    expectedReps: 10,
  },
  {
    kind: "sweep",
    label: "4 · 划满范围",
    hint: "手臂舒服地划过左右上下的极限 — 量交互框和边缘丢失",
    seconds: 10,
    expectedReps: null,
  },
  {
    kind: "walkby",
    label: "5 · 空场/路过",
    hint: "手放下，或让人从画面走过 — 量误检（应当全程无手）",
    seconds: 8,
    expectedReps: null,
  },
];

/** Roll a finished recording up into the summary the results table shows. */
export function summarise(
  id: number,
  kind: TrialKind,
  distanceM: number,
  expectedReps: number | null,
  detectedReps: number,
  samples: Sample[],
): Trial {
  const durationMs = samples.length ? (samples[samples.length - 1]?.t ?? 0) : 0;
  const tracked = samples.filter((s) => s.hands > 0);
  return {
    id,
    kind,
    distanceM,
    durationMs,
    expectedReps,
    detectedReps,
    ratio: stat(tracked.map((s) => s.ratio)),
    pinchWorld: stat(tracked.map((s) => s.pinchWorld)),
    pinchNorm: stat(tracked.map((s) => s.pinchNorm)),
    span: stat(tracked.map((s) => s.span)),
    faceW: stat(samples.map((s) => s.faceW)),
    jitterXFrame: stat(tracked.map((s) => s.ix)).sd,
    jitterYFrame: stat(tracked.map((s) => s.iy)).sd,
    reach: reachBox(tracked),
    detection: detectionRate(samples),
    drops: dropouts(samples),
    fps: durationMs > 0 ? (samples.length / durationMs) * 1000 : 0,
    inferMs: stat(samples.map((s) => s.inferMs)),
    samples,
  };
}
