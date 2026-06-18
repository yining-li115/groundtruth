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
  /** Home hero is pinned → a one-finger drag orbits the particles (and the cursor is
   *  hidden) instead of moving the cursor. Off once you scroll past the hero. */
  heroOrbitActive: boolean;
  setConnected: (v: boolean) => void;
  setHasDriver: (v: boolean) => void;
  setView: (v: View) => void;
  setHeroOrbitActive: (v: boolean) => void;
}

/** Optional deep-link: `?view=projects` opens that section directly (else home). */
const initialView = ((): View => {
  if (typeof window === "undefined") return "home";
  const v = new URLSearchParams(window.location.search).get("view");
  const valid: View[] = ["home", "people", "research", "projects", "teaching"];
  return valid.includes(v as View) ? (v as View) : "home";
})();

export const useKioskStore = create<KioskState>((set) => ({
  connected: false,
  hasDriver: false,
  view: initialView,
  heroOrbitActive: false,
  setConnected: (connected) => set({ connected }),
  setHasDriver: (hasDriver) => set({ hasDriver }),
  setView: (view) => set({ view }),
  setHeroOrbitActive: (heroOrbitActive) => set({ heroOrbitActive }),
}));
