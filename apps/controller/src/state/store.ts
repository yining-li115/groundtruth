import { create } from "zustand";

/**
 * Controller UI states. `driver`/`queued` are assigned by the relay (the sole token
 * authority — CLAUDE.md rule 4); `connecting` and `passed` are local transitions.
 */
export type ControllerRoleState = "connecting" | "driver" | "queued" | "passed";

interface ControllerState {
  connected: boolean;
  role: ControllerRoleState;
  position: number;
  total: number;
  setConnected: (v: boolean) => void;
  setRole: (r: ControllerRoleState) => void;
  setQueue: (position: number, total: number) => void;
}

export const useControllerStore = create<ControllerState>((set) => ({
  connected: false,
  role: "connecting",
  position: 0,
  total: 0,
  setConnected: (connected) => set({ connected }),
  setRole: (role) => set({ role }),
  setQueue: (position, total) => set({ position, total }),
}));
