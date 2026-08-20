import { interactionBox, DEFAULT_BOX } from "./calibration";
import type { FaceResult, HandResult, Landmark, VisionResult } from "./mediapipe";

/**
 * A synthetic hand, for driving the kiosk without a camera. DEV ONLY.
 *
 * Everything downstream of the camera — the thresholds, the press debounce, the 1€ filter, the
 * interaction box, click routing, scrolling — is the part that decides whether the site is
 * usable, and none of it can be exercised by opening the page and waving at it: a real hand
 * cannot be asked to hold still at a hundred specific points, and it cannot repeat anything
 * exactly. So the seam sits here, at the boundary the camera crosses, and the entire chain
 * below it runs exactly as it ships.
 *
 * What this therefore does NOT test is the camera and the tracking itself. That half was
 * measured separately, from recordings of a real hand — `scripts/fixtures/pinch-trials.json`
 * and the replay in `check:pointer`. Between them the two halves cover the whole path, and
 * neither one pretends to be the other.
 *
 * A driver sets an aim in SCREEN coordinates and this solves back to the frame position that
 * maps there, so a test can say "point at that button" rather than reasoning about the box.
 */
export interface HandSim {
  /** where the cursor should be aiming, in unit screen coordinates */
  aim: { u: number; v: number };
  /** whether the fingers are closed this frame */
  pinching: boolean;
  /**
   * Aperture this frame, as the raw ratio the detector thresholds against — overrides
   * `pinching` when set.
   *
   * A boolean pinch is not what a hand does. Fingers take a moment to close, they often stop
   * short of touching, and a pinch that only half closes is exactly the one the wall fails to
   * read: the thresholds are ON below 0.74 and OFF above 0.88, so a driver that can only say
   * "open" (1.44) or "shut" (0.35) tests neither edge. With this a test can close at a human
   * speed, stop at any depth, and ask what the pipeline made of it.
   */
  aperture?: number;
  /** whether a hand is in shot at all */
  present: boolean;
  /** posture label, for the fist path ("Closed_Fist" or anything else) */
  label: string;
}

declare global {
  interface Window {
    __handSim?: HandSim;
    /** live pointer state, so a driver can wait for the cursor to settle instead of sleeping */
    __handState?: () => unknown;
  }
}

/** Face parked at a comfortable working distance — the measured faceW at about a metre. */
const SIM_FACE: FaceResult = { cx: 0.5, cy: 0.35, w: 0.075, h: 0.0975, score: 0.99 };
export const SIM_ASPECT = 16 / 9;
/** Aperture over palm width: the measured open hand, and a firmly closed one. */
const SIM_OPEN = 1.44;
const SIM_CLOSED = 0.35;
/** Palm width in frame units, and the metric span the ratio is built against. */
const SIM_PALM_NORM = 0.047; // ≈ 0.62 face widths, matching a real hand at this distance
const SIM_SPAN_M = 0.08;

/**
 * Build one frame of vision results from the simulator's state.
 *
 * The landmarks are only as detailed as the pipeline actually reads: the palm triangle (which
 * is where the cursor comes from), the two knuckles that set the scale, and the thumb and
 * index tips that set the aperture. Filling in a plausible whole skeleton would add nothing
 * but the chance of it disagreeing with the parts that matter.
 */
export function simFrame(sim: HandSim): VisionResult {
  if (!sim.present) return { hand: null, hands: [], face: SIM_FACE };

  const box = interactionBox(SIM_FACE, SIM_ASPECT, DEFAULT_BOX);
  // Invert the screen mapping — including its mirror — so an aim in screen coordinates comes
  // back as the frame position that produces it.
  const x = box ? box.x0 + (1 - sim.aim.u) * box.w : 0.5;
  const y = box ? box.y0 + sim.aim.v * box.h : 0.5;

  const half = SIM_PALM_NORM / 2;
  const lm: Landmark[] = Array.from({ length: 21 }, () => ({ x, y, z: 0 }));
  lm[0] = { x, y, z: 0 }; // wrist
  lm[5] = { x: x - half, y, z: 0 }; // index knuckle
  lm[17] = { x: x + half, y, z: 0 }; // little-finger knuckle
  lm[8] = { x, y: y - 0.05, z: 0 }; // index tip

  const ratio = sim.aperture ?? (sim.pinching ? SIM_CLOSED : SIM_OPEN);
  const world: Landmark[] = Array.from({ length: 21 }, () => ({ x: 0, y: 0, z: 0 }));
  world[5] = { x: -SIM_SPAN_M / 2, y: 0, z: 0 };
  world[17] = { x: SIM_SPAN_M / 2, y: 0, z: 0 };
  world[4] = { x: 0, y: 0, z: 0 }; // thumb tip
  world[8] = { x: ratio * SIM_SPAN_M, y: 0, z: 0 }; // index tip, at the requested aperture

  const hand: HandResult = {
    label: sim.label,
    score: 0.9,
    cx: x,
    cy: y - 0.05,
    landmarks: lm,
    world,
    handedness: "Right",
  };
  return { hand, hands: [hand], face: SIM_FACE };
}

/** The simulator the page should use, if a driver has installed one. */
export function activeSim(): HandSim | null {
  if (!import.meta.env.DEV || typeof window === "undefined") return null;
  return window.__handSim ?? null;
}
