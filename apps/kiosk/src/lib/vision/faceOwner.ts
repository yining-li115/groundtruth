import type { FaceResult, Landmark } from "./mediapipe";

/**
 * Associate one face with the stable hand owner and keep that identity through detector
 * reordering and short dropouts. Face size is the pointer's ruler, so choosing the largest
 * face in a two-person frame would combine one person's hand with another person's scale.
 */
export interface FaceOwnerConfig {
  missingHoldMs: number;
  maxCenterJump: number;
  matchFaceWidths: number;
  maxScaleRatio: number;
  minFacePalmRatio: number;
  maxFacePalmRatio: number;
  maxHandDistanceFaces: number;
}

export const DEFAULT_FACE_OWNER: FaceOwnerConfig = {
  missingHoldMs: 650,
  maxCenterJump: 0.1,
  matchFaceWidths: 1.4,
  maxScaleRatio: 2,
  minFacePalmRatio: 0.9,
  maxFacePalmRatio: 9,
  maxHandDistanceFaces: 7,
};

interface FaceTrack {
  ownerId: number;
  face: FaceResult;
  lastSeenAtMs: number;
}

function validFace(face: FaceResult): boolean {
  return (
    [face.cx, face.cy, face.w, face.h, face.score].every(Number.isFinite) &&
    face.w > 0 &&
    face.h > 0
  );
}

export class StableOwnerFace {
  private readonly cfg: FaceOwnerConfig;
  private track: FaceTrack | null = null;

  constructor(config: Partial<FaceOwnerConfig> = {}) {
    this.cfg = { ...DEFAULT_FACE_OWNER, ...config };
  }

  update(
    faces: FaceResult[],
    ownerId: number | null,
    wrist: Landmark | null,
    palmSpan: number,
    atMs: number,
    aspect = 1,
  ): FaceResult | null {
    const candidates = faces.filter(validFace);
    if (ownerId === null) {
      this.track = null;
      return null;
    }

    if (this.track?.ownerId === ownerId) {
      const continued = this.matchTrack(this.track.face, candidates, aspect);
      if (continued) {
        this.track.face = continued;
        this.track.lastSeenAtMs = atMs;
        return continued;
      }
      // Do not jump to a bystander's face just because the owner's detector blinked. The
      // downstream FaceAnchor holds the last good ruler during this reservation.
      if (atMs - this.track.lastSeenAtMs <= this.cfg.missingHoldMs) return null;
      this.track = null;
    } else {
      this.track = null;
    }

    if (!wrist || !Number.isFinite(wrist.x) || !Number.isFinite(wrist.y) || !(palmSpan > 0)) {
      return null;
    }
    const associated = this.associate(candidates, wrist, palmSpan, aspect);
    if (!associated) return null;
    this.track = { ownerId, face: associated, lastSeenAtMs: atMs };
    return associated;
  }

  reset(): void {
    this.track = null;
  }

  private matchTrack(previous: FaceResult, faces: FaceResult[], aspect: number): FaceResult | null {
    const safeAspect = Number.isFinite(aspect) && aspect > 0 ? aspect : 1;
    let best: FaceResult | null = null;
    let bestCost = Number.POSITIVE_INFINITY;
    for (const face of faces) {
      const distance = Math.hypot(
        face.cx - previous.cx,
        (face.cy - previous.cy) / safeAspect,
      );
      const radius = Math.max(
        this.cfg.maxCenterJump,
        Math.max(face.w, previous.w) * this.cfg.matchFaceWidths,
      );
      const scaleRatio = Math.max(face.w, previous.w) / Math.min(face.w, previous.w);
      if (distance > radius || scaleRatio > this.cfg.maxScaleRatio) continue;
      const cost = distance + Math.abs(Math.log(face.w / previous.w)) * 0.08;
      if (cost < bestCost) {
        best = face;
        bestCost = cost;
      }
    }
    return best;
  }

  private associate(
    faces: FaceResult[],
    wrist: Landmark,
    palmSpan: number,
    aspect: number,
  ): FaceResult | null {
    const safeAspect = Number.isFinite(aspect) && aspect > 0 ? aspect : 1;
    let best: FaceResult | null = null;
    let bestCost = Number.POSITIVE_INFINITY;
    for (const face of faces) {
      const ratio = face.w / palmSpan;
      if (ratio < this.cfg.minFacePalmRatio || ratio > this.cfg.maxFacePalmRatio) continue;
      const dxFaces = (wrist.x - face.cx) / face.w;
      const dyFaces =
        ((wrist.y - face.cy) / safeAspect) /
        Math.max(face.h / safeAspect, face.w);
      const distance = Math.hypot(dxFaces, dyFaces);
      if (distance > this.cfg.maxHandDistanceFaces) continue;
      // Proximity dominates. The weak scale prior only breaks ambiguous two-person ties.
      const scaleCost = Math.abs(Math.log(ratio / 2.5)) * 0.18;
      const confidenceCost = (1 - Math.max(0, Math.min(1, face.score))) * 0.08;
      const cost = distance + scaleCost + confidenceCost;
      if (cost < bestCost) {
        best = face;
        bestCost = cost;
      }
    }
    return best;
  }
}
