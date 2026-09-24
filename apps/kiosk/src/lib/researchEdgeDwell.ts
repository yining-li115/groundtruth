/** The two edge intents exposed by the Research carousel. */
export type ResearchEdge = "left" | "right";

export interface ResearchEdgeDwellConfig {
  /** Enter an edge zone at or beyond these screen fractions. */
  leftEnter: number;
  rightEnter: number;
  /** A fired edge remains locked until the hand returns inside this neutral band. */
  neutralLeft: number;
  neutralRight: number;
  dwellMs: number;
}

export const DEFAULT_RESEARCH_EDGE_DWELL: ResearchEdgeDwellConfig = {
  // These are the same broad side zones proven by Calibration. A device must never pass
  // setup and then discover that Research asks for another 7% of unreachable travel.
  leftEnter: 0.22,
  rightEnter: 0.78,
  // Require an unmistakable trip back toward the centre before the next page can fire.
  neutralLeft: 0.3,
  neutralRight: 0.7,
  dwellMs: 600,
};

export interface ResearchEdgeDwellState {
  /** Partial dwell and one-shot locks never cross a stable hand-owner boundary. */
  ownerId: number | null;
  candidate: ResearchEdge | null;
  candidateSince: number;
  /** One edge visit may advance exactly once. */
  locked: boolean;
  progress: number;
}

export interface ResearchEdgeDwellResult {
  state: ResearchEdgeDwellState;
  fired: ResearchEdge | null;
}

export const initialResearchEdgeDwell = (
  ownerId: number | null = null,
): ResearchEdgeDwellState => ({
  ownerId,
  candidate: null,
  candidateSince: 0,
  locked: false,
  progress: 0,
});

const edgeAt = (x: number, cfg: ResearchEdgeDwellConfig): ResearchEdge | null => {
  if (!Number.isFinite(x)) return null;
  if (x <= cfg.leftEnter) return "left";
  if (x >= cfg.rightEnter) return "right";
  return null;
};

/**
 * Advance Research's local open-hand edge dwell.
 *
 * This is intentionally not the global pointer dwell: pausing over ordinary content must never
 * click it. Research alone owns this spatial grammar, and after firing it requires a return to
 * the neutral band before either edge can fire again. Tracking loss clears partial progress but
 * does not manufacture a re-arm at the edge.
 */
export function advanceResearchEdgeDwell(
  previous: ResearchEdgeDwellState,
  input: { x: number; at: number; eligible: boolean; ownerId: number | null },
  config: ResearchEdgeDwellConfig = DEFAULT_RESEARCH_EDGE_DWELL,
): ResearchEdgeDwellResult {
  const cfg = config;
  const at = Number.isFinite(input.at) ? input.at : 0;
  const inputOwner = Number.isFinite(input.ownerId) ? input.ownerId : null;
  // The global router already treats an owner change as an identity boundary. Research has a
  // local spatial grammar, so it must enforce the same rule instead of allowing a newcomer to
  // inherit somebody else's 500ms of progress (or their post-click lock).
  let current = previous;
  if (
    input.eligible &&
    inputOwner !== null &&
    previous.ownerId !== null &&
    inputOwner !== previous.ownerId
  ) {
    current = initialResearchEdgeDwell(inputOwner);
  } else if (input.eligible && inputOwner !== null && previous.ownerId === null) {
    current = { ...previous, ownerId: inputOwner };
  }
  const inNeutral =
    Number.isFinite(input.x) &&
    input.x >= cfg.neutralLeft &&
    input.x <= cfg.neutralRight;

  if (current.locked) {
    if (!input.eligible || !inNeutral) {
      return {
        state: { ...current, candidate: null, candidateSince: 0, progress: 0 },
        fired: null,
      };
    }
    return { state: initialResearchEdgeDwell(inputOwner), fired: null };
  }

  if (!input.eligible) {
    return {
      state: { ...current, candidate: null, candidateSince: 0, progress: 0 },
      fired: null,
    };
  }

  const edge = edgeAt(input.x, cfg);
  if (!edge) return { state: initialResearchEdgeDwell(inputOwner), fired: null };

  if (current.candidate !== edge || current.candidateSince <= 0 || at < current.candidateSince) {
    return {
      state: {
        ownerId: inputOwner,
        candidate: edge,
        candidateSince: at,
        locked: false,
        progress: 0,
      },
      fired: null,
    };
  }

  const progress = Math.max(0, Math.min(1, (at - current.candidateSince) / cfg.dwellMs));
  if (progress < 1) {
    return {
      state: { ...current, progress },
      fired: null,
    };
  }

  return {
    state: {
      ownerId: inputOwner,
      candidate: null,
      candidateSince: 0,
      locked: true,
      progress: 0,
    },
    fired: edge,
  };
}
