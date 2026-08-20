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

/** Home-page designs, switchable live (a debug tab on each).
 *  "board"   = THE DEFAULT: the light claim + terrain on the left, the five destinations as a
 *              dark board on the right (`scenes/HomeBoard`). Built for hand control like the
 *              colour bands were — full-width rows, no scroll, no drawer — but it lets the
 *              group say who it is without the menu shouting over it.
 *  "menu"    = the previous default: the sections as full-height colour columns.
 *  "classic" = the old point-cloud hero + Spotlight/News scroll feed.
 *  "fly"     = the campus-splat fly-through story. */
export type HomeVariant = "board" | "menu" | "classic" | "fly";

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
  /** A tracked hand is steering the screen. This is what "someone is here" means now that
   *  the phone is gone — the camera, not a token from the relay. */
  handPresent: boolean;
  /** How the one input the kiosk has is doing. With no phone left as a second way in, a dead
   *  camera is a dead screen, so this is not a detail to keep inside a component. */
  handStatus: "idle" | "loading" | "running" | "error";
  /** Home hero is pinned → a one-finger drag orbits the particles (and the cursor is
   *  hidden) instead of moving the cursor. Off once you scroll past the hero. */
  heroOrbitActive: boolean;
  setConnected: (v: boolean) => void;
  setHasDriver: (v: boolean) => void;
  setEntered: (v: boolean) => void;
  setHandPresent: (v: boolean) => void;
  setHandStatus: (v: KioskState["handStatus"]) => void;
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

/** Optional deep-link: `?home=menu` / `?home=classic` / `?home=fly` open the older designs. */
const initialHomeVariant: HomeVariant = ((): HomeVariant => {
  if (typeof window === "undefined") return "board";
  const v = new URLSearchParams(window.location.search).get("home");
  return v === "menu" || v === "classic" || v === "fly" ? v : "board";
})();

/**
 * Optional deep-link: `?enter=1` skips the showreel and opens the site shell directly.
 *
 * The way in is a gesture now, which is exactly what a screenshot tool, an automated check or
 * a demo on a laptop with no camera cannot perform. This is the door for those.
 */
const initialEntered =
  typeof window !== "undefined" && new URLSearchParams(window.location.search).get("enter") === "1";

export const useKioskStore = create<KioskState>((set) => ({
  connected: false,
  hasDriver: false,
  entered: initialEntered,
  view: initialView,
  homeVariant: initialHomeVariant,
  handPresent: false,
  handStatus: "idle",
  heroOrbitActive: false,
  setConnected: (connected) => set({ connected }),
  setHasDriver: (hasDriver) => set({ hasDriver }),
  setEntered: (entered) => set({ entered }),
  setHandPresent: (handPresent) => set({ handPresent }),
  setHandStatus: (handStatus) => set({ handStatus }),
  setView: (view) => set({ view }),
  setHomeVariant: (homeVariant) => set({ homeVariant }),
  setHeroOrbitActive: (heroOrbitActive) => set({ heroOrbitActive }),
}));
