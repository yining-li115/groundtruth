import { io, type Socket } from "socket.io-client";
import type {
  ClientToRelayEvents,
  RelayToClientEvents,
} from "@groundtruth/protocol";
import { RELAY_URL } from "../config";

/** A client socket LISTENS for relay→client events and EMITS client→relay events. */
export type KioskSocket = Socket<RelayToClientEvents, ClientToRelayEvents>;

/** Single shared socket; App connects it explicitly (autoConnect off). The typed
 *  alias on the variable is how socket.io-client carries the event types (io() itself
 *  is not generic). */
export const socket: KioskSocket = io(RELAY_URL, { autoConnect: false });
