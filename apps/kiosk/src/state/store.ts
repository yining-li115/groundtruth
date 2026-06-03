import { create } from "zustand";

interface KioskState {
  /** Socket connected to the relay. */
  connected: boolean;
  /** A controller holds the token → interactive mode (architecture §6). */
  hasDriver: boolean;
  setConnected: (v: boolean) => void;
  setHasDriver: (v: boolean) => void;
}

export const useKioskStore = create<KioskState>((set) => ({
  connected: false,
  hasDriver: false,
  setConnected: (connected) => set({ connected }),
  setHasDriver: (hasDriver) => set({ hasDriver }),
}));
