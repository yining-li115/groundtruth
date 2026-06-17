/** Relay runtime config. All overridable via env so deploy targets stay flexible. */
export const config = {
  /** TCP port the socket.io server listens on. */
  port: Number(process.env.PORT ?? 3001),
  /**
   * Allowed CORS origin(s) for the socket.io handshake. Dev default is permissive (`*`);
   * in production set CORS_ORIGIN to the kiosk + controller URLs (comma-separated) to
   * lock it down, e.g. `CORS_ORIGIN=https://gt-kiosk.onrender.com,https://gt-controller.onrender.com`.
   */
  corsOrigin: parseCorsOrigin(process.env.CORS_ORIGIN),
  /**
   * Max input messages accepted from a driver per second (architecture §9). Excess is
   * dropped, not buffered — protects the kiosk from a flooding/tampering client.
   */
  inputRateLimitPerSec: Number(process.env.INPUT_RATE_LIMIT ?? 200),
} as const;

/** `*` (or unset) → permissive; otherwise a comma-separated allow-list of origins. */
function parseCorsOrigin(raw: string | undefined): string | string[] {
  if (!raw || raw.trim() === "*") return "*";
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}
