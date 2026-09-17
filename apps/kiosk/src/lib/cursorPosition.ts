/**
 * Shared on-screen hand-cursor position (viewport pixels). `HandControl.tsx` publishes its
 * stabilized position here so other effects — e.g. the LiquidEther cursor-fluid — follow the
 * same pointer without re-deriving it or churning the Zustand store. `moved` is a timestamp of
 * the last real position change, so consumers can tell "idle" from "moving".
 */
export const cursorPosition = {
  x: typeof window !== "undefined" ? window.innerWidth / 2 : 0,
  y: typeof window !== "undefined" ? window.innerHeight / 2 : 0,
  /** performance.now() of the last position change; 0 until the cursor first moves. */
  moved: 0,
};

/** Called by HandControl when its stabilized on-screen position changes. */
export function setCursorPosition(x: number, y: number) {
  if (x !== cursorPosition.x || y !== cursorPosition.y) {
    cursorPosition.x = x;
    cursorPosition.y = y;
    cursorPosition.moved = performance.now();
  }
}

// Real-mouse fallback for desktop development. Prefer it only while it is actively moving;
// otherwise effects follow the camera-driven hand cursor.
let realX = 0;
let realY = 0;
let realMoved = 0;
if (typeof window !== "undefined") {
  window.addEventListener(
    "mousemove",
    (e) => {
      realX = e.clientX;
      realY = e.clientY;
      realMoved = performance.now();
    },
    { passive: true },
  );
}

/**
 * The pointer cursor-following effects (LiquidEther) should track: the real mouse while it's
 * moving (dev), else the camera-driven hand cursor, else null (nothing has moved yet → effects
 * can idle). Returns viewport pixels.
 */
export function activePointer(): { x: number; y: number } | null {
  const now = performance.now();
  if (realMoved && now - realMoved < 1500) return { x: realX, y: realY };
  if (cursorPosition.moved) return { x: cursorPosition.x, y: cursorPosition.y };
  return null;
}
