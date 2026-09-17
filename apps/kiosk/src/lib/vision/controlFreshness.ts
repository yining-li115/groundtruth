/** Freshness must follow the rate this laptop can actually produce results at, with a cap. */
export const CONTROL_FRESH_MIN_MS = 120;
export const CONTROL_FRESH_MAX_MS = 800;
/**
 * A closed hand is the pose MediaPipe is most likely to miss for one or two frames. Preserve an
 * already-owned UI transaction through that short observation hole, but never manufacture an
 * open/release from it. This is an additive grace after the adaptive freshness lease: loaded
 * Gaussian pages may consume most of that lease before a result is delivered, while the grace
 * describes how long an already-owned transaction may coast after that result stops being live.
 */
export const CONTROL_TRACKING_GAP_GRACE_MS = 350;
/**
 * Results older than this when inference completes are observations of the past, not live
 * control input. Gaussian rendering and MediaPipe share a GPU on the kiosk, so a loaded laptop
 * may legitimately take 300–450ms. Beyond 500ms the feedback loop is no longer interactive;
 * extending its post-completion TTL would only authorize a visibly historical pose.
 */
export const CONTROL_MAX_INFERENCE_MS = 500;
/**
 * Recognition needs an uninterrupted decoded-frame timeline. Beyond this gap, elapsed-time
 * latches would otherwise count time in which the camera supplied no evidence at all.
 */
export const CONTROL_MAX_SAMPLE_GAP_MS = CONTROL_FRESH_MAX_MS;

/**
 * A decoder can be healthy while inference is permanently too old to control anything. Give
 * short thermal/scheduling spikes room to recover, then fail explicitly instead of leaving an
 * installation in an endless "running but every result is rejected" state.
 */
export const CONTROL_SLOW_INFERENCE_GRACE_MS = 2_500;
export const CONTROL_SLOW_INFERENCE_MIN_FRAMES = 6;

export interface InferenceHealthState {
  overBudget: boolean;
  terminal: boolean;
  consecutiveFrames: number;
  elapsedMs: number;
}

export class InferenceHealthMonitor {
  private firstOverBudgetAt = 0;
  private consecutiveFrames = 0;

  constructor(
    private readonly maxInferenceMs = CONTROL_MAX_INFERENCE_MS,
    private readonly graceMs = CONTROL_SLOW_INFERENCE_GRACE_MS,
    private readonly minFrames = CONTROL_SLOW_INFERENCE_MIN_FRAMES,
  ) {}

  update(inferenceMs: number, processedAtMs: number): InferenceHealthState {
    const overBudget =
      !Number.isFinite(inferenceMs) ||
      inferenceMs < 0 ||
      inferenceMs > this.maxInferenceMs;
    if (!overBudget) {
      this.reset();
      return { overBudget: false, terminal: false, consecutiveFrames: 0, elapsedMs: 0 };
    }

    const at = Number.isFinite(processedAtMs) ? processedAtMs : this.firstOverBudgetAt;
    if (this.consecutiveFrames === 0) this.firstOverBudgetAt = at;
    this.consecutiveFrames += 1;
    const elapsedMs = Math.max(0, at - this.firstOverBudgetAt);
    return {
      overBudget: true,
      terminal: this.consecutiveFrames >= this.minFrames && elapsedMs >= this.graceMs,
      consecutiveFrames: this.consecutiveFrames,
      elapsedMs,
    };
  }

  reset(): void {
    this.firstOverBudgetAt = 0;
    this.consecutiveFrames = 0;
  }
}

export interface ControlFreshnessConfig {
  minMs: number;
  maxMs: number;
  periodMultiplier: number;
  periodMarginMs: number;
  inferenceMultiplier: number;
  inferenceMarginMs: number;
  emaAlpha: number;
}

export const DEFAULT_CONTROL_FRESHNESS: ControlFreshnessConfig = {
  minMs: CONTROL_FRESH_MIN_MS,
  maxMs: CONTROL_FRESH_MAX_MS,
  periodMultiplier: 2.25,
  periodMarginMs: 25,
  inferenceMultiplier: 1.5,
  inferenceMarginMs: 40,
  emaAlpha: 0.22,
};

export function controlFreshnessBudget(
  resultPeriodMs: number,
  inferenceMs: number,
  config: ControlFreshnessConfig = DEFAULT_CONTROL_FRESHNESS,
): number {
  const period = Number.isFinite(resultPeriodMs) && resultPeriodMs > 0 ? resultPeriodMs : 0;
  const inference =
    Number.isFinite(inferenceMs) && inferenceMs > 0 && inferenceMs <= CONTROL_MAX_INFERENCE_MS
      ? inferenceMs
      : 0;
  const requested = Math.max(
    config.minMs,
    period * config.periodMultiplier + config.periodMarginMs,
    inference * config.inferenceMultiplier + config.inferenceMarginMs,
  );
  return Math.min(config.maxMs, Math.max(config.minMs, requested));
}

/** Rolling completion cadence. Capture FPS alone misses the model/GPU load after calibration. */
export class ControlFreshnessEstimator {
  private readonly config: ControlFreshnessConfig;
  private lastProcessedAt = 0;
  private periodMs = 0;
  private inferenceMs = 0;

  constructor(config: Partial<ControlFreshnessConfig> = {}) {
    this.config = { ...DEFAULT_CONTROL_FRESHNESS, ...config };
  }

  update(processedAtMs: number, inferenceMs: number): number {
    // An over-age result is rejected by `hasFreshOwner`. Do not also let that outlier enlarge
    // the TTL of later good results; continuity code resets this estimator at the boundary.
    if (
      Number.isFinite(inferenceMs) &&
      inferenceMs >= 0 &&
      inferenceMs <= CONTROL_MAX_INFERENCE_MS
    ) {
      this.inferenceMs = this.ema(this.inferenceMs, inferenceMs);
    }
    if (Number.isFinite(processedAtMs) && processedAtMs > 0) {
      const period = this.lastProcessedAt > 0 ? processedAtMs - this.lastProcessedAt : 0;
      if (period > 0 && period <= 2_000) this.periodMs = this.ema(this.periodMs, period);
      this.lastProcessedAt = processedAtMs;
    }
    return controlFreshnessBudget(this.periodMs, this.inferenceMs, this.config);
  }

  reset(): void {
    this.lastProcessedAt = 0;
    this.periodMs = 0;
    this.inferenceMs = 0;
  }

  private ema(previous: number, value: number): number {
    return previous > 0
      ? previous + (value - previous) * this.config.emaAlpha
      : value;
  }
}
