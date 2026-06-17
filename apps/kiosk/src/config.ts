const env = import.meta.env;

/** Relay server the kiosk connects to (architecture §1). */
export const RELAY_URL = env.VITE_RELAY_URL ?? "http://localhost:3001";

/** This kiosk's long-lived room id; the QR is static for it (architecture §2). */
export const SESSION_ID = env.VITE_SESSION_ID ?? "gt-entrance";

/**
 * Controller app base. In dev the controller runs on its own Vite port (5174), so we
 * can't reuse the kiosk origin. For phone testing, set VITE_CONTROLLER_URL to your
 * machine's LAN address (same Wi-Fi) — `localhost` won't resolve from a phone.
 */
export const CONTROLLER_URL =
  env.VITE_CONTROLLER_URL ?? `http://${location.hostname}:5174`;

/** The exact link the QR encodes: opens the controller pointed at this room. */
export const CONTROLLER_LINK = `${CONTROLLER_URL}/c/${SESSION_ID}`;

/**
 * Cursor feel (design-system §6). The phone streams raw finger deltas; the kiosk turns
 * them into screen px with pointer *ballistics* — slow finger = precise (base gain),
 * fast flick = fly across the screen (accelerated). The gain also scales up with screen
 * width so the same swipe crosses a large kiosk display, not just a dev laptop.
 *
 * All env-overridable so the feel can be tuned on the real kiosk hardware without a
 * rebuild of intent (e.g. `VITE_SENSITIVITY=2.4`).
 */
/** Base gain at slow finger speed (px on screen per px of finger, before acceleration). */
export const SENSITIVITY = Number(env.VITE_SENSITIVITY ?? 2);
/** How hard a fast flick accelerates: extra gain per px of per-frame finger travel. */
export const CURSOR_ACCEL = Number(env.VITE_CURSOR_ACCEL ?? 0.08);
/** Hard ceiling on the per-message gain so a dropped-frame burst can't fling the cursor. */
export const CURSOR_MAX_GAIN = Number(env.VITE_CURSOR_MAX_GAIN ?? 14);
/** Inertia: fraction of the gap the cursor closes each frame. Higher = snappier/less lag. */
export const CURSOR_FOLLOW = Number(env.VITE_CURSOR_FOLLOW ?? 0.3);
/**
 * Two-finger scroll → page px (independent of cursor accel). The home has several long
 * pinned sections, so scroll gets its own ballistics like the cursor: a slow drag is
 * precise (base gain), a fast flick accelerates to cover a lot of ground per swipe.
 */
/** Base gain at slow scroll speed. */
export const SCROLL_SENSITIVITY = Number(env.VITE_SCROLL_SENSITIVITY ?? 6);
/** Extra scroll gain per px of per-frame finger travel (fast-flick acceleration). */
export const SCROLL_ACCEL = Number(env.VITE_SCROLL_ACCEL ?? 0.06);
/** Ceiling on the per-message scroll gain so a fast flick can't teleport the page. */
export const SCROLL_MAX_GAIN = Number(env.VITE_SCROLL_MAX_GAIN ?? 24);
