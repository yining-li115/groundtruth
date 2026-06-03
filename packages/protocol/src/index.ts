/**
 * @groundtruth/protocol — the NORMATIVE WebSocket message protocol.
 *
 * Defined once here and imported by relay, kiosk, and controller so the three parts
 * can never drift (CLAUDE.md §6, docs/architecture.md §5). Message names are FIXED —
 * do not rename without updating the architecture doc first (CLAUDE.md rule 8).
 *
 * Shape note: socket.io is event-based, so each protocol message maps to a socket.io
 * event name + a single payload object. The `*Events` interfaces below are written to
 * plug straight into socket.io's generics:
 *
 *   // relay (apps/relay)
 *   new Server<ClientToRelayEvents, RelayToClientEvents>()
 *   // clients (apps/kiosk, apps/controller)
 *   io<RelayToClientEvents, ClientToRelayEvents>(url)
 */

/** Stable kiosk room identifier, e.g. "gt-entrance" or a short code like "a7f3". */
export type SessionId = string;

/** Exactly one controller per room holds the token (the "driver"). */
export type ControllerRole = "driver" | "queued";

/* ------------------------------------------------------------------ *
 * Payloads (architecture §5 tables)
 * ------------------------------------------------------------------ */

/** Empty payload for messages that carry no data (sent as `{}`). */
export type Empty = Record<string, never>;

// Client → Relay
export type KioskHelloPayload = { sessionId: SessionId };
export type CtrlJoinPayload = { sessionId: SessionId };
/** Relative cursor delta, like a laptop trackpad (architecture §4). */
export type CtrlInputMovePayload = { dx: number; dy: number };
export type CtrlInputScrollPayload = { dy: number };

// Relay → Clients
export type RoomRolePayload = { role: ControllerRole; position?: number };
export type RoomQueuePayload = { position: number; total: number };
export type RoomDriverChangedPayload = { hasDriver: boolean };
export type KioskCursorMovePayload = { dx: number; dy: number };
export type KioskCursorScrollPayload = { dy: number };

/* ------------------------------------------------------------------ *
 * Event maps (socket.io listener signatures)
 * ------------------------------------------------------------------ */

/** Messages sent by a client (kiosk or controller) to the relay. */
export interface ClientToRelayEvents {
  /** kiosk registers its room. */
  "kiosk:hello": (payload: KioskHelloPayload) => void;
  /** phone joins a room. */
  "ctrl:join": (payload: CtrlJoinPayload) => void;
  /** driver only — relative cursor delta. */
  "ctrl:input.move": (payload: CtrlInputMovePayload) => void;
  /** driver only — click at cursor. */
  "ctrl:input.tap": (payload: Empty) => void;
  /** driver only — scroll. */
  "ctrl:input.scroll": (payload: CtrlInputScrollPayload) => void;
  /** driver only — go back / exit section. */
  "ctrl:input.back": (payload: Empty) => void;
  /** driver only — voluntarily release the token. */
  "ctrl:pass": (payload: Empty) => void;
  /** keep-alive / resets the idle timer. */
  "ctrl:heartbeat": (payload: Empty) => void;
}

/** Messages sent by the relay to clients. */
export interface RelayToClientEvents {
  /** → one controller: its assigned role. */
  "room:role": (payload: RoomRolePayload) => void;
  /** → all controllers: queue positions changed. */
  "room:queue": (payload: RoomQueuePayload) => void;
  /** → kiosk: enter/exit interactive mode. */
  "room:driverChanged": (payload: RoomDriverChangedPayload) => void;
  /** → one controller: you just became driver (swap game → trackpad UI). */
  "room:youAreUp": (payload: Empty) => void;
  /** → kiosk: forwarded movement. */
  "kiosk:cursor.move": (payload: KioskCursorMovePayload) => void;
  /** → kiosk: forwarded click. */
  "kiosk:cursor.tap": (payload: Empty) => void;
  /** → kiosk: forwarded scroll. */
  "kiosk:cursor.scroll": (payload: KioskCursorScrollPayload) => void;
  /** → kiosk: forwarded back. */
  "kiosk:cursor.back": (payload: Empty) => void;
}

/** Union of every event name in each direction (handy for logging/validation). */
export type ClientToRelayEventName = keyof ClientToRelayEvents;
export type RelayToClientEventName = keyof RelayToClientEvents;

/* ------------------------------------------------------------------ *
 * Timing constants (architecture §3 — defined in one place, tune later)
 * ------------------------------------------------------------------ */

export const TIMING = {
  /**
   * Driver is released after this long with no INPUT (move/tap/scroll/back).
   * Heartbeats do NOT reset this — they are connection keep-alive only, so an
   * inattentive driver who leaves the tab open still frees the token for the queue
   * (architecture §3; resolves the §5 heartbeat wording).
   */
  IDLE_TIMEOUT_MS: 60_000,
  /** Grace period on voluntary pass before the token moves on. */
  PASS_GRACE_MS: 0,
  /** How often a controller sends `ctrl:heartbeat` (connection liveness). */
  HEARTBEAT_INTERVAL_MS: 15_000,
} as const;
