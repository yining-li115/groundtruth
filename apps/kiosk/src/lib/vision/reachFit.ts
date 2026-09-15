import { DEFAULT_BOX, type BoxConfig } from "./calibration";

/**
 * Fitting the interaction box to what a camera can ACTUALLY see, instead of guessing it.
 *
 * The box is the mapping: a hand halfway across it points halfway across the screen. Its size
 * and offset were hand-tuned once, in face widths, from what a standing adult can comfortably
 * reach — 4.5 by 3.0 faces, centred 2.6 faces below the eyes. That is a fair guess about a
 * person and no guess at all about a CAMERA, and the camera is the half that breaks.
 *
 * Measured against the shipping default, on a 16:9 frame with the face at the usual height:
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
 * The minimums came down with the easy-circle calibration (1.4 → 1.2 wide, 1.0 → 0.8 tall):
 * they are checked on the box AFTER the comfort shrink, and a relaxed circle traced by a small
 * person, flattened into the ellipse most people draw when they are not trying, sits right
 * around a face high once 80% of it is taken. That is a small box and a high gain, but it is
 * the visitor's own movement; the stillness step that follows measures what the gain does to
 * the noise and sets the filter for it.
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
 * `comfort` scales the fitted extent about its own centre, 0..1. The sweep is an easy circle
 * now rather than a maximal reach, so the box is deliberately made SMALLER than the movement:
 * a rectangle inscribed in the traced circle, not the rectangle around it, which is what puts
 * the screen's corners inside a reach the visitor has already shown to be comfortable. The
 * centre and the clipping verdicts are unaffected — they are facts about where the camera can
 * see, and shrinking the box changes nothing about that.
 */
export function fitReach(
  samples: ReachSample[],
  aspect: number,
  { comfort = 1 }: { comfort?: number } = {},
): ReachFit | null {
  if (samples.length < MIN_SAMPLES || !Number.isFinite(aspect) || aspect <= 0) return null;
  if (!(comfort > 0 && comfort <= 1)) return null;

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

  // Shrink about the centre, AFTER the edge correction: the clipping is about where the frame
  // ends and has to be judged on the real extent, not the reduced one.
  if (comfort < 1) {
    const cu = (uLo + uHi) / 2;
    const cv = (vLo + vHi) / 2;
    uLo = cu + (uLo - cu) * comfort;
    uHi = cu + (uHi - cu) * comfort;
    vLo = cv + (vLo - cv) * comfort;
    vHi = cv + (vHi - cv) * comfort;
  }

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
 * How many times round the hand has gone — the sweep step's progress bar, and its finish line.
 *
 * This replaced a coverage score, and the reason is in the review that asked for it: "the
 * circle is exhausting, and sometimes one is not enough". The old finish line was three
 * conditions at once — twelve sectors visited, AND a width of 2.6 face widths, AND a height of
 * 1.7 — so a careful, comfortable circle failed on extent, and the visitor was told to keep
 * going without being told what was missing. Worse, the WIDTH condition was the instruction:
 * "draw the biggest circle you can" was there to make the extent conditions passable, and
 * that is what made it tiring. A measurement that requires people to strain is measuring the
 * strain.
 *
 * Now the only thing asked for is a closed loop, twice. The extent is whatever the visitor
 * found comfortable, and the screen is fitted to THAT (see `COMFORT`). Angular travel is summed
 * around the sweep's own centroid, in whole revolutions, ignoring any frame that jumps more
 * than a quarter turn (a tracking glitch, not a hand) and any sample sitting so close to the
 * centre that its angle is noise. Signed, so a to-and-fro cancels. Recomputed from scratch each frame, which is cheap at the
 * sizes involved and avoids the running-centroid problem where the first lap is measured
 * against a centre that has not yet been found.
 */
export function laps(sweep: ReachSample[]): number {
  if (sweep.length < 15) return 0;
  let cu = 0;
  let cv = 0;
  for (const s of sweep) {
    cu += s.u;
    cv += s.v;
  }
  cu /= sweep.length;
  cv /= sweep.length;
  // Ignore samples inside a tenth of the sweep's own typical radius: their angle is undefined.
  let rSum = 0;
  for (const s of sweep) rSum += Math.hypot(s.u - cu, s.v - cv);
  const rMin = (rSum / sweep.length) * 0.1;
  let travelled = 0;
  let prev = Number.NaN;
  for (const s of sweep) {
    const du = s.u - cu;
    const dv = s.v - cv;
    if (Math.hypot(du, dv) < rMin) continue;
    const a = Math.atan2(dv, du);
    if (Number.isFinite(prev)) {
      let d = a - prev;
      if (d > Math.PI) d -= 2 * Math.PI;
      else if (d < -Math.PI) d += 2 * Math.PI;
      // SIGNED, so that going out and coming back along the same path sums to nothing: a
      // hand waving side to side is not going round, however long it does it. Either
      // direction round is fine — the sign only has to be consistent within one sweep.
      if (Math.abs(d) < Math.PI / 2) travelled += d;
    }
    prev = a;
  }
  return Math.abs(travelled) / (2 * Math.PI);
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
