/** The physical camera identity exposed by the browser after permission is granted. */
export interface CameraIdentity {
  deviceId: string;
  label: string;
}

const EMPTY_CAMERA: CameraIdentity = { deviceId: "", label: "" };
export const ANONYMOUS_CAMERA_PREFIX = "browser-session-camera:";
export const ANONYMOUS_CAMERA_FALLBACK = "browser-default-camera";
let current: CameraIdentity = EMPTY_CAMERA;
let revision = 0;
const listeners = new Set<(camera: CameraIdentity) => void>();

/** Stable profile-key identity. The NUL separator cannot occur in either browser field. */
export function cameraSignature(camera: CameraIdentity = current): string {
  return `${camera.deviceId}\u0000${camera.label}`;
}

export function activeCameraIdentity(): CameraIdentity {
  return { ...current };
}

/** Monotonic identity epoch: unlike a signature comparison, it detects A → B → A transitions. */
export function cameraIdentityRevision(): number {
  return revision;
}

/** Privacy-restricted tracks cannot support a durable physical-device profile. */
export function isAnonymousCameraIdentity(camera: CameraIdentity): boolean {
  return (
    camera.deviceId === ANONYMOUS_CAMERA_FALLBACK ||
    camera.deviceId.startsWith(ANONYMOUS_CAMERA_PREFIX)
  );
}

/**
 * Publish an ACTUAL live video track, not requested constraints. Stream teardown deliberately
 * does not publish an empty identity: a short reconnect must not erase which installation was
 * active, while a different replacement track must be observable before its first action.
 */
export function publishCameraIdentity(camera: CameraIdentity): void {
  if (!camera.deviceId && !camera.label) return;
  if (cameraSignature(camera) === cameraSignature(current)) return;
  current = { ...camera };
  revision += 1;
  listeners.forEach((listener) => listener({ ...current }));
}

export function cameraIdentityFromTrack(track: MediaStreamTrack): CameraIdentity {
  const settings = track.getSettings();
  const deviceId = settings.deviceId?.trim() ?? "";
  const label = track.label?.trim() ?? "";
  if (deviceId || label) return { deviceId, label };
  // Some privacy-restrictive browsers expose a live, permissioned track without either field.
  // Bind setup to this live track when possible. A replacement gets a different session id and
  // therefore cannot silently inherit mapping measured for unknown optics. These identities are
  // deliberately never persisted by profileStore, so a reload asks for setup again.
  const trackId = track.id?.trim() ?? "";
  return {
    deviceId: trackId
      ? `${ANONYMOUS_CAMERA_PREFIX}${trackId}`
      : ANONYMOUS_CAMERA_FALLBACK,
    label: "Unlabelled camera",
  };
}

export function onCameraIdentity(listener: (camera: CameraIdentity) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
