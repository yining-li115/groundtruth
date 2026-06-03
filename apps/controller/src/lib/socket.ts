import { io, type Socket } from "socket.io-client";
import type {
  ClientToRelayEvents,
  RelayToClientEvents,
} from "@groundtruth/protocol";
import { RELAY_URL } from "../config";

/** A client socket LISTENS for relay→client events and EMITS client→relay events. */
export type ControllerSocket = Socket<RelayToClientEvents, ClientToRelayEvents>;

/** Single shared socket; App connects it explicitly (autoConnect off). */
export const socket: ControllerSocket = io(RELAY_URL, { autoConnect: false });
