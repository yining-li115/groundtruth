import { JOINT, type Landmark } from "./mediapipe";

/**
 * Every candidate pinch feature, computed side by side from one frame. MEASUREMENT ONLY —
 * nothing here decides anything, and the production detector still thresholds `ratioWorld3D`.
 *
 * The point of computing all of them at once is that they can then be compared on the SAME
 * hand in the SAME frame. The kiosk's pinch fails often enough that a replacement feature is
 * plausible, and the only honest way to choose one is to watch a real pinch, at a real
 * distance, produce all of them together.
 *
 * WHAT THE PRODUCTION FEATURE IS, precisely, because it is easy to describe it too kindly:
 *
 *   ratioWorld3D = |thumbTip − indexTip|₃  /  |indexMCP − pinkyMCP|₃      (world, metres)
 *
 * It IS scale-normalised — dividing by the palm span cancels distance from the lens and hand
 * size both, which is the thing a fixed threshold needs — so the common accusation against it
 * is wrong. The suspicion is narrower and it is about the subscript: both distances are taken
 * in THREE dimensions, and z is the one axis MediaPipe does not measure. It is regressed from
 * a single view by a model that carries a strong prior that fingers do not interpenetrate, so
 * two fingertips that are touching in the image can still be handed back a centimetre apart
 * in depth. The aperture then never collapses, and the recorded evidence says exactly that:
 * a pinch CLOSED AND HELD sits at ratio ≈ 0.758 rather than near zero
 * (`scripts/fixtures/pinch-trials.json`), which is why the ON threshold had to be dragged up
 * to 0.74 and why it sits a hair's breadth from the open-hand noise floor.
 *
 * So the candidates below drop z, in the two different ways it can be dropped:
 *
 *   ratioWorld2D — same world landmarks, z simply omitted. Keeps the model's metric scale.
 *   ratioPx      — the image plane and nothing else: pixel distance between the two fingertips
 *                  over pixel distance between the knuckles. This is the feature that cannot
 *                  contain an inferred number; every quantity in it was seen by the sensor.
 *
 * `aperturePx` is reported raw alongside them, because it is the quantity the OPTICS limit
 * applies to. Once two fingertips are a handful of pixels apart, no ratio, filter or threshold
 * recovers what the lens did not resolve — and that is the finding the whole audit exists to
 * either confirm or rule out.
 */
export interface PinchFeatures {
  /** PRODUCTION FEATURE: world 3D aperture / world 3D palm span. Thresholded at PINCH_ON/OFF. */
  ratioWorld3D: number;
  /** Candidate: the same, with z dropped. Same scale normalisation, no inferred depth. */
  ratioWorld2D: number;
  /** Candidate: image-plane pixel aperture / pixel palm span. Nothing inferred at all. */
  ratioPx: number;

  /** thumbTip→indexTip in metres (world, 3D) — the numerator of the production feature */
  apertureWorldM: number;
  /** ...and with z dropped */
  apertureWorld2DM: number;
  /** how much of that 3D aperture is pure z. Large under a closed pinch = the suspected fault. */
  apertureZM: number;
  /** indexMCP→pinkyMCP in metres (world, 3D) — the scale reference */
  spanWorldM: number;
  spanWorld2DM: number;

  /** thumbTip→indexTip in CAMERA PIXELS. The optics-limited quantity. */
  aperturePx: number;
  /** indexMCP→pinkyMCP in camera pixels — how much hand the sensor actually captured */
  spanPx: number;
  /** the same palm span, as a fraction of frame width (what `confidence` is fed) */
  spanNorm: number;

  /** the hand's whole landmark bounding box, in camera pixels */
  boxPx: { w: number; h: number };
  /** fingertips in camera pixels, raw (un-mirrored) frame orientation */
  thumbPx: { x: number; y: number };
  indexPx: { x: number; y: number };
}

const NO_FEATURES: PinchFeatures = {
  ratioWorld3D: Number.NaN,
  ratioWorld2D: Number.NaN,
  ratioPx: Number.NaN,
  apertureWorldM: Number.NaN,
  apertureWorld2DM: Number.NaN,
  apertureZM: Number.NaN,
  spanWorldM: Number.NaN,
  spanWorld2DM: Number.NaN,
  aperturePx: Number.NaN,
  spanPx: Number.NaN,
  spanNorm: Number.NaN,
  boxPx: { w: Number.NaN, h: Number.NaN },
  thumbPx: { x: Number.NaN, y: Number.NaN },
  indexPx: { x: Number.NaN, y: Number.NaN },
};

const d3 = (a: Landmark, b: Landmark) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
const d2 = (a: Landmark, b: Landmark) => Math.hypot(a.x - b.x, a.y - b.y);

/**
 * Compute every candidate feature for one hand.
 *
 * `frameW`/`frameH` are the video's TRUE pixel dimensions (`video.videoWidth/videoHeight`) —
 * never the requested constraint and never a hard-coded 1280. Normalised landmarks say
 * nothing about how many pixels a thing spans, so the pixel columns are only as honest as
 * this pair is.
 */
export function pinchFeatures(
  hand: { landmarks: Landmark[]; world: Landmark[] } | null | undefined,
  frameW: number,
  frameH: number,
): PinchFeatures {
  if (!hand) return NO_FEATURES;
  const lm = hand.landmarks;
  const w = hand.world;
  const t = lm?.[JOINT.thumbTip];
  const i = lm?.[JOINT.indexTip];
  const m = lm?.[JOINT.indexMcp];
  const p = lm?.[JOINT.pinkyMcp];
  if (!t || !i || !m || !p) return NO_FEATURES;

  const W = frameW > 0 ? frameW : Number.NaN;
  const H = frameH > 0 ? frameH : Number.NaN;
  const px = (a: Landmark) => ({ x: a.x * W, y: a.y * H });
  const dpx = (a: Landmark, b: Landmark) => Math.hypot((a.x - b.x) * W, (a.y - b.y) * H);

  const aperturePx = dpx(t, i);
  const spanPx = dpx(m, p);

  let bx0 = Infinity;
  let by0 = Infinity;
  let bx1 = -Infinity;
  let by1 = -Infinity;
  for (const q of lm) {
    if (q.x < bx0) bx0 = q.x;
    if (q.y < by0) by0 = q.y;
    if (q.x > bx1) bx1 = q.x;
    if (q.y > by1) by1 = q.y;
  }

  const wt = w?.[JOINT.thumbTip];
  const wi = w?.[JOINT.indexTip];
  const wm = w?.[JOINT.indexMcp];
  const wp = w?.[JOINT.pinkyMcp];
  const hasWorld = !!(wt && wi && wm && wp);

  const apertureWorldM = hasWorld ? d3(wt, wi) : Number.NaN;
  const apertureWorld2DM = hasWorld ? d2(wt, wi) : Number.NaN;
  const spanWorldM = hasWorld ? d3(wm, wp) : Number.NaN;
  const spanWorld2DM = hasWorld ? d2(wm, wp) : Number.NaN;

  return {
    ratioWorld3D: apertureWorldM / spanWorldM,
    ratioWorld2D: apertureWorld2DM / spanWorld2DM,
    ratioPx: aperturePx / spanPx,
    apertureWorldM,
    apertureWorld2DM,
    apertureZM: hasWorld ? Math.abs(wt.z - wi.z) : Number.NaN,
    spanWorldM,
    spanWorld2DM,
    aperturePx,
    spanPx,
    spanNorm: Math.hypot(m.x - p.x, m.y - p.y),
    boxPx: { w: (bx1 - bx0) * W, h: (by1 - by0) * H },
    thumbPx: px(t),
    indexPx: px(i),
  };
}

export { NO_FEATURES };
