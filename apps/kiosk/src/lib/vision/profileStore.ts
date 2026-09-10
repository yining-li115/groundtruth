import { activePointer } from "./handPointer";
import {
  PROFILE_VERSION,
  framesFor,
  isUsableProfile,
  type CalibrationProfile,
} from "./profile";

/**
 * Where a measured profile lives, and how it reaches the pipeline.
 *
 * KEYED BY CAMERA, not by visit. What a calibration measures is mostly a fact about the
 * installation — this lens, this mounting height, this angle — and those do not change between
 * visitors. Asking every passer-by to calibrate would break the thing the whole project is
 * built around: no setup step, nothing to install, raise a hand and the screen is yours
 * (CLAUDE.md §1). So it is measured once per camera and then never asked for again.
 *
 * The part that IS per-visitor — how far away they stand, how big their hands are — is already
 * handled by the face-width ruler the box is expressed in. That is why the profile stores face
 * widths rather than pixels: it stays true when the next person stands somewhere else.
 *
 * `localStorage` and not a server, because the kiosk is a static build with no backend. It
 * survives a reload and a redeploy, and it is per-browser-profile, which is the right scope for
 * "this machine, this camera".
 */

const KEY_PREFIX = `gt.vision.profile.v${PROFILE_VERSION}`;

/** Deterministic key for a camera. Falls back to the label, then to a single shared slot —
 *  a browser that will not name its devices still deserves a calibration that persists. */
export function profileKey(deviceId: string, label: string): string {
  const id = deviceId || label || "default";
  return `${KEY_PREFIX}.${id.slice(0, 64)}`;
}

let current: CalibrationProfile | null = null;
const listeners = new Set<(p: CalibrationProfile | null) => void>();

export function activeProfile(): CalibrationProfile | null {
  return current;
}

export function onProfile(fn: (p: CalibrationProfile | null) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Read a stored profile for this camera, validating it rather than trusting it. */
export function loadProfile(deviceId: string, label: string): CalibrationProfile | null {
  try {
    const raw = localStorage.getItem(profileKey(deviceId, label));
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    // A stored blob from an older build, or one somebody edited by hand, is worse than none:
    // it would push nonsense thresholds into the classifier and look like a broken camera.
    return isUsableProfile(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** Make a profile the live one: persist it, push it into the pointer, tell the UI. */
export function applyProfile(profile: CalibrationProfile | null, persist = true): void {
  current = profile;
  if (profile && persist) {
    try {
      localStorage.setItem(
        profileKey(profile.camera.deviceId, profile.camera.label),
        JSON.stringify(profile),
      );
    } catch {
      // Private browsing, or a full quota. The profile still applies for this session; losing
      // it on reload is a smaller failure than refusing to use it now.
    }
  }
  pushToPointer(profile);
  listeners.forEach((fn) => fn(profile));
}

/** Forget the calibration for a camera — the operator's way to start again. */
export function clearProfile(deviceId: string, label: string): void {
  try {
    localStorage.removeItem(profileKey(deviceId, label));
  } catch {
    /* nothing to do — see applyProfile */
  }
  applyProfile(null, false);
}

/**
 * Push measured numbers into the running pointer.
 *
 * Every one of these replaces a constant that was fitted honestly against ONE camera at ONE
 * distance. The frame gates are the subtle pair: they are counted in frames and behave as
 * time, so they are re-derived at the rate this loop was actually measured at rather than at
 * the 30fps everything was written assuming.
 */
function pushToPointer(profile: CalibrationProfile | null): void {
  const pointer = activePointer();
  if (!pointer) return;
  if (!profile) return; // nothing measured: leave the shipped defaults exactly as they are

  const fps = profile.camera.fps;
  pointer.configure({
    box: profile.box,
    oneEuro: { ...pointer.config.oneEuro, minCutoff: profile.jitter.minCutoff },
    dwellRadius: profile.jitter.dwellRadius,
    clickGesture: profile.clickGesture,
    ...(profile.pinch.usable ? { pinchOn: profile.pinch.on, pinchOff: profile.pinch.off } : {}),
    frames: {
      // The same durations the constants were chosen to express, at the measured rate:
      // 165ms of grace on a lost hand, 265ms of settling after a tracking gap, and the fist
      // latch's 66/100ms.
      grace: framesFor(165, fps),
      settle: framesFor(265, fps),
      fistOn: framesFor(66, fps),
      fistOff: framesFor(100, fps),
    },
  });
}

/**
 * Load whatever was measured for the camera currently in use, and apply it.
 *
 * Returns the profile, or null when this camera has never been calibrated — which is the
 * signal the app uses to run the calibration before anything else.
 */
export function restoreProfile(deviceId: string, label: string): CalibrationProfile | null {
  const p = loadProfile(deviceId, label);
  if (p) applyProfile(p, false);
  return p;
}
