import { create } from "zustand";

/** Which screen the interactive website shell is showing. No router needed — the kiosk
 *  is a single cursor-driven surface, so navigation is just view state (architecture
 *  §6: the kiosk owns navigation). */
export type View =
  | "home"
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
  /** Entered the site from the showreel (or the explicit demo deep-link). */
  entered: boolean;
  /**
   * The camera in front of this screen has been measured — or the measurement was skipped, or
   * there is no camera to measure. Everything else waits behind it.
   *
   * Not "has a profile": a wall with a dead camera must still play its showreel rather than sit
   * on a setup screen forever, so this means "the question has been settled", however it was.
   */
  calibrated: boolean;
  /** Current screen in the interactive shell. */
  view: View;
  /** Which home design the "home" view renders. */
  homeVariant: HomeVariant;
  /** A fresh, stable hand owner is visible. Used for hints and the visitor idle timer only;
   *  scene/UI authority belongs to an explicit GestureSession, never to presence itself. */
  handPresent: boolean;
  /**
   * The visitor keeps closing their fingers and the pinch keeps not registering.
   *
   * This is the wall's most common failure and it is invisible from the inside: at two metres
   * a webcam can barely resolve two fingertips, so a deliberate pinch reads as an open hand.
   * Measured with a simulated hand on a far camera, 2 to 5 pinches in 12 produce a click,
   * while the same hand's FIST produces 12 in 12. When the pointer sees fingers closing and
   * nothing latching, twice, the screen should stop waiting to be understood and say so.
   */
  pinchTrouble: boolean;
  /** How the one input the kiosk has is doing. With no phone left as a second way in, a dead
   *  camera is a dead screen, so this is not a detail to keep inside a component. */
  handStatus: "idle" | "loading" | "running" | "error";
  setEntered: (v: boolean) => void;
  setCalibrated: (v: boolean) => void;
  setHandPresent: (v: boolean) => void;
  setHandStatus: (v: KioskState["handStatus"]) => void;
  setPinchTrouble: (v: boolean) => void;
  setView: (v: View) => void;
  setHomeVariant: (v: HomeVariant) => void;
}

/** Optional deep-link: `?view=projects` opens that section directly (else home). */
const initialView = ((): View => {
  if (typeof window === "undefined") return "home";
  const v = new URLSearchParams(window.location.search).get("view");
  const valid: View[] = [
    "home",
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
  entered: initialEntered,
  calibrated: false,
  view: initialView,
  homeVariant: initialHomeVariant,
  handPresent: false,
  handStatus: "idle",
  pinchTrouble: false,
  setEntered: (entered) => set({ entered }),
  setCalibrated: (calibrated) => set({ calibrated }),
  setHandPresent: (handPresent) => set({ handPresent }),
  setHandStatus: (handStatus) => set({ handStatus }),
  setPinchTrouble: (pinchTrouble) => set({ pinchTrouble }),
  setView: (view) => set({ view }),
  setHomeVariant: (homeVariant) => set({ homeVariant }),
}));
