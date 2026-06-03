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

/** Trackpad delta → screen px, with inertia applied in the Cursor (design-system §6). */
export const SENSITIVITY = Number(env.VITE_SENSITIVITY ?? 2);
