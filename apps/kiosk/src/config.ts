const env = import.meta.env;

/** Accept a bare host (`gt-relay.onrender.com`, e.g. from Render's `fromService`) and
 *  default it to https; pass through anything that already has a scheme or is localhost. */
const withScheme = (url: string): string =>
  /^(https?:)?\/\//.test(url) || url.startsWith("localhost") ? url : `https://${url}`;

/** Relay server the kiosk connects to (architecture §1). */
export const RELAY_URL = withScheme(env.VITE_RELAY_URL ?? "http://localhost:3001");

/** This kiosk's long-lived room id; the QR is static for it (architecture §2). */
export const SESSION_ID = env.VITE_SESSION_ID ?? "gt-entrance";

/**
 * Controller app base. In dev the controller runs on its own Vite port (5174), so we
 * can't reuse the kiosk origin. For phone testing, set VITE_CONTROLLER_URL to your
 * machine's LAN address (same Wi-Fi) — `localhost` won't resolve from a phone.
 */
export const CONTROLLER_URL = withScheme(
  env.VITE_CONTROLLER_URL ?? `http://${location.hostname}:5174`,
);

/** The exact link the QR encodes: opens the controller pointed at this room. */
export const CONTROLLER_LINK = `${CONTROLLER_URL}/c/${SESSION_ID}`;

/**
 * Cursor + scroll feel (design-system §6). The phone streams raw finger deltas; the kiosk
 * turns them into screen px with pointer *ballistics* — slow finger = precise (base gain),
 * fast flick = fly across the screen (accelerated). The gain also scales up with screen
 * width so the same swipe crosses a large kiosk display, not just a dev laptop.
 *
 * Each knob resolves: **URL query param → env var → default**. The URL param matters for
 * the kiosk specifically: on a campus Wi-Fi with client isolation you can't test a phone
 * against a local dev server, so feel must be tuned on the deployed kiosk — and a redeploy
 * per tweak is slow. Instead, append params to the kiosk URL and reload, e.g.
 *   /?scrollMax=16&scrollAccel=0.04&sens=2.4
 * Once a value feels right, bake it as the default here so it ships without the param.
 */
const params =
  typeof location !== "undefined" ? new URLSearchParams(location.search) : new URLSearchParams();

/** Resolve a numeric knob: `?key=` URL param first, then env var, then the default. */
const tune = (key: string, envVal: string | undefined, def: number): number => {
  const p = params.get(key);
  if (p !== null && p.trim() !== "" && !Number.isNaN(Number(p))) return Number(p);
  return Number(envVal ?? def);
};

/** Base gain at slow finger speed (px on screen per px of finger, before acceleration). */
export const SENSITIVITY = tune("sens", env.VITE_SENSITIVITY, 2);
/** How hard a fast flick accelerates: extra gain per px of per-frame finger travel. */
export const CURSOR_ACCEL = tune("cursorAccel", env.VITE_CURSOR_ACCEL, 0.08);
/** Hard ceiling on the per-message gain so a dropped-frame burst can't fling the cursor. */
export const CURSOR_MAX_GAIN = tune("cursorMax", env.VITE_CURSOR_MAX_GAIN, 14);
/** Inertia: fraction of the gap the cursor closes each frame. Higher = snappier/less lag. */
export const CURSOR_FOLLOW = tune("cursorFollow", env.VITE_CURSOR_FOLLOW, 0.3);
/** Base gain at slow scroll speed. The home has several long pinned sections, so scroll
 *  gets its own ballistics like the cursor — independent of cursor accel. */
export const SCROLL_SENSITIVITY = tune("scrollSens", env.VITE_SCROLL_SENSITIVITY, 6);
/** Extra scroll gain per px of per-frame finger travel (fast-flick acceleration). Kept
 *  gentle: the home's WebGL sections are scrubbed on scroll, so an over-aggressive flick
 *  requests a scroll velocity the GPU can't redraw smoothly → stutter. */
export const SCROLL_ACCEL = tune("scrollAccel", env.VITE_SCROLL_ACCEL, 0.025);
/** Ceiling on the per-message scroll gain so a fast flick can't outrun the WebGL redraw. */
export const SCROLL_MAX_GAIN = tune("scrollMax", env.VITE_SCROLL_MAX_GAIN, 12);
/** Hold-to-scroll velocity (page px per frame ≈ ×60 for px/sec) while a ↑/↓ button is held.
 *  Kiosk-driven and constant, so it stays smooth regardless of wireless jitter. */
export const SCROLL_HOLD_SPEED = tune("holdSpeed", env.VITE_SCROLL_HOLD_SPEED, 40);
