import { create } from "zustand";

/** Which screen the interactive website shell is showing. No router needed — the kiosk
 *  is a single cursor-driven surface, so navigation is just view state (architecture
 *  §6: the kiosk owns navigation). */
export type View =
  | "home"
  | "showreel"
  | "people"
  | "research"
  | "projects"
  | "publications"
  | "teaching";

/** Two competing home-page designs, switchable live (a debug tab on each) until the
 *  supervisor picks one: "classic" = point-cloud hero + Spotlight/News feed;
 *  "fly" = the campus-splat fly-through story. */
export type HomeVariant = "classic" | "fly";

interface KioskState {
  /** Socket connected to the relay. */
  connected: boolean;
  /** A controller holds the token → interactive mode (architecture §6). */
  hasDriver: boolean;
  /** Manually entered the site from the showreel (a click, no phone) — e.g. for a demo. Lets the
   *  interactive shell show without a real driver; the phone cursor still only appears with one. */
  entered: boolean;
  /** Current screen in the interactive shell. */
  view: View;
  /** Which home design the "home" view renders. */
  homeVariant: HomeVariant;
  /** Home hero is pinned → a one-finger drag orbits the particles (and the cursor is
   *  hidden) instead of moving the cursor. Off once you scroll past the hero. */
  heroOrbitActive: boolean;
  setConnected: (v: boolean) => void;
  setHasDriver: (v: boolean) => void;
  setEntered: (v: boolean) => void;
  setView: (v: View) => void;
  setHomeVariant: (v: HomeVariant) => void;
  setHeroOrbitActive: (v: boolean) => void;
}

/** Optional deep-link: `?view=projects` opens that section directly (else home). */
const initialView = ((): View => {
  if (typeof window === "undefined") return "home";
  const v = new URLSearchParams(window.location.search).get("view");
  const valid: View[] = [
    "home",
    "showreel",
    "people",
    "research",
    "projects",
    "publications",
    "teaching",
  ];
  return valid.includes(v as View) ? (v as View) : "home";
})();

/** Optional deep-link: `?home=fly` starts on the fly-through home design. */
const initialHomeVariant: HomeVariant =
  typeof window !== "undefined" &&
  new URLSearchParams(window.location.search).get("home") === "fly"
    ? "fly"
    : "classic";

export const useKioskStore = create<KioskState>((set) => ({
  connected: false,
  hasDriver: false,
  entered: false,
  view: initialView,
  homeVariant: initialHomeVariant,
  heroOrbitActive: false,
  setConnected: (connected) => set({ connected }),
  setHasDriver: (hasDriver) => set({ hasDriver }),
  setEntered: (entered) => set({ entered }),
  setView: (view) => set({ view }),
  setHomeVariant: (homeVariant) => set({ homeVariant }),
  setHeroOrbitActive: (heroOrbitActive) => set({ heroOrbitActive }),
}));
