/** The five broad mapped regions installation setup must prove reachable. */
export type CalibrationZone = "center" | "left" | "right" | "up" | "down";

/**
 * The exact screen-space bands used by both the final proof and its on-screen map.
 *
 * They intentionally leave the diagonal corners and a small gap between centre/edge bands
 * unassigned. Entering a band therefore proves one independent axis of mapped reach instead of
 * letting one ambiguous diagonal sample satisfy two directions. Keep this single source of truth:
 * a drawn target that differs from the classifier is indistinguishable from broken tracking.
 */
export const VALIDATION_REGIONS: Readonly<
  Record<CalibrationZone, Readonly<{ x0: number; y0: number; x1: number; y1: number }>>
> = {
  center: { x0: 0.32, y0: 0.3, x1: 0.68, y1: 0.7 },
  left: { x0: 0, y0: 0.3, x1: 0.22, y1: 0.7 },
  right: { x0: 0.78, y0: 0.3, x1: 1, y1: 0.7 },
  up: { x0: 0.3, y0: 0, x1: 0.7, y1: 0.22 },
  down: { x0: 0.3, y0: 0.78, x1: 0.7, y1: 1 },
};

/**
 * A few consecutive decoded samples are enough to prove entry into a broad band. Stage 1 already
 * measured stillness; repeating a long stillness test here made a valid mapped cursor feel dead.
 */
export const VALIDATION_DWELL_MS = 180;

/** Keep an entered band through ordinary mapped-cursor shimmer, without widening its entry. */
export const VALIDATION_EXIT_MARGIN = 0.06;

export interface ValidationDwellState {
  candidate: CalibrationZone | null;
  heldMs: number;
}

export interface ValidationDwellStep extends ValidationDwellState {
  /** Set for one step when the candidate has survived the complete dwell. */
  confirmed: CalibrationZone | null;
}

export interface GestureProof {
  /** A production-confirmed press is currently being held. */
  confirmedClosed: boolean;
  /** Number of complete confirmed press -> explicit open-hand cycles. */
  cycles: number;
}

/**
 * Advance the calibration gesture proof from the same debounced state production consumes.
 *
 * `confirmedHeld` must be `HandPointer.state.pinched`, not the recogniser's provisional
 * `rawHeld`: a short classifier pulse can cross the raw latch without surviving the production
 * press debounce and therefore must never make setup claim that clicking works. A release is
 * counted only with positive open-hand evidence; an unknown/occluded frame cancels the attempt.
 */
export function advanceGestureProof(
  proof: GestureProof,
  confirmedHeld: boolean,
  posture: "open" | "closed" | "unknown",
): GestureProof {
  if (!proof.confirmedClosed) {
    return confirmedHeld ? { ...proof, confirmedClosed: true } : proof;
  }
  if (confirmedHeld) return proof;
  if (posture === "open") {
    return { confirmedClosed: false, cycles: proof.cycles + 1 };
  }
  return { ...proof, confirmedClosed: false };
}

/**
 * Classify mapped screen coordinates into a broad validation region.
 *
 * Corners deliberately match no region: setup proves independent horizontal and vertical reach
 * without asking a hand to visit the camera's least reliable diagonal extremes.
 */
export function validationZone(
  u: number,
  v: number,
  completed: readonly CalibrationZone[] = [],
): CalibrationZone | null {
  if (!Number.isFinite(u) || !Number.isFinite(v)) return null;
  const candidates = (Object.keys(VALIDATION_REGIONS) as CalibrationZone[]).map((id) => {
    const region = VALIDATION_REGIONS[id];
    return {
      id,
      valid: inValidationZone(id, u, v),
      x: (region.x0 + region.x1) / 2,
      y: (region.y0 + region.y1) / 2,
    };
  });
  return (
    candidates
      .filter((candidate) => candidate.valid && !completed.includes(candidate.id))
      .sort(
        (a, b) =>
          Math.hypot(u - a.x, v - a.y) - Math.hypot(u - b.x, v - b.y),
      )[0]?.id ?? null
  );
}

/**
 * Advance the final reachability proof using the same stabilised mapped position as production.
 *
 * Unlike the installation-range samples, this stage is not measuring a precise point: it only
 * proves that each broad region can be reached. Requiring a second stillness/noise test here made
 * the setup reject a cursor which was already stable enough for the kiosk itself. A small exit
 * margin keeps normal boundary shimmer from erasing a deliberate dwell, while a different region,
 * an invalid sample, owner loss, or a stale source can still reset the candidate immediately.
 */
export function advanceValidationDwell(
  state: ValidationDwellState,
  sample: { u: number; v: number } | null,
  completed: readonly CalibrationZone[] = [],
  elapsedMs = 0,
  holdMs = VALIDATION_DWELL_MS,
): ValidationDwellStep {
  const validSample =
    sample && Number.isFinite(sample.u) && Number.isFinite(sample.v) ? sample : null;
  if (!validSample) return { candidate: null, heldMs: 0, confirmed: null };

  const prior =
    state.candidate && !completed.includes(state.candidate) ? state.candidate : null;
  const candidate =
    prior && inValidationZone(prior, validSample.u, validSample.v, VALIDATION_EXIT_MARGIN)
      ? prior
      : validationZone(validSample.u, validSample.v, completed);
  if (!candidate) return { candidate: null, heldMs: 0, confirmed: null };

  // Entering a region starts its clock at zero. Time since the previous sample may have been
  // spent outside it, so crediting that interval would let a fast sweep count as a hold.
  if (candidate !== prior) return { candidate, heldMs: 0, confirmed: null };

  // One delayed decoder result cannot back-fill an entire proof. Calibration's caller also
  // rejects gaps above its freshness boundary; this local cap keeps the pure primitive safe.
  const safeElapsed = Number.isFinite(elapsedMs) ? Math.min(100, Math.max(0, elapsedMs)) : 0;
  const nextHeld = state.heldMs + safeElapsed;
  if (nextHeld >= Math.max(1, holdMs)) {
    return { candidate: null, heldMs: 0, confirmed: candidate };
  }
  return { candidate, heldMs: nextHeld, confirmed: null };
}

function inValidationZone(
  zone: CalibrationZone,
  u: number,
  v: number,
  margin = 0,
): boolean {
  const region = VALIDATION_REGIONS[zone];
  return (
    u >= region.x0 - margin &&
    u <= region.x1 + margin &&
    v >= region.y0 - margin &&
    v <= region.y1 + margin
  );
}
