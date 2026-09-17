import type { Landmark } from "./mediapipe";

/**
 * Camera grammar locked for one scene session.
 *
 * Production uses `explore`: a stable open hand is a centred joystick, with horizontal
 * position controlling turn rate and vertical position controlling forward/back travel.
 * `look` and `move` remain available to the Spark authoring tool and deterministic tests, but
 * visitors are never asked to pick a mode before exploring.
 */
export type SceneMode = "explore" | "look" | "move";
export type SceneAvailability = "loading" | "ready" | "failed" | "unavailable";

/**
 * Why a scene grab ended.
 *
 * `released` is the sole normal ending. Every other value is a cancellation and must stop
 * motion without manufacturing a click, a fling, or a second interaction.
 */
export type SceneEndReason =
  | "released"
  | "hand-lost"
  | "stale"
  | "owner-changed"
  | "timeout"
  | "mode-changed"
  | "calibration"
  | "scene-unavailable"
  | "target-detached"
  | "unmount"
  | "cancelled";

/**
 * One scene-control session, published by the unified hand loop and consumed by the render
 * loop. Coordinates always use visitor-facing axes:
 *
 *   x: positive to the visitor's right
 *   y: positive upward
 *
 * The object is mutated in place so Three's render loop can read it without making React
 * render at camera rate. `active` is authority; merely seeing a hand is deliberately not.
 */
export interface SceneIntent {
  /** User-visible lifecycle; unlike `ready`, distinguishes a load in progress from failure. */
  availability: SceneAvailability;
  /** The Gaussian scene can only accept sessions once its real camera pose is installed. */
  ready: boolean;
  /** A routed scene session owns the camera (open-hand Explore in production). */
  active: boolean;
  /** Monotonically increasing input session. Zero means no scene session has begun yet. */
  sessionId: number;
  /** Stable tracked-hand identity. A different owner may never continue this session. */
  ownerId: number | null;
  /** Sequence number of the newest real camera sample applied to this intent. */
  seq: number;
  /** Monotonic timestamp of that sample, used by the renderer's independent stale watchdog. */
  freshAt: number;
  /** Result-age budget measured from the active laptop's real inference cadence. */
  freshForMs: number;
  /** Locked for the lifetime of a session; production always resets this to `explore`. */
  mode: SceneMode;
  /**
   * Explore uses calibrated, centre-relative screen axes in [-1, 1]. Authoring LOOK/MOVE use
   * palm-normalised displacement from their clutch origin.
   */
  dx: number;
  dy: number;
  /** Optional source velocity for diagnostic/authoring modes. */
  vx: number;
  vy: number;
  /** Persists after an end for diagnostics; cleared by the next successful begin. */
  endReason: SceneEndReason | null;
  /** Optional visual feedback only. Never used to authorize or integrate camera movement. */
  hands: Landmark[][];
}

export interface SceneBegin {
  sessionId: number;
  ownerId: number;
  seq: number;
  freshAt: number;
  freshForMs: number;
  hands?: Landmark[][];
}

export interface SceneUpdate extends SceneBegin {
  dx: number;
  dy: number;
  vx: number;
  vy: number;
}

export const flightInput: SceneIntent = {
  availability: "loading",
  ready: false,
  active: false,
  sessionId: 0,
  ownerId: null,
  seq: 0,
  freshAt: 0,
  freshForMs: 120,
  mode: "explore",
  dx: 0,
  dy: 0,
  vx: 0,
  vy: 0,
  endReason: null,
  hands: [],
};

/** A final defence against corrupt landmarks ever becoming camera movement. */
const MAX_DELTA = 4;
const MAX_VELOCITY = 20;

/**
 * Convert the calibrated on-screen hand position to production Explore axes.
 *
 * The pointer mapper already makes the user's comfortable centre `(0.5, 0.5)` on every
 * camera/display pairing. Reusing that mapping here is what makes automatic Explore portable:
 * no uncalibrated camera pixels or laptop-specific reach leak into the scene controller.
 */
export function sceneExploreAxes(
  x: number,
  y: number,
  center: { x: number; y: number } = { x: 0.5, y: 0.5 },
): { dx: number; dy: number } {
  const halfX = Math.max(0.1, Math.max(center.x, 1 - center.x));
  const halfY = Math.max(0.1, Math.max(center.y, 1 - center.y));
  const dx = Number.isFinite(x) ? (x - center.x) / halfX : 0;
  const dy = Number.isFinite(y) ? (center.y - y) / halfY : 0;
  return {
    dx: Math.max(-1, Math.min(1, dx)),
    dy: Math.max(-1, Math.min(1, dy)),
  };
}

function finiteClamped(value: number, limit: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(-limit, Math.min(limit, value));
}

function clearMotion(): void {
  flightInput.dx = 0;
  flightInput.dy = 0;
  flightInput.vx = 0;
  flightInput.vy = 0;
}

/** Called by the scene for loading, usable, failed and teardown transitions. */
export function setSceneAvailability(availability: SceneAvailability): void {
  flightInput.availability = availability;
  flightInput.ready = availability === "ready";
  if (!flightInput.ready && flightInput.active) {
    cancelSceneGrab("scene-unavailable");
  }
}

/** Compatibility convenience for tests and non-UI scene consumers. */
export function setSceneReady(ready: boolean): void {
  setSceneAvailability(ready ? "ready" : "unavailable");
}

/**
 * Select the next session's camera grammar. A live session owns its grammar, so it cannot
 * change underneath the visitor; callers may update the mode after that session ends.
 */
export function setSceneMode(mode: SceneMode): boolean {
  if (flightInput.active) return false;
  flightInput.mode = mode;
  return true;
}

/** Start a new scene-control session. Returns false if the scene cannot safely accept it. */
export function beginSceneGrab(input: SceneBegin): boolean {
  if (
    !flightInput.ready ||
    flightInput.active ||
    !Number.isFinite(input.ownerId) ||
    !Number.isFinite(input.sessionId) ||
    input.sessionId <= flightInput.sessionId ||
    !Number.isFinite(input.seq) ||
    !Number.isFinite(input.freshAt) ||
    !Number.isFinite(input.freshForMs) ||
    input.freshForMs <= 0
  ) {
    return false;
  }

  flightInput.active = true;
  flightInput.sessionId = input.sessionId;
  flightInput.ownerId = input.ownerId;
  flightInput.seq = input.seq;
  flightInput.freshAt = input.freshAt;
  flightInput.freshForMs = input.freshForMs;
  flightInput.endReason = null;
  flightInput.hands = input.hands ?? [];
  clearMotion();
  return true;
}

/** Apply a fresh sample to the session that began it. Older or foreign samples are ignored. */
export function updateSceneGrab(input: SceneUpdate): boolean {
  if (
    !flightInput.ready ||
    !flightInput.active ||
    input.sessionId !== flightInput.sessionId ||
    input.ownerId !== flightInput.ownerId ||
    !Number.isFinite(input.seq) ||
    input.seq <= flightInput.seq ||
    !Number.isFinite(input.freshAt) ||
    !Number.isFinite(input.freshForMs) ||
    input.freshForMs <= 0 ||
    input.freshAt < flightInput.freshAt
  ) {
    return false;
  }

  flightInput.seq = input.seq;
  flightInput.freshAt = input.freshAt;
  flightInput.freshForMs = input.freshForMs;
  flightInput.dx = finiteClamped(input.dx, MAX_DELTA);
  flightInput.dy = finiteClamped(input.dy, MAX_DELTA);
  flightInput.vx = finiteClamped(input.vx, MAX_VELOCITY);
  flightInput.vy = finiteClamped(input.vy, MAX_VELOCITY);
  flightInput.hands = input.hands ?? [];
  return true;
}

/**
 * Finish a scene grab. Supplying the session/owner prevents a late edge from an old hand from
 * ending the current visitor's grab.
 */
export function endSceneGrab(
  reason: SceneEndReason,
  expected?: {
    sessionId?: number;
    ownerId?: number | null;
    seq?: number;
    freshAt?: number;
    freshForMs?: number;
  },
): boolean {
  if (!flightInput.active) return false;
  if (expected?.sessionId !== undefined && expected.sessionId !== flightInput.sessionId) return false;
  if (expected?.ownerId !== undefined && expected.ownerId !== flightInput.ownerId) return false;

  if (expected?.seq !== undefined && Number.isFinite(expected.seq)) {
    flightInput.seq = Math.max(flightInput.seq, expected.seq);
  }
  if (expected?.freshAt !== undefined && Number.isFinite(expected.freshAt)) {
    flightInput.freshAt = Math.max(flightInput.freshAt, expected.freshAt);
  }
  if (expected?.freshForMs !== undefined && Number.isFinite(expected.freshForMs)) {
    flightInput.freshForMs = expected.freshForMs;
  }
  flightInput.active = false;
  flightInput.ownerId = null;
  flightInput.endReason = reason;
  flightInput.hands = [];
  clearMotion();
  return true;
}

/** Explicit alias for every abnormal end, keeping call sites honest about their semantics. */
export function cancelSceneGrab(
  reason: Exclude<SceneEndReason, "released">,
  expected?: Parameters<typeof endSceneGrab>[1],
): boolean {
  return endSceneGrab(reason, expected);
}

/** Full teardown for route changes/tests. Keeps the user's selected mode unless asked otherwise. */
export function resetSceneInput(
  reason: Exclude<SceneEndReason, "released"> = "unmount",
): void {
  if (flightInput.active) cancelSceneGrab(reason);
  flightInput.availability = "unavailable";
  flightInput.ready = false;
  flightInput.ownerId = null;
  flightInput.hands = [];
  clearMotion();
}
