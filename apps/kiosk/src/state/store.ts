import { create } from "zustand";

/** Which screen the interactive website shell is showing. No router needed — the kiosk
 *  is a single cursor-driven surface, so navigation is just view state (architecture
 *  §6: the kiosk owns navigation). */
export type View = "home" | "people" | "research" | "projects" | "teaching";

interface KioskState {
  /** Socket connected to the relay. */
  connected: boolean;
  /** A controller holds the token → interactive mode (architecture §6). */
  hasDriver: boolean;
  /** Current screen in the interactive shell. */
  view: View;
  setConnected: (v: boolean) => void;
  setHasDriver: (v: boolean) => void;
  setView: (v: View) => void;
}

export const useKioskStore = create<KioskState>((set) => ({
  connected: false,
  hasDriver: false,
  view: "home",
  setConnected: (connected) => set({ connected }),
  setHasDriver: (hasDriver) => set({ hasDriver }),
  setView: (view) => set({ view }),
}));
