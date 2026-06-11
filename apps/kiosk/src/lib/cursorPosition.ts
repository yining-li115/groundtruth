/**
 * Shared on-screen cursor position (viewport pixels). `Cursor.tsx` is the authority for the
 * kiosk pointer (it integrates the phone's relative deltas); it writes its smoothed position
 * here every frame so other effects — e.g. the LiquidEther cursor-fluid — can follow the SAME
 * cursor without re-deriving it or churning the zustand store. `moved` is a timestamp of the
 * last real position change, so consumers can tell "idle" from "moving".
 */
export const cursorPosition = {
  x: typeof window !== "undefined" ? window.innerWidth / 2 : 0,
  y: typeof window !== "undefined" ? window.innerHeight / 2 : 0,
  /** performance.now() of the last position change; 0 until the cursor first moves. */
  moved: 0,
};

/** Called by Cursor.tsx each frame with its smoothed position. */
export function setCursorPosition(x: number, y: number) {
  if (x !== cursorPosition.x || y !== cursorPosition.y) {
    cursorPosition.x = x;
    cursorPosition.y = y;
    cursorPosition.moved = performance.now();
  }
}

// Real-mouse fallback. The kiosk has no mouse (the phone-driven gt-cursor is the only pointer),
// but on a dev desktop we want effects to follow the real mouse. We track it here and prefer it
// only while it's actively moving; otherwise we fall back to the kiosk cursor.
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
 * moving (dev), else the phone-driven kiosk cursor, else null (nothing has moved yet → effects
 * can idle). Returns viewport pixels.
 */
export function activePointer(): { x: number; y: number } | null {
  const now = performance.now();
  if (realMoved && now - realMoved < 1500) return { x: realX, y: realY };
  if (cursorPosition.moved) return { x: cursorPosition.x, y: cursorPosition.y };
  return null;
}
