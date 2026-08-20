/**
 * The 1€ filter (Casiez, Roussel & Vogel, CHI 2012) — the standard answer to noisy
 * interactive input, and the one Quest's own hand tracking research reaches for.
 *
 * Smoothing a pointer normally forces a choice nobody wants to make: filter hard and the
 * cursor is steady but lags behind the hand, filter lightly and it keeps up but shakes. The
 * trick here is that the two problems never occur at the same moment. Jitter is only
 * objectionable when the hand is still, and lag is only objectionable when it is moving — so
 * the cutoff frequency is driven by the measured speed of the signal itself: heavy smoothing
 * at rest, opened right up during a fast move.
 *
 * Two parameters, tuned in a fixed order:
 *   `minCutoff` — lower it until a still hand produces a still cursor.
 *   `beta`      — raise it until a fast hand stops dragging the cursor behind it.
 */

/** Smoothing factor for a first-order low-pass at cutoff `fc`, given a timestep. */
function alpha(fc: number, dt: number): number {
  const tau = 1 / (2 * Math.PI * fc);
  return 1 / (1 + tau / dt);
}

class LowPass {
  private y: number | null = null;

  filter(x: number, a: number): number {
    this.y = this.y === null ? x : a * x + (1 - a) * this.y;
    return this.y;
  }

  get last(): number | null {
    return this.y;
  }

  reset(): void {
    this.y = null;
  }
}

export interface OneEuroConfig {
  /** Hz. Lower = less jitter when still. */
  minCutoff: number;
  /** Speed coefficient. Higher = less lag when moving fast. */
  beta: number;
  /** Hz, for filtering the speed estimate itself. 1 Hz is the paper's default and rarely moved. */
  dCutoff: number;
}

/**
 * BETA IS NOT UNIT-FREE. The published default of 0.007 assumes an input measured in pixels
 * or centimetres, where a brisk movement has a speed in the hundreds and `beta × speed`
 * therefore opens the cutoff by a useful amount. This filter is fed positions normalised to
 * 0..1 of the screen, where the same movement has a speed near 1.7 — so 0.007 contributes
 * essentially nothing and the adaptive half of the filter is silently disconnected, leaving a
 * plain low-pass that drags.
 *
 * Measured on the recorded hand data: replaying a fast half-screen sweep, 0.007 left the
 * cursor 1299 px behind at 4K, while 10 left it 59 px behind — at identical jitter, because
 * a still hand has no speed for beta to act on. Beta costs nothing at rest, so it is set
 * generously.
 *
 * Values below are for INPUT IN UNIT SCREEN COORDINATES. Feeding this pixels instead means
 * dividing beta by roughly the screen width.
 */
export const DEFAULT_ONE_EURO: OneEuroConfig = {
  minCutoff: 0.4,
  beta: 10,
  dCutoff: 1.0,
};

export class OneEuroFilter {
  private readonly x = new LowPass();
  private readonly dx = new LowPass();
  private tPrev: number | null = null;
  private xPrev: number | null = null;

  constructor(private cfg: OneEuroConfig = { ...DEFAULT_ONE_EURO }) {}

  /** Live-tunable, so a slider can change the feel without dropping the filter's state. */
  configure(cfg: Partial<OneEuroConfig>): void {
    this.cfg = { ...this.cfg, ...cfg };
  }

  /** `tMs` is any monotonic millisecond clock (performance.now()). */
  filter(value: number, tMs: number): number {
    if (this.tPrev === null || this.xPrev === null) {
      this.tPrev = tMs;
      this.xPrev = value;
      return this.x.filter(value, 1);
    }
    // A dropped frame or a tab that was backgrounded can produce a huge or zero dt, either of
    // which makes the filter coefficients meaningless — clamp to a sane frame interval rather
    // than letting one bad timestamp knock the cursor across the screen.
    const dt = Math.min(0.2, Math.max(1 / 240, (tMs - this.tPrev) / 1000));
    this.tPrev = tMs;

    const speed = (value - this.xPrev) / dt;
    this.xPrev = value;
    const edx = this.dx.filter(speed, alpha(this.cfg.dCutoff, dt));
    const cutoff = this.cfg.minCutoff + this.cfg.beta * Math.abs(edx);
    return this.x.filter(value, alpha(cutoff, dt));
  }

  /** Forget history — call when the hand was lost, so the next hand doesn't glide in from the old one. */
  reset(): void {
    this.x.reset();
    this.dx.reset();
    this.tPrev = null;
    this.xPrev = null;
  }
}

/** Two independent 1€ filters, for a screen position. */
export class OneEuroPoint {
  private readonly fx: OneEuroFilter;
  private readonly fy: OneEuroFilter;

  constructor(cfg: OneEuroConfig = { ...DEFAULT_ONE_EURO }) {
    this.fx = new OneEuroFilter({ ...cfg });
    this.fy = new OneEuroFilter({ ...cfg });
  }

  configure(cfg: Partial<OneEuroConfig>): void {
    this.fx.configure(cfg);
    this.fy.configure(cfg);
  }

  filter(x: number, y: number, tMs: number): { x: number; y: number } {
    return { x: this.fx.filter(x, tMs), y: this.fy.filter(y, tMs) };
  }

  reset(): void {
    this.fx.reset();
    this.fy.reset();
  }
}
