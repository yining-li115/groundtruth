import { TIMING } from "@groundtruth/protocol";

/**
 * Phase 0 scaffold only.
 *
 * The socket.io server, room-by-sessionId, the token queue state machine
 * (docs/architecture.md §3), input forwarding, and idle/disconnect release all land
 * in Phase 1. The relay is the SOLE authority for who holds the token (CLAUDE.md
 * rule 4) — clients never decide locally.
 *
 * Re-export the protocol event maps so Phase 1's socket.io server can type its
 * `Server<ClientToRelayEvents, RelayToClientEvents>` from here, while the contract
 * itself stays defined once in @groundtruth/protocol (CLAUDE.md §6).
 */
export type {
  ClientToRelayEvents,
  RelayToClientEvents,
} from "@groundtruth/protocol";

console.log(
  `[relay] scaffold ready · IDLE_TIMEOUT=${TIMING.IDLE_TIMEOUT_MS}ms · ` +
    `PASS_GRACE=${TIMING.PASS_GRACE_MS}ms · server impl arrives in Phase 1`,
);
