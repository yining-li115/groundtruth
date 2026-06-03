/** Relay runtime config. All overridable via env so deploy targets stay flexible. */
export const config = {
  /** TCP port the socket.io server listens on. */
  port: Number(process.env.PORT ?? 3001),
  /**
   * Allowed CORS origin(s) for the socket.io handshake. Dev default is permissive;
   * lock this down to the kiosk/controller origins in production.
   */
  corsOrigin: process.env.CORS_ORIGIN ?? "*",
  /**
   * Max input messages accepted from a driver per second (architecture §9). Excess is
   * dropped, not buffered — protects the kiosk from a flooding/tampering client.
   */
  inputRateLimitPerSec: Number(process.env.INPUT_RATE_LIMIT ?? 200),
} as const;
