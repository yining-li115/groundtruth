import type { HandFlight } from "./useHandFlight";

/**
 * Flight intent, published by the global hand control and read by the campus flight.
 *
 * The showreel used to open its OWN camera and run its own copy of the models, which was
 * fine while it was the only thing on screen and became a real problem the moment the whole
 * kiosk grew a hand pointer: two `getUserMedia` streams, two MediaPipe engines competing for
 * the GPU, and a frame rate roughly halved — which shows up not as an error but as an
 * interaction that feels mushy for no visible reason.
 *
 * So there is exactly one camera pipeline now, and this is how its output reaches the parts
 * of the app that want more than a cursor. Same pattern as `cursorPosition` and `heroInput`:
 * a plain mutable singleton the render loops read, rather than state that would re-render the
 * tree sixty times a second.
 *
 * The values are INTENT, never position — directions in −1/0/1 that the camera loop
 * integrates. That contract is what keeps a dropped frame meaning "stop" instead of "jump".
 */
export const flightInput: HandFlight = {
  present: false,
  dolly: 0,
  mode: "none",
  fingers: [],
  yaw: 0,
  strafe: 0,
  lift: 0,
  handCount: 0,
  hands: [],
  gesture: "None",
};

/**
 * How far from the middle of the screen the hand must be before the camera starts moving
 * that way, and how far back it must come to stop. Two thresholds, so a hand resting near
 * the boundary doesn't chatter between moving and stopped.
 */
export const FLY_ON = 0.18;
export const FLY_OFF = 0.12;

/** Latch a direction with hysteresis: takes FLY_ON to start, a fall below FLY_OFF to stop. */
function latch(prev: number, offset: number): number {
  if (Math.abs(offset) > FLY_ON) return Math.sign(offset);
  if (Math.abs(offset) < FLY_OFF) return 0;
  return prev;
}

/**
 * Turn a cursor position into flight intent.
 *
 * Measured from screen CENTRE rather than from where some gesture began, because the tour
 * hands over the moment a hand is seen: a visitor should be flying the model immediately,
 * not first having to discover that some grip unlocks it. That leaves a large central resting
 * zone where the camera holds still, which is what makes it possible to look at anything.
 *
 * `holdStill` is for when the hand is over a control — aiming at a button is not flying, and
 * without this the camera drags along with the reach and the button runs away from the hand
 * trying to press it.
 *
 * A pure function rather than something buried in the render loop so it can be tested; the
 * cases that matter (does the deadzone hold, does hysteresis stop the chatter, does hovering
 * a control stop the camera) are all ones a browser cannot conveniently be asked about.
 */
export function steer(
  x: number,
  y: number,
  { holdStill = false }: { holdStill?: boolean } = {},
): void {
  flightInput.present = true;
  flightInput.mode = "look";
  if (holdStill || !Number.isFinite(x) || !Number.isFinite(y)) {
    flightInput.yaw = 0;
    flightInput.dolly = 0;
    return;
  }
  flightInput.yaw = latch(flightInput.yaw, x - 0.5);
  flightInput.dolly = latch(flightInput.dolly, 0.5 - y); // hand high = fly forward
}

/** Reset to a full stop — used when the hand leaves, so the camera never coasts on stale intent. */
export function stopFlight(): void {
  flightInput.present = false;
  flightInput.dolly = 0;
  flightInput.yaw = 0;
  flightInput.strafe = 0;
  flightInput.lift = 0;
  flightInput.mode = "none";
  flightInput.handCount = 0;
  flightInput.hands = [];
}
