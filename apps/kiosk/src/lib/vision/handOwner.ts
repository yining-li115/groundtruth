import { JOINT, type HandResult } from "./mediapipe";

/**
 * A MediaPipe hand array is a set of detections, not a list of identities. Its order may change
 * whenever a second hand appears, so `hands[0]` is not a safe interaction owner. This tracker
 * keeps one owner by spatial continuity and deliberately returns no hand during a short gap:
 * another visible hand may not steal an in-progress gesture just because the owner's landmarks
 * blinked for a frame.
 */

export interface HandOwnerConfig {
  /** Keep the identity reserved this long while its landmarks are absent. */
  missingHoldMs: number;
  /** Absolute frame-space jump accepted between observations. */
  maxMatchDistance: number;
  /** Palm widths also buy matching room for a fast, nearby hand. */
  matchPalmWidths: number;
  /** Reject implausible scale jumps even if the wrists happen to overlap. */
  maxScaleRatio: number;
}

export const DEFAULT_HAND_OWNER: HandOwnerConfig = {
  missingHoldMs: 280,
  maxMatchDistance: 0.12,
  matchPalmWidths: 4.5,
  maxScaleRatio: 2.5,
};

export type HandOwnerPhase = "none" | "tracked" | "missing";

export interface HandOwnerSelection {
  ownerId: number | null;
  /** The selected owner this frame. Null while the owner is reserved but not visible. */
  hand: HandResult | null;
  /** Index in the original MediaPipe array; -1 when the owner is not visible. */
  selectedIndex: number;
  visible: boolean;
  phase: HandOwnerPhase;
  /** True only when an existing identity was replaced by a new one. */
  changed: boolean;
  previousOwnerId: number | null;
  handedness: string | null;
  acquiredAtMs: number;
  lastSeenAtMs: number;
}

interface Candidate {
  hand: HandResult;
  index: number;
  x: number;
  y: number;
  span: number;
}

interface OwnerTrack {
  id: number;
  x: number;
  y: number;
  span: number;
  handedness: string;
  acquiredAtMs: number;
  lastSeenAtMs: number;
}

function candidate(hand: HandResult, index: number, aspect: number): Candidate | null {
  const wrist = hand.landmarks[JOINT.wrist];
  const a = hand.landmarks[JOINT.indexMcp];
  const b = hand.landmarks[JOINT.pinkyMcp];
  if (!wrist || !a || !b) return null;
  if (![wrist.x, wrist.y, a.x, a.y, b.x, b.y].every(Number.isFinite)) return null;
  const safeAspect = Number.isFinite(aspect) && aspect > 0 ? aspect : 1;
  const span = Math.hypot(a.x - b.x, (a.y - b.y) / safeAspect);
  if (!(span > 1e-5)) return null;
  return { hand, index, x: wrist.x, y: wrist.y / safeAspect, span };
}

function initialCandidate(candidates: Candidate[], aspect: number): Candidate | null {
  if (!candidates.length) return null;
  const safeAspect = Number.isFinite(aspect) && aspect > 0 ? aspect : 1;
  // The intended visitor's hand is normally the largest one in a corridor camera. Centrality
  // only breaks near-ties, so a small background hand cannot win merely by being in the middle.
  return [...candidates].sort((a, b) => {
    const scale = b.span - a.span;
    if (Math.abs(scale) > Math.max(a.span, b.span) * 0.08) return scale;
    const centreY = 0.5 / safeAspect;
    const da = Math.hypot(a.x - 0.5, a.y - centreY);
    const db = Math.hypot(b.x - 0.5, b.y - centreY);
    return da - db;
  })[0] ?? null;
}

/** Stable single-owner selection, independent of MediaPipe result ordering. */
export class StableHandOwner {
  private readonly cfg: HandOwnerConfig;
  private track: OwnerTrack | null = null;
  private nextId = 1;

  constructor(cfg: Partial<HandOwnerConfig> = {}) {
    this.cfg = { ...DEFAULT_HAND_OWNER, ...cfg };
  }

  update(
    hands: HandResult[],
    atMs: number,
    aspect = 1,
    missingHoldMs = this.cfg.missingHoldMs,
  ): HandOwnerSelection {
    const candidates = hands
      .map((hand, index) => candidate(hand, index, aspect))
      .filter((item): item is Candidate => item !== null);

    const previous = this.track;
    if (previous) {
      const match = this.match(previous, candidates);
      if (match) {
        previous.x = match.x;
        previous.y = match.y;
        previous.span = match.span;
        // Handedness occasionally flickers to an empty string; do not erase a useful prior.
        if (match.hand.handedness) previous.handedness = match.hand.handedness;
        previous.lastSeenAtMs = atMs;
        return this.selection(previous, match, false, null);
      }

      const reservationMs = Number.isFinite(missingHoldMs)
        ? Math.max(this.cfg.missingHoldMs, missingHoldMs)
        : this.cfg.missingHoldMs;
      if (atMs - previous.lastSeenAtMs <= reservationMs) {
        return this.selection(previous, null, false, null);
      }

      this.track = null;
    }

    const first = initialCandidate(candidates, aspect);
    if (!first) {
      return {
        ownerId: null,
        hand: null,
        selectedIndex: -1,
        visible: false,
        phase: "none",
        changed: false,
        previousOwnerId: previous?.id ?? null,
        handedness: null,
        acquiredAtMs: 0,
        lastSeenAtMs: 0,
      };
    }

    const next: OwnerTrack = {
      id: this.nextId++,
      x: first.x,
      y: first.y,
      span: first.span,
      handedness: first.hand.handedness,
      acquiredAtMs: atMs,
      lastSeenAtMs: atMs,
    };
    this.track = next;
    return this.selection(next, first, !!previous, previous?.id ?? null);
  }

  reset(): number | null {
    const previous = this.track?.id ?? null;
    this.track = null;
    return previous;
  }

  private match(owner: OwnerTrack, candidates: Candidate[]): Candidate | null {
    let best: Candidate | null = null;
    let bestCost = Number.POSITIVE_INFINITY;
    for (const item of candidates) {
      const distance = Math.hypot(item.x - owner.x, item.y - owner.y);
      const radius = Math.max(
        this.cfg.maxMatchDistance,
        Math.min(0.3, Math.max(owner.span, item.span) * this.cfg.matchPalmWidths),
      );
      const scaleRatio = Math.max(owner.span, item.span) / Math.min(owner.span, item.span);
      if (distance > radius || scaleRatio > this.cfg.maxScaleRatio) continue;

      // Handedness is a hint, not an identity: MediaPipe can flip it for an edge-on hand.
      const handednessPenalty =
        owner.handedness && item.hand.handedness && owner.handedness !== item.hand.handedness
          ? 0.08
          : 0;
      const scalePenalty = Math.abs(Math.log(item.span / owner.span)) * 0.04;
      const cost = distance + handednessPenalty + scalePenalty;
      if (cost < bestCost) {
        best = item;
        bestCost = cost;
      }
    }
    return best;
  }

  private selection(
    owner: OwnerTrack,
    selected: Candidate | null,
    changed: boolean,
    previousOwnerId: number | null,
  ): HandOwnerSelection {
    return {
      ownerId: owner.id,
      hand: selected?.hand ?? null,
      selectedIndex: selected?.index ?? -1,
      visible: !!selected,
      phase: selected ? "tracked" : "missing",
      changed,
      previousOwnerId,
      handedness: owner.handedness || null,
      acquiredAtMs: owner.acquiredAtMs,
      lastSeenAtMs: owner.lastSeenAtMs,
    };
  }
}
