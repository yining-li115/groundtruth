/**
 * Gesture-driven navigation state for the Gaussian-splat map (splatnav experiment).
 *
 * Plain mutable singleton — like `lib/heroInput`'s `heroOrbit`, updates run at frame rate
 * and must NOT trigger React renders. The hand hook (`useHandNav`) WRITES intent here each
 * webcam frame; the camera loop in `SplatNavExperiment` READS it each render frame.
 *
 * NAVIGATION MODEL — orbit around a target, NOT a free-fly. A photogrammetry splat is full of
 * floaters and holes; a first-person fly would plunge the camera into garbage. Keeping the
 * camera aimed at the campus (orbit around a `target` at a fixed `radius`) always reads well
 * on the untouchable kiosk. Layered on top: `disperseTarget` scatters the actual gaussians
 * apart (open palm) and reassembles them (fist) — see `disperse.ts`. `target` is pannable so
 * the viewpoint can roam later.
 *
 * The defaults derive from the proven framing in `SplatNativeExperiment` (cropped, upright
 * TUM Hauptgebäude scan, world-up = -Z), looking at [-1.5, -1, -4.5] from radius ≈ 104, but
 * with the elevation raised (pitch 0.35) to an above-horizon 3/4 view so the ugly underside
 * never shows.
 */

/** World up for the scan (roofs face -Y; the upright crop reads from the -Z side). */
export const NAV_UP: [number, number, number] = [0, 0, -1];

/** Dolly limits (distance from target). MIN keeps us off the facade; MAX frames the whole block. */
export const RADIUS_MIN = 12;
export const RADIUS_MAX = 160;

/**
 * Elevation-offset clamp for the SplatStage hand-orbit (radians-ish, 0 = the baked height).
 * Negative dips the camera toward the horizon, positive raises it toward top-down. Kept above
 * the horizon so the ugly underside never shows.
 */
export const PITCH_MIN = -0.35;
export const PITCH_MAX = 0.9;

export const splatNav = {
  /** orbit azimuth around the target (radians) */
  yaw: Math.PI,
  /** orbit elevation around the target (radians) — a pleasant elevated 3/4 view, above horizon */
  pitch: 0.35,
  /** distance from the target (fixed for now; dolly can be re-added later) */
  radius: 104,
  /** disperse intent [0..1]: open palm → 1 (scatter the gaussians), fist → 0 (reassemble). Sticky. */
  disperseTarget: 0,
  /** when true, the palm/fist gesture drives disperseTarget (manual mode). When false, the host
   *  drives it (auto/presence mode) so a greeting-palm doesn't accidentally scatter. */
  gestureControls: true,
  /** true on any frame a hand is tracked — the loop uses it to decide idle auto-orbit. */
  handPresent: false,
  /** the look-at point (pannable) */
  target: { x: -1.5, y: -1, z: -4.5 },
  /** last recognised gesture label, for the HUD */
  gesture: "None" as string,
};

export type SplatNav = typeof splatNav;
