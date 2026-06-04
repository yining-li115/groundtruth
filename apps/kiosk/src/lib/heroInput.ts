/**
 * Phone-driven orbit of the home hero point cloud.
 *
 * The phone is a trackpad with only two gestures (one-finger move, two-finger scroll),
 * and two-finger is already scroll/disperse. If a one-finger drag were hijacked purely
 * to orbit, the cursor would be frozen and the MENU button (overlaid on the hero) would
 * be unreachable. So instead the cursor stays live and clickable, and the cloud ORBITS
 * TO FOLLOW the cursor's position: sweeping the cursor across the hero rotates the model
 * (it reads as "drag to look around"), while you can still park the cursor on MENU and
 * tap. Two-finger scroll still disperses (unchanged).
 *
 * Plain mutable singleton (not zustand): updates run at frame rate and must not trigger
 * React renders. The reactive on/off flag is `heroOrbitActive` in the store.
 */
const YAW_RANGE = 1.4; // total horizontal sweep (radians) across the screen width
const PITCH_RANGE = 0.7; // total vertical sweep (radians) across the screen height

export const heroOrbit = {
  /** target rotation (radians); the scene eases toward these. */
  yaw: 0,
  pitch: 0,
  /** true once the visitor has moved the cursor over the hero — scene fades its idle sway. */
  touched: false,
  /** point the cloud at the cursor. nx/ny are the cursor position normalised to [0,1]. */
  aim(nx: number, ny: number) {
    heroOrbit.yaw = (nx - 0.5) * YAW_RANGE;
    heroOrbit.pitch = (ny - 0.5) * PITCH_RANGE;
  },
};
