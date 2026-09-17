export interface PointerStabilizerConfig {
  minRadius: number;
  maxRadius: number;
  noiseMultiplier: number;
  /** Milliseconds for the residual-noise envelope to approach a new level. */
  noiseTimeConstantMs: number;
  /** Milliseconds for the constant-velocity predictor to learn intentional motion. */
  motionTimeConstantMs: number;
  maxNoiseStep: number;
}

export const DEFAULT_POINTER_STABILIZER: PointerStabilizerConfig = {
  minRadius: 0.0025,
  maxRadius: 0.01,
  noiseMultiplier: 3,
  noiseTimeConstantMs: 240,
  motionTimeConstantMs: 120,
  maxNoiseStep: 0.014,
};

const MIN_DT_S = 1 / 240;
const MAX_DT_S = 0.2;

/** Exact first-order response for a wall-clock time constant. */
function timeAlpha(dtS: number, tauMs: number): number {
  if (!(tauMs > 0)) return 1;
  return -Math.expm1(-(dtS * 1000) / tauMs);
}

/**
 * Owner-scoped sticky deadband applied after OneEuro filtering.
 *
 * Tiny decoded-frame movement updates a bounded noise estimate but does not move the cursor.
 * Once intentional travel leaves that radius, subtracting (rather than jumping across) the
 * radius keeps motion continuous. The estimate is driven by the residual from a
 * constant-velocity predictor, not by distance travelled per frame: a slow movement has a
 * predictable direction and must not be learned as camera noise. Every response coefficient
 * is derived from decoded-sample time, so rendering at 15, 30, or 60 fps does not change the
 * cursor's feel. Nothing is persisted: a new owner starts clean, and raw scene coordinates
 * never pass through this class.
 */
export class PointerStabilizer {
  private readonly cfg: PointerStabilizerConfig;
  private has = false;
  private outX = 0.5;
  private outY = 0.5;
  private prevX = 0.5;
  private prevY = 0.5;
  private velocityX = 0;
  private velocityY = 0;
  private lastAtMs: number | null = null;
  private noise = 0;

  constructor(config: Partial<PointerStabilizerConfig> = {}) {
    this.cfg = { ...DEFAULT_POINTER_STABILIZER, ...config };
  }

  filter(
    x: number,
    y: number,
    eligible: boolean,
    sampleAtMs: number,
  ): { x: number; y: number; radius: number } {
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      return { x: this.outX, y: this.outY, radius: this.radius() };
    }
    if (!this.has) {
      this.has = true;
      this.outX = this.prevX = x;
      this.outY = this.prevY = y;
      this.lastAtMs = Number.isFinite(sampleAtMs) ? sampleAtMs : null;
      return { x, y, radius: this.radius() };
    }

    // Production always supplies a decoded-frame timestamp. If a malformed clock slips
    // through, use the shortest supported interval: it may delay adaptation for one sample,
    // but cannot make a large elapsed gap masquerade as measured camera noise.
    const rawDtS =
      this.lastAtMs !== null && Number.isFinite(sampleAtMs)
        ? (sampleAtMs - this.lastAtMs) / 1000
        : MIN_DT_S;
    const dtS = Math.min(MAX_DT_S, Math.max(MIN_DT_S, rawDtS));
    if (Number.isFinite(sampleAtMs)) this.lastAtMs = sampleAtMs;

    const dx = x - this.prevX;
    const dy = y - this.prevY;
    const predictedX = this.prevX + this.velocityX * dtS;
    const predictedY = this.prevY + this.velocityY * dtS;
    const residual = Math.hypot(x - predictedX, y - predictedY);

    const motionAlpha = timeAlpha(dtS, this.cfg.motionTimeConstantMs);
    this.velocityX += (dx / dtS - this.velocityX) * motionAlpha;
    this.velocityY += (dy / dtS - this.velocityY) * motionAlpha;
    this.prevX = x;
    this.prevY = y;

    // Large predictor misses are deliberate travel, a discontinuity, or a bad landmark. None
    // is evidence that the stationary deadband should grow. Decaying toward zero also returns
    // the pointer to the minimum radius promptly after a movement begins.
    const noiseTarget = residual <= this.cfg.maxNoiseStep ? residual : 0;
    const noiseAlpha = timeAlpha(dtS, this.cfg.noiseTimeConstantMs);
    this.noise += (noiseTarget - this.noise) * noiseAlpha;

    if (!eligible) {
      this.outX = x;
      this.outY = y;
      return { x, y, radius: this.radius() };
    }

    const radius = this.radius();
    const outDx = x - this.outX;
    const outDy = y - this.outY;
    const distance = Math.hypot(outDx, outDy);
    if (distance <= radius || distance <= 1e-9) {
      return { x: this.outX, y: this.outY, radius };
    }

    const travel = distance - radius;
    this.outX += (outDx / distance) * travel;
    this.outY += (outDy / distance) * travel;
    return { x: this.outX, y: this.outY, radius };
  }

  reset(): void {
    this.has = false;
    this.outX = this.prevX = 0.5;
    this.outY = this.prevY = 0.5;
    this.velocityX = 0;
    this.velocityY = 0;
    this.lastAtMs = null;
    this.noise = 0;
  }

  private radius(): number {
    return Math.max(
      this.cfg.minRadius,
      Math.min(this.cfg.maxRadius, this.noise * this.cfg.noiseMultiplier),
    );
  }
}
