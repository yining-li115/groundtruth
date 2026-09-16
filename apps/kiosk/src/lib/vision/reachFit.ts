import { DEFAULT_BOX, type BoxConfig } from "./calibration";

/**
 * Fitting the interaction box to what a camera can ACTUALLY see, instead of guessing it.
 *
 * The box is the mapping: a hand halfway across it points halfway across the screen. Its size
 * and offset were hand-tuned once, in face widths, from what a standing adult can comfortably
 * reach — 4.5 by 3.0 faces, centred 2.6 faces below the eyes. That is a fair guess about a
 * person and no guess at all about a CAMERA, and the camera is the half that breaks.
 *
 * Measured against the default as it was then (4.5 x 3.0 faces — the shipped default is now
 * 2.7 x 1.8, see `DEFAULT_BOX`), on a 16:9 frame with the face at the usual height:
 *
 *   ~0.5 m   box 0.05..0.95 x 0.00..1.00   CUT — the box is wider than the frame
 *   ~0.8 m   box 0.21..0.79 x 0.31..1.00   bottom edge pinned to the frame
 *   ~1.0 m   box 0.28..0.72 x 0.47..1.00   bottom edge pinned to the frame
 *   ~1.5 m   box 0.35..0.65 x 0.48..0.85   fits
 *
 * Inside a metre — which is where anyone testing this stands — the bottom of the screen is
 * mapped to the bottom EDGE of the camera frame. Reaching for anything down there puts the
 * palm half out of shot, so tracking stops, so the pointer freezes: the corner of the screen
 * is not hard to hit, it is unreachable, and nothing on screen says so. It is not a threshold
 * that is wrong. It is the mapping handing a whole edge of the display to a region the camera
 * cannot see.
 *
 * No amount of cleverness recovers that from one frame, because it depends on the lens, the
 * mounting height and the angle — facts about the installation, not about the visitor. So they
 * get measured once, by watching somebody move: sweep a hand around, keep only the frames where
 * the hand was actually tracked, and fit the box to THAT. The result is still expressed in face
 * widths, so it keeps the property the whole design rests on — it travels with the person and
 * rescales itself as they move closer or further away — while no longer claiming reach the
 * camera never had.
 *
 * This file is the arithmetic and nothing else: no DOM, no camera, no React. The failure it
 * exists to prevent (a box fitted a few percent too generously, so the last centimetre of the
 * screen is dead) is invisible in a screenshot and obvious in a test.
 */

/**
 * One accepted frame of the sweep.
 *
 * Both coordinate systems are kept, because the fit needs both and they answer different
 * questions. `u`/`v` are where the hand was RELATIVE TO THE FACE, in face widths — the units
 * the box is expressed in, and the ones that survive the visitor moving. `x`/`y` are where it
 * was in the raw frame, which is the only way to ask the question that matters here: how close
 * to the edge of the picture did this get?
 */
export interface ReachSample {
  /** (palm.x − face.cx) / faceW — face-width units, raw frame direction */
  u: number;
  /** (palm.y − face.cy) / faceW — the SAME units as `u`, deliberately not divided by aspect */
  v: number;
  /** palm position in the raw frame, 0..1 */
  x: number;
  y: number;
  /** the face width this sample was measured against */
  faceW: number;
}

/**
 * How close to the edge of the frame the fitted box may come, as a fraction of the frame.
 *
 * Not zero, and the reason is that tracking does not stop at the edge of the picture — it
 * degrades for a while first. The last few percent are where the palm is partly out of shot and
 * the landmark model is extrapolating: it still returns a hand, so those frames are recorded as
 * successes, and a box fitted right up to them puts the edge of the screen in the one place the
 * pointer is least trustworthy.
 */
const EDGE_MARGIN = 0.05;

/** Reject the outer 2% of the sweep at each end: one frame of a mis-tracked hand halfway across
 *  the room would otherwise set the whole mapping. */
const TRIM = 0.02;

/** Below this, the sweep is too short to have covered anything. ~2s at 30fps. */
export const MIN_SAMPLES = 60;

/**
 * Sanity rails on the answer, in face widths.
 *
 * A fit that comes back outside these is not a small person or a tight camera, it is a broken
 * measurement — a hand that never moved, a face detector that flickered, a sweep performed by
 * somebody who did not understand the instruction. The honest response is to refuse and keep
 * the default, which at least fails the way the wall has always failed rather than in a new way.
 */
/*
 * Minimums of 1.2 faces wide and 0.8 tall: a small person holding four comfortable corners,
 * not stretching, sits around a face high. That is a small box and a high gain, but it is the
 * visitor's own movement; the stillness step that follows measures what the gain does to the
 * noise and sets the filter for it.
 */
const LIMITS = {
  width: { min: 1.2, max: 9 },
  height: { min: 0.8, max: 7 },
};

/** Linear-interpolated quantile of an UNSORTED array. Returns NaN for an empty one. */
export function quantile(values: number[], q: number): number {
  if (!values.length) return Number.NaN;
  const a = [...values].sort((m, n) => m - n);
  const pos = (a.length - 1) * Math.min(1, Math.max(0, q));
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  const t = pos - lo;
  return (a[lo] ?? 0) * (1 - t) + (a[hi] ?? 0) * t;
}

export interface ReachFit {
  box: BoxConfig;
  /** how much of the sweep survived the trim, for the operator's readout */
  samples: number;
  /** which sides had to be pulled in off the frame edge — the thing worth SAYING out loud,
   *  because it means the camera, not the person, is what limited the reach */
  clippedBy: { left: boolean; right: boolean; top: boolean; bottom: boolean };
}

/**
 * Fit a box to a recorded sweep. Returns null when the sweep cannot support one.
 *
 * `aspect` is frame width / height, and it is needed for the same reason `interactionBox` needs
 * it: `v` is measured in face-WIDTH units, while `heightFaces` is multiplied by the aspect on
 * the way back out, so the conversion has to be undone here or every fitted box comes out
 * stretched by 16/9.
 *
 * No longer what the calibration screen uses — that is `fitCorners` — but kept: it is the
 * fit for any recorded movement, which the harness and the hand lab still have a use for.
 */
export function fitReach(samples: ReachSample[], aspect: number): ReachFit | null {
  if (samples.length < MIN_SAMPLES || !Number.isFinite(aspect) || aspect <= 0) return null;

  const faceW = quantile(
    samples.map((s) => s.faceW).filter((w) => w > 0),
    0.5,
  );
  if (!(faceW > 0)) return null;

  let uLo = quantile(samples.map((s) => s.u), TRIM);
  let uHi = quantile(samples.map((s) => s.u), 1 - TRIM);
  let vLo = quantile(samples.map((s) => s.v), TRIM);
  let vHi = quantile(samples.map((s) => s.v), 1 - TRIM);

  // ...and the same trimmed extremes in the raw frame, to ask how near the picture's edge the
  // sweep actually got.
  const xLo = quantile(samples.map((s) => s.x), TRIM);
  const xHi = quantile(samples.map((s) => s.x), 1 - TRIM);
  const yLo = quantile(samples.map((s) => s.y), TRIM);
  const yHi = quantile(samples.map((s) => s.y), 1 - TRIM);

  // Pull any side that reached into the frame's margin back out of it. The correction is
  // computed in frame units and applied in face units, which is what `faceW` is doing here.
  const clippedBy = {
    left: xLo < EDGE_MARGIN,
    right: xHi > 1 - EDGE_MARGIN,
    top: yLo < EDGE_MARGIN,
    bottom: yHi > 1 - EDGE_MARGIN,
  };
  if (clippedBy.left) uLo += (EDGE_MARGIN - xLo) / faceW;
  if (clippedBy.right) uHi -= (xHi - (1 - EDGE_MARGIN)) / faceW;
  if (clippedBy.top) vLo += (EDGE_MARGIN - yLo) / faceW;
  if (clippedBy.bottom) vHi -= (yHi - (1 - EDGE_MARGIN)) / faceW;

  const widthFaces = uHi - uLo;
  // `v` is in face-width units; `heightFaces` gets multiplied by the aspect downstream.
  const heightFaces = (vHi - vLo) / aspect;
  if (
    !(widthFaces >= LIMITS.width.min && widthFaces <= LIMITS.width.max) ||
    !(heightFaces >= LIMITS.height.min && heightFaces <= LIMITS.height.max)
  ) {
    return null;
  }

  return {
    box: {
      widthFaces,
      heightFaces,
      dropFaces: (vLo + vHi) / 2 / aspect,
      shiftFaces: (uLo + uHi) / 2,
    },
    samples: samples.length,
    clippedBy,
  };
}

/**
 * Fit a box to FOUR HELD POSITIONS — the visitor's hand at a comfortable top-left, top-right,
 * bottom-right and bottom-left — instead of to a sweep.
 *
 * This replaced the circle, and the review that asked for it had the argument right: a box is
 * a rectangle, a rectangle is its corners, and nothing else in the calibration needs a sweep.
 * The circle existed only to produce the same four extents from a cloud of moving samples, and
 * it produced them badly — a moving hand at the limit of its reach is the least tracked thing
 * the camera sees, and at any distance inside a metre the arc ran straight out of the frame.
 * A held hand is a still sample, taken where the visitor has stopped, with time to check it is
 * actually in shot before it is kept.
 *
 * Label-free on purpose: the four samples are sorted by where they ARE, so the order they
 * were collected in and the mirror between the camera and the screen cannot get into the
 * answer. Left of the box is the mean of the two smallest `u`, right the two largest, and so
 * on — a mean rather than an extreme so a single hand that stopped a little short does not
 * set the whole edge.
 *
 * `inset` is where the held positions land on the screen: 0.05 puts them on targets 5% in
 * from the edge, 0 on the very corner, and a NEGATIVE value past the edge — a smaller box
 * than the movement, so every corner is reached with the hand short of where it was held.
 * The box is the held span divided by (1 − 2·inset), about the same centre.
 */
export function fitCorners(
  samples: ReachSample[],
  aspect: number,
  { inset = 0.05 }: { inset?: number } = {},
): ReachFit | null {
  if (samples.length !== 4 || !Number.isFinite(aspect) || aspect <= 0) return null;
  if (!(inset > -0.3 && inset < 0.4)) return null;
  const faceW = quantile(
    samples.map((s) => s.faceW).filter((w) => w > 0),
    0.5,
  );
  if (!(faceW > 0)) return null;
  const two = (vals: number[], high: boolean): number => {
    const a = [...vals].sort((m, n) => m - n);
    const pick = high ? a.slice(2) : a.slice(0, 2);
    return (pick[0]! + pick[1]!) / 2;
  };
  const span = 1 - 2 * inset;
  const grow = (lo: number, hi: number): [number, number] => {
    const c = (lo + hi) / 2;
    const half = (hi - lo) / 2 / span;
    return [c - half, c + half];
  };
  let [uLo, uHi] = grow(two(samples.map((s) => s.u), false), two(samples.map((s) => s.u), true));
  let [vLo, vHi] = grow(two(samples.map((s) => s.v), false), two(samples.map((s) => s.v), true));

  // The same frame-edge rule as a sweep: a held position inside the margin is one the camera
  // was about to lose, and the box edge must not be put there.
  const xs = samples.map((s) => s.x);
  const ys = samples.map((s) => s.y);
  const xLo = Math.min(...xs);
  const xHi = Math.max(...xs);
  const yLo = Math.min(...ys);
  const yHi = Math.max(...ys);
  const clippedBy = {
    left: xLo < EDGE_MARGIN,
    right: xHi > 1 - EDGE_MARGIN,
    top: yLo < EDGE_MARGIN,
    bottom: yHi > 1 - EDGE_MARGIN,
  };
  if (clippedBy.left) uLo += (EDGE_MARGIN - xLo) / faceW;
  if (clippedBy.right) uHi -= (xHi - (1 - EDGE_MARGIN)) / faceW;
  if (clippedBy.top) vLo += (EDGE_MARGIN - yLo) / faceW;
  if (clippedBy.bottom) vHi -= (yHi - (1 - EDGE_MARGIN)) / faceW;

  const widthFaces = uHi - uLo;
  const heightFaces = (vHi - vLo) / aspect;
  if (
    !(widthFaces >= LIMITS.width.min && widthFaces <= LIMITS.width.max) ||
    !(heightFaces >= LIMITS.height.min && heightFaces <= LIMITS.height.max)
  ) {
    return null;
  }
  return {
    box: {
      widthFaces,
      heightFaces,
      dropFaces: (vLo + vHi) / 2 / aspect,
      shiftFaces: (uLo + uHi) / 2,
    },
    samples: 4,
    clippedBy,
  };
}

/**
 * Shrink a fitted box about its own centre.
 *
 * The reach test after the fit is what catches an answer that is right on paper and wrong in
 * the room — a corner the sweep reached once, at the limit, and that nobody can hold a hand
 * still in. When a corner fails, the honest correction is not to move the box (its centre was
 * measured and is fine) but to ask for less of the screen's worth of reach.
 */
export function shrinkBox(box: BoxConfig, factor: number): BoxConfig {
  return {
    ...box,
    widthFaces: box.widthFaces * factor,
    heightFaces: box.heightFaces * factor,
  };
}

/** Is this a box we would be willing to ship? Used to reject a restored calibration whose
 *  numbers no longer make sense — a stored blob from an older schema, or a hand-edited one. */
export function isUsableBox(box: unknown): box is BoxConfig {
  if (!box || typeof box !== "object") return false;
  const b = box as Partial<BoxConfig>;
  const num = (v: unknown) => typeof v === "number" && Number.isFinite(v);
  return (
    num(b.widthFaces) &&
    num(b.heightFaces) &&
    num(b.dropFaces) &&
    (b.shiftFaces === undefined || num(b.shiftFaces)) &&
    b.widthFaces! >= LIMITS.width.min &&
    b.widthFaces! <= LIMITS.width.max &&
    b.heightFaces! >= LIMITS.height.min &&
    b.heightFaces! <= LIMITS.height.max &&
    Math.abs(b.dropFaces!) <= 8 &&
    Math.abs(b.shiftFaces ?? 0) <= 5
  );
}

export { DEFAULT_BOX };
