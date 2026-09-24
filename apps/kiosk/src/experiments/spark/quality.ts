/**
 * Local-only maximum-quality profile for the campus Gaussian.
 *
 * The 13M SOG is intentionally git-ignored, so a committed default must never require it.
 * Developers who have the generated Streamed SOG can enable this through
 * apps/kiosk/.env.local; production and fresh clones remain on the deployable 1.8M tier.
 * URL parameters still override the individual defaults for A/B testing.
 */
export const LOCAL_GAUSSIAN_ULTRA =
  import.meta.env.VITE_GAUSSIAN_LOCAL_ULTRA === "1";

export const DEFAULT_SHOWREEL_ASSET = LOCAL_GAUSSIAN_ULTRA ? "local" : "mid";
export const DEFAULT_GAUSSIAN_DPR_CAP = LOCAL_GAUSSIAN_ULTRA ? 2 : 1.5;
// SuperSplat itself defaults to a 4M desktop budget. This kiosk has one known display/laptop,
// and the measured WebGPU path holds its 30Hz presentation ceiling at 8M, so the local quality
// reference can spend the extra detail without reviving the old all-in-memory failure.
export const DEFAULT_GAUSSIAN_SPLAT_BUDGET = 8_000_000;
