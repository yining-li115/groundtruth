import { createServer } from "node:http";
import { Server } from "socket.io";
import type {
  ClientToRelayEvents,
  RelayToClientEvents,
} from "@groundtruth/protocol";
import { config } from "./config";
import { RoomManager, type SocketData } from "./rooms";

/**
 * Groundtruth relay — the cloud authority both clients connect to over WebSocket
 * (architecture §1). Rooms by sessionId, the token queue state machine, and input
 * forwarding all live in RoomManager. This file is just wiring: bind each protocol
 * event to the manager. The relay is the SOLE authority for the token (CLAUDE.md
 * rule 4); it forwards only abstract input intents, never arbitrary actions (§9).
 */
const httpServer = createServer();

const io = new Server<
  ClientToRelayEvents,
  RelayToClientEvents,
  Record<string, never>,
  SocketData
>(httpServer, {
  cors: { origin: config.corsOrigin },
});

const rooms = new RoomManager(io);

io.on("connection", (socket) => {
  socket.on("kiosk:hello", ({ sessionId }) => rooms.registerKiosk(socket, sessionId));
  socket.on("ctrl:join", ({ sessionId }) => rooms.addController(socket, sessionId));

  socket.on("ctrl:input.move", (payload) => rooms.forwardMove(socket, payload));
  socket.on("ctrl:input.tap", () => rooms.forwardTap(socket));
  socket.on("ctrl:input.scroll", (payload) => rooms.forwardScroll(socket, payload));
  socket.on("ctrl:input.back", () => rooms.forwardBack(socket));

  socket.on("ctrl:pass", () => rooms.pass(socket));
  socket.on("ctrl:heartbeat", () => rooms.heartbeat(socket));

  socket.on("disconnect", () => rooms.disconnect(socket));
});

httpServer.listen(config.port, () => {
  console.log(`[relay] listening on :${config.port} (cors: ${config.corsOrigin})`);
});
