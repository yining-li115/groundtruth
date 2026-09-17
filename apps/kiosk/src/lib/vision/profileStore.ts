import {
  activePointer,
  DEFAULT_GESTURE_TIMING,
  DEFAULT_POINTER,
} from "./handPointer";
import { RUNTIME_POINTER_OVERRIDES } from "./gestureRuntime";
import {
  PROFILE_VERSION,
  isUsableProfile,
  type CalibrationProfile,
  type DisplayFacts,
} from "./profile";
import { isAnonymousCameraIdentity } from "./cameraPairing";

/**
 * Where a measured profile lives, and how it reaches the pipeline.
 *
 * KEYED BY CAMERA + DISPLAY, not by visit. What a calibration measures is mostly a fact about
 * the installation — lens, mounting height, angle, and the display geometry the normalized UI
 * mapping was verified against. Those do not change between visitors. Asking every passer-by
 * to calibrate would break the thing the project is built around: no setup step, nothing to
 * install, raise a hand and the screen is yours (CLAUDE.md §1). So it is measured once for
 * each physical pairing and reused.
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

/** Current physical display signature. It changes when a laptop window is moved to a monitor
 * with different pixel geometry or scale, which is exactly when an absolute UI mapping needs
 * a separate verification. */
export function displayFacts(): DisplayFacts {
  if (typeof window === "undefined") {
    return {
      width: 1,
      height: 1,
      availWidth: 1,
      availHeight: 1,
      left: 0,
      top: 0,
      dpr: 1,
      colorDepth: 24,
      orientation: "unknown",
      slot: "",
    };
  }
  const screen = window.screen as Screen & { availLeft?: number; availTop?: number };
  const slot = new URLSearchParams(window.location.search).get("display")?.slice(0, 64) ?? "";
  return {
    width: Math.max(1, screen?.width || window.innerWidth || 1),
    height: Math.max(1, screen?.height || window.innerHeight || 1),
    availWidth: Math.max(1, screen?.availWidth || screen?.width || window.innerWidth || 1),
    availHeight: Math.max(1, screen?.availHeight || screen?.height || window.innerHeight || 1),
    // Never fall back to window.screenX/screenY: those are the window's position inside a
    // display, so merely dragging the same window would manufacture a new installation key.
    // Browsers without multi-screen geometry use the stable primary-origin fallback; same-spec
    // monitors can be disambiguated explicitly with `?display=<slot>`.
    left: screen?.availLeft ?? 0,
    top: screen?.availTop ?? 0,
    dpr: Math.max(0.5, window.devicePixelRatio || 1),
    colorDepth: Math.max(1, screen?.colorDepth || 24),
    orientation: screen?.orientation?.type ?? "unknown",
    slot,
  };
}

export function displaySignature(display: DisplayFacts = displayFacts()): string {
  const geometry =
    `${Math.round(display.width)}x${Math.round(display.height)}` +
    `-${Math.round(display.availWidth)}x${Math.round(display.availHeight)}` +
    `@${display.dpr.toFixed(2)}-${display.colorDepth}b` +
    `-${Math.round(display.left)},${Math.round(display.top)}` +
    `-${display.orientation}`;
  return display.slot ? `${geometry}-${encodeURIComponent(display.slot)}` : geometry;
}

/** Deterministic key for a camera + display pairing. Falls back to the label, then to a single
 * shared camera slot, but never silently reuses a laptop-screen mapping on an external display. */
export function profileKey(
  deviceId: string,
  label: string,
  display: DisplayFacts = displayFacts(),
): string {
  // Keep the complete pair identity. Browser device ids are opaque and may share long prefixes;
  // truncating them can make two physical cameras address the same otherwise-valid profile.
  const camera = encodeURIComponent(`${deviceId}\u0000${label}`);
  return `${KEY_PREFIX}.${camera}.${displaySignature(display)}`;
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

/** A profile is authoritative only for the exact installation facts requested by its slot. */
export function profileMatchesPair(
  profile: CalibrationProfile,
  deviceId: string,
  label: string,
  display: DisplayFacts,
): boolean {
  return (
    profile.camera.deviceId === deviceId &&
    profile.camera.label === label &&
    displaySignature(profile.display) === displaySignature(display)
  );
}

/** Read a stored profile for this camera, validating it rather than trusting it. */
export function loadProfile(
  deviceId: string,
  label: string,
  display: DisplayFacts = displayFacts(),
): CalibrationProfile | null {
  // With no durable browser identity, a stored mapping could belong to a physically different
  // camera. Keep such calibration session-local rather than making an unsafe cross-device bet.
  if (isAnonymousCameraIdentity({ deviceId, label })) return null;
  try {
    const raw = localStorage.getItem(profileKey(deviceId, label, display));
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    // A stored blob from an older build, or one somebody edited by hand, is worse than none:
    // it would push nonsense thresholds into the classifier and look like a broken camera.
    if (!isUsableProfile(parsed)) return null;
    // The key is an index, not authority. Refuse a valid-looking blob copied into the wrong
    // slot (or left behind by an older colliding key) unless its own installation facts agree.
    if (!profileMatchesPair(parsed, deviceId, label, display)) return null;
    return parsed;
  } catch {
    return null;
  }
}

/** Make a profile the live one: persist it, push it into the pointer, tell the UI. */
export function applyProfile(profile: CalibrationProfile | null, persist = true): void {
  current = profile;
  if (profile && persist && !isAnonymousCameraIdentity(profile.camera)) {
    try {
      localStorage.setItem(
        profileKey(profile.camera.deviceId, profile.camera.label, profile.display),
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
export function clearProfile(
  deviceId: string,
  label: string,
  display: DisplayFacts = displayFacts(),
): void {
  try {
    localStorage.removeItem(profileKey(deviceId, label, display));
  } catch {
    /* nothing to do — see applyProfile */
  }
  applyProfile(null, false);
}

/**
 * Push measured numbers into the running pointer.
 *
 * Every value here is a property the calibration actually measured on this camera/display
 * pairing. Recognition timing is deliberately absent: those gates use decoded-sample
 * timestamps, so a profile captured at 30fps behaves identically if the Gaussian scene later
 * lowers inference to 15fps.
 */
function pushToPointer(profile: CalibrationProfile | null): void {
  const pointer = activePointer();
  if (!pointer) return;
  // Reset every runtime knob first. An installation profile may only replace the mapping;
  // visitor-specific thresholds/filtering from an older profile or experiment must never leak.
  pointer.configure({
    ...DEFAULT_POINTER,
    oneEuro: { ...DEFAULT_POINTER.oneEuro },
    box: { ...(profile?.box ?? DEFAULT_POINTER.box) },
    ...RUNTIME_POINTER_OVERRIDES,
    timing: { ...DEFAULT_GESTURE_TIMING },
  });
}

/**
 * Load whatever was measured for the camera currently in use, and apply it.
 *
 * Returns the profile, or null when this camera has never been calibrated — which is the
 * signal the app uses to run the calibration before anything else.
 */
export function restoreProfile(deviceId: string, label: string): CalibrationProfile | null {
  const p = loadProfile(deviceId, label, displayFacts());
  // Never leave a profile for a previous monitor/camera live merely because this pairing has
  // no entry. Defaults are safer than silently applying a mapping that was never validated on
  // the current installation.
  applyProfile(p, false);
  return p;
}
