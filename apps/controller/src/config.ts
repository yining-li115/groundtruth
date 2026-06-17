/** Accept a bare host (`gt-relay.onrender.com`, e.g. from Render's `fromService`) and
 *  default it to https; pass through anything that already has a scheme or is localhost. */
const withScheme = (url: string): string =>
  /^(https?:)?\/\//.test(url) || url.startsWith("localhost") ? url : `https://${url}`;

/** Relay server the controller connects to (architecture §1). */
export const RELAY_URL = withScheme(import.meta.env.VITE_RELAY_URL ?? "http://localhost:3001");
