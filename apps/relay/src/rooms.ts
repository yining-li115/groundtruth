import type { Server, Socket } from "socket.io";
import {
  TIMING,
  type ClientToRelayEvents,
  type RelayToClientEvents,
} from "@groundtruth/protocol";
import { config } from "./config";

/** Per-socket state we attach via socket.data (typed into the socket.io generics). */
export interface SocketData {
  sessionId?: string;
  role?: "kiosk" | "driver" | "queued";
}

type IO = Server<ClientToRelayEvents, RelayToClientEvents, Record<string, never>, SocketData>;
type Sock = Socket<ClientToRelayEvents, RelayToClientEvents, Record<string, never>, SocketData>;

/** Short socket id for readable logs. */
const short = (id: string): string => id.slice(0, 6);
/** Room-activity log line (who joined/left, token changes) — NOT per-input (too noisy). */
const rlog = (msg: string): void => console.log(`[room] ${msg}`);

/** Live state for one kiosk room (keyed by sessionId). In-memory only (v1, no DB). */
interface Room {
  sessionId: string;
  /** Kiosk socket ids (usually one; a set tolerates reconnect overlap). */
  kiosks: Set<string>;
  /** Controller socket id currently holding the token, or null. */
  driverId: string | null;
  /** Controller socket ids waiting, ordered by relay receipt time (architecture §8). */
  queue: string[];
  /** Inactivity timer for the current driver. */
  idleTimer?: ReturnType<typeof setTimeout>;
}

/**
 * The relay is the SOLE authority for who holds the token (CLAUDE.md rule 4). This
 * manager owns every room's state machine (architecture §3): assign/queue on join,
 * forward only the driver's input, and release on pass / idle / disconnect.
 */
export class RoomManager {
  private readonly rooms = new Map<string, Room>();
  /** Per-socket rate-limit buckets (1-second windows). */
  private readonly buckets = new Map<string, { windowStart: number; count: number }>();

  constructor(private readonly io: IO) {}

  // ---- registration ---------------------------------------------------------

  registerKiosk(socket: Sock, sessionId: string): void {
    const room = this.ensureRoom(sessionId);
    socket.data.sessionId = sessionId;
    socket.data.role = "kiosk";
    room.kiosks.add(socket.id);
    // Bring a (re)connecting kiosk to the correct mode immediately.
    this.emitTo(socket.id, "room:driverChanged", { hasDriver: room.driverId !== null });
    rlog(`kiosk ${short(socket.id)} registered room "${sessionId}" ${this.occupancy(room)}`);
  }

  addController(socket: Sock, sessionId: string): void {
    const room = this.ensureRoom(sessionId);
    socket.data.sessionId = sessionId;

    if (room.driverId === null) {
      this.setDriver(room, socket.id);
      this.emitTo(socket.id, "room:role", { role: "driver" });
      this.notifyKiosks(room);
      this.startIdle(room);
      rlog(`controller ${short(socket.id)} joined room "${sessionId}" → DRIVER`);
    } else {
      room.queue.push(socket.id);
      socket.data.role = "queued";
      this.emitTo(socket.id, "room:role", { role: "queued", position: room.queue.length });
      this.broadcastQueue(room);
      rlog(
        `controller ${short(socket.id)} joined room "${sessionId}" → QUEUED #${room.queue.length} · current driver ${short(room.driverId)}`,
      );
    }
  }

  // ---- input forwarding (driver only) --------------------------------------

  forwardMove(socket: Sock, payload: { dx: number; dy: number }): void {
    const room = this.precheck(socket);
    if (room) this.toKiosks(room, "kiosk:cursor.move", payload);
  }

  forwardTap(socket: Sock): void {
    const room = this.precheck(socket);
    if (room) this.toKiosks(room, "kiosk:cursor.tap", {});
  }

  forwardScroll(socket: Sock, payload: { dy: number }): void {
    const room = this.precheck(socket);
    if (room) this.toKiosks(room, "kiosk:cursor.scroll", payload);
  }

  forwardBack(socket: Sock): void {
    const room = this.precheck(socket);
    if (room) this.toKiosks(room, "kiosk:cursor.back", {});
  }

  /** Connection keep-alive only — does NOT reset the inactivity timer (see TIMING). */
  heartbeat(_socket: Sock): void {
    // socket.io already detects dead sockets; nothing to do for idle purposes.
  }

  // ---- token release --------------------------------------------------------

  pass(socket: Sock): void {
    const room = this.roomOf(socket);
    if (room && room.driverId === socket.id) this.releaseDriver(room, "pass");
  }

  disconnect(socket: Sock): void {
    const room = this.roomOf(socket);
    this.buckets.delete(socket.id);
    if (!room) return;

    if (room.kiosks.delete(socket.id)) {
      rlog(`kiosk ${short(socket.id)} disconnected · room "${room.sessionId}" ${this.occupancy(room)}`);
    } else if (room.driverId === socket.id) {
      this.releaseDriver(room, "disconnect");
    } else {
      const idx = room.queue.indexOf(socket.id);
      if (idx !== -1) {
        room.queue.splice(idx, 1);
        this.broadcastQueue(room);
        rlog(`queued ${short(socket.id)} left room "${room.sessionId}" · queue=${room.queue.length}`);
      }
    }
    this.cleanup(room);
  }

  // ---- internals ------------------------------------------------------------

  /** Driver-check + rate-limit + idle reset. Returns the room if input is allowed. */
  private precheck(socket: Sock): Room | null {
    const room = this.roomOf(socket);
    if (!room || room.driverId !== socket.id) return null; // ignore non-driver (§5)
    if (!this.allowInput(socket.id)) return null; // rate limit (§9)
    this.startIdle(room); // real input resets inactivity
    return room;
  }

  private allowInput(id: string): boolean {
    const now = Date.now();
    const b = this.buckets.get(id);
    if (!b || now - b.windowStart >= 1000) {
      this.buckets.set(id, { windowStart: now, count: 1 });
      return true;
    }
    if (b.count >= config.inputRateLimitPerSec) return false;
    b.count += 1;
    return true;
  }

  private releaseDriver(room: Room, reason: "pass" | "idle" | "disconnect"): void {
    this.clearIdle(room);
    const prev = room.driverId;
    room.driverId = null;
    if (prev) {
      const s = this.io.sockets.sockets.get(prev);
      if (s) s.data.role = undefined;
    }
    const by = prev ? short(prev) : "?";

    const nextId = room.queue.shift();
    if (nextId) {
      this.setDriver(room, nextId);
      this.emitTo(nextId, "room:youAreUp", {});
      this.emitTo(nextId, "room:role", { role: "driver" });
      this.startIdle(room);
      this.broadcastQueue(room); // remaining queued shift up one
      rlog(
        `token released (${reason}) by ${by} → promoted ${short(nextId)} to DRIVER · room "${room.sessionId}" · queue=${room.queue.length}`,
      );
    } else {
      this.notifyKiosks(room); // hasDriver = false → kiosk returns to idle
      rlog(`token released (${reason}) by ${by} → no driver, room "${room.sessionId}" now idle`);
    }
  }

  private setDriver(room: Room, id: string): void {
    room.driverId = id;
    const s = this.io.sockets.sockets.get(id);
    if (s) s.data.role = "driver";
  }

  // ---- idle timer -----------------------------------------------------------

  private startIdle(room: Room): void {
    this.clearIdle(room);
    room.idleTimer = setTimeout(() => this.releaseDriver(room, "idle"), TIMING.IDLE_TIMEOUT_MS);
  }

  private clearIdle(room: Room): void {
    if (room.idleTimer) {
      clearTimeout(room.idleTimer);
      room.idleTimer = undefined;
    }
  }

  // ---- emit helpers ---------------------------------------------------------

  private emitTo<E extends keyof RelayToClientEvents>(
    id: string,
    event: E,
    ...args: Parameters<RelayToClientEvents[E]>
  ): void {
    this.io.to(id).emit(event, ...args);
  }

  private toKiosks<E extends keyof RelayToClientEvents>(
    room: Room,
    event: E,
    ...args: Parameters<RelayToClientEvents[E]>
  ): void {
    for (const id of room.kiosks) this.emitTo(id, event, ...args);
  }

  private notifyKiosks(room: Room): void {
    this.toKiosks(room, "room:driverChanged", { hasDriver: room.driverId !== null });
  }

  private broadcastQueue(room: Room): void {
    const total = room.queue.length;
    room.queue.forEach((id, i) => this.emitTo(id, "room:queue", { position: i + 1, total }));
  }

  // ---- room lifecycle -------------------------------------------------------

  private roomOf(socket: Sock): Room | undefined {
    const sessionId = socket.data.sessionId;
    return sessionId ? this.rooms.get(sessionId) : undefined;
  }

  private ensureRoom(sessionId: string): Room {
    let room = this.rooms.get(sessionId);
    if (!room) {
      room = { sessionId, kiosks: new Set(), driverId: null, queue: [] };
      this.rooms.set(sessionId, room);
    }
    return room;
  }

  /** One-glance summary of who's in a room, for logs. */
  private occupancy(room: Room): string {
    const driver = room.driverId ? short(room.driverId) : "none";
    return `[driver=${driver} queued=${room.queue.length} kiosks=${room.kiosks.size}]`;
  }

  private cleanup(room: Room): void {
    if (room.kiosks.size === 0 && room.driverId === null && room.queue.length === 0) {
      this.clearIdle(room);
      this.rooms.delete(room.sessionId);
    }
  }
}
