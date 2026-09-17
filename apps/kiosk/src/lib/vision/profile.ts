import { isUsableBox } from "./reachFit";
import { DEFAULT_BOX, type BoxConfig } from "./calibration";

/**
 * The measured profile of one installation — everything the gesture pipeline needs to know
 * that is a fact about the room rather than about the code.
 *
 * A stored value must remain true after the person who ran setup walks away. Version 4 therefore
 * stores only the camera/display pairing and a bounded interaction box proven on that pairing.
 * Pinch aperture, hand size and sensor jitter are visitor/session observations and deliberately
 * do not belong here; runtime recognizers adapt or filter them without contaminating the next
 * person's interaction.
 *
 * PURE. No DOM, no camera, no React, no storage. The validation here is intentionally strict:
 * an edited or old blob must fall back to safe defaults instead of silently becoming a mapping
 * that strands part of the screen outside the camera's reliable field of view.
 */

/** Bump when the meaning of a field changes, so stored profiles from an older build are
 *  discarded rather than silently misread. */
export const PROFILE_VERSION = 4; // 4: installation-only profile; visitor physiology is session state

export interface CameraFacts {
  /** `MediaDeviceInfo.deviceId` — the key a profile is stored under */
  deviceId: string;
  /** human-readable, for the operator's readout only */
  label: string;
  /** what the browser ACTUALLY decoded, not what was requested */
  frameW: number;
  frameH: number;
  /** measured rate of UNIQUE decoded camera frames processed by vision, in Hz */
  fps: number;
}

/** The display geometry a UI pointer mapping was verified against. */
export interface DisplayFacts {
  width: number;
  height: number;
  availWidth: number;
  availHeight: number;
  left: number;
  top: number;
  dpr: number;
  colorDepth: number;
  orientation: string;
  /** Optional operator label for otherwise indistinguishable same-spec displays. */
  slot: string;
}

export interface CalibrationProfile {
  version: number;
  measuredAt: number;
  camera: CameraFacts;
  /** UI reach belongs to a camera/display pairing, not to the camera alone. */
  display: DisplayFacts;
  /** Conservative installation mapping seed; never larger than the shipped generic box. */
  box: BoxConfig;
  /** the final comfortable-range validation completed successfully */
  validated: boolean;
}

/**
 * How far installation setup may increase pointer gain relative to the generic mapping.
 *
 * A comfortable reach is partly a property of the person holding the hand up. Letting one
 * installer make an arbitrarily tiny box would permanently amplify noise for every visitor who
 * follows. The measured dimensions are therefore clamped to 70–100% of the generic physical
 * box. The final mapped-zone proof decides whether that bounded answer is actually usable.
 */
export const MIN_INSTALLATION_BOX_SCALE = 0.7;

export function conservativeInstallationBox(
  measured: BoxConfig,
): BoxConfig | null {
  const values = [
    measured.widthFaces,
    measured.heightFaces,
    DEFAULT_BOX.widthFaces,
    DEFAULT_BOX.heightFaces,
    DEFAULT_BOX.dropFaces,
    DEFAULT_BOX.shiftFaces ?? 0,
  ];
  if (!values.every(Number.isFinite) || measured.widthFaces <= 0 || measured.heightFaces <= 0) {
    return null;
  }
  return {
    widthFaces: Math.max(
      DEFAULT_BOX.widthFaces * MIN_INSTALLATION_BOX_SCALE,
      Math.min(DEFAULT_BOX.widthFaces, measured.widthFaces),
    ),
    heightFaces: Math.max(
      DEFAULT_BOX.heightFaces * MIN_INSTALLATION_BOX_SCALE,
      Math.min(DEFAULT_BOX.heightFaces, measured.heightFaces),
    ),
    // Offsets from one person's asymmetric stance are not installation facts. The interaction
    // box itself will slide inside the decoded frame when the camera mounting requires it.
    dropFaces: DEFAULT_BOX.dropFaces,
    shiftFaces: DEFAULT_BOX.shiftFaces ?? 0,
  };
}

/** The persisted v4 schema accepts only the bounded form its calibration can produce. */
export function isInstallationBox(box: unknown): box is BoxConfig {
  if (!isUsableBox(box)) return false;
  const close = (a: number, b: number) => Math.abs(a - b) <= 1e-6;
  return (
    box.widthFaces >= DEFAULT_BOX.widthFaces * MIN_INSTALLATION_BOX_SCALE &&
    box.widthFaces <= DEFAULT_BOX.widthFaces &&
    box.heightFaces >= DEFAULT_BOX.heightFaces * MIN_INSTALLATION_BOX_SCALE &&
    box.heightFaces <= DEFAULT_BOX.heightFaces &&
    close(box.dropFaces, DEFAULT_BOX.dropFaces) &&
    close(box.shiftFaces ?? 0, DEFAULT_BOX.shiftFaces ?? 0)
  );
}

export function isUsableProfile(p: unknown): p is CalibrationProfile {
  if (!p || typeof p !== "object") return false;
  const v = p as Partial<CalibrationProfile>;
  const finite = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);
  const camera = v.camera;
  const display = v.display;
  return (
    v.version === PROFILE_VERSION &&
    finite(v.measuredAt) &&
    v.measuredAt > 0 &&
    !!camera &&
    typeof camera.deviceId === "string" &&
    typeof camera.label === "string" &&
    finite(camera.frameW) &&
    camera.frameW > 0 &&
    finite(camera.frameH) &&
    camera.frameH > 0 &&
    finite(camera.fps) &&
    camera.fps >= 1 &&
    camera.fps <= 240 &&
    !!display &&
    finite(display.width) &&
    display.width > 0 &&
    finite(display.height) &&
    display.height > 0 &&
    finite(display.availWidth) &&
    display.availWidth > 0 &&
    finite(display.availHeight) &&
    display.availHeight > 0 &&
    finite(display.left) &&
    finite(display.top) &&
    finite(display.dpr) &&
    display.dpr >= 0.5 &&
    display.dpr <= 8 &&
    finite(display.colorDepth) &&
    display.colorDepth >= 1 &&
    display.colorDepth <= 64 &&
    typeof display.orientation === "string" &&
    typeof display.slot === "string" &&
    display.slot.length <= 64 &&
    isInstallationBox(v.box) &&
    v.validated === true
  );
}

/** What the pipeline runs on before anything has been measured. */
export const DEFAULT_PROFILE_BOX = DEFAULT_BOX;
