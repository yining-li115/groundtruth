/** The five broad mapped regions installation setup must prove reachable. */
export type CalibrationZone = "center" | "left" | "right" | "up" | "down";

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
  const candidates: Array<{
    id: CalibrationZone;
    valid: boolean;
    x: number;
    y: number;
  }> = [
    {
      id: "center",
      valid: Math.abs(u - 0.5) <= 0.18 && Math.abs(v - 0.5) <= 0.2,
      x: 0.5,
      y: 0.5,
    },
    // Keep the perpendicular axis central so diagonal points cannot satisfy two directions.
    { id: "left", valid: u <= 0.22 && v >= 0.3 && v <= 0.7, x: 0.08, y: 0.5 },
    { id: "right", valid: u >= 0.78 && v >= 0.3 && v <= 0.7, x: 0.92, y: 0.5 },
    { id: "up", valid: v <= 0.22 && u >= 0.3 && u <= 0.7, x: 0.5, y: 0.08 },
    { id: "down", valid: v >= 0.78 && u >= 0.3 && u <= 0.7, x: 0.5, y: 0.92 },
  ];
  return (
    candidates
      .filter((candidate) => candidate.valid && !completed.includes(candidate.id))
      .sort(
        (a, b) =>
          Math.hypot(u - a.x, v - a.y) - Math.hypot(u - b.x, v - b.y),
      )[0]?.id ?? null
  );
}
