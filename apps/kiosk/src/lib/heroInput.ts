/**
 * Shared orbit target for the classic home and retained CV/showcase experiments.
 *
 * Plain mutable singleton (not Zustand): pointer/vision and dev-mouse updates run at frame
 * rate and must not trigger React renders.
 */
const YAW_RANGE = 1.4;
const PITCH_RANGE = 0.7;

export const heroOrbit = {
  /** target rotation (radians); the scene eases toward these. */
  yaw: 0,
  pitch: 0,
  /** true once the visitor has moved the cursor over the hero — scene fades its idle sway. */
  touched: false,
  /** Classic home is pinned and currently accepts the global hand cursor as its orbit input. */
  active: false,
  /** Point the classic hero at a normalised cursor position. */
  aim(nx: number, ny: number) {
    heroOrbit.yaw = (nx - 0.5) * YAW_RANGE;
    heroOrbit.pitch = (ny - 0.5) * PITCH_RANGE;
  },
};
