import { JOINT, type FaceResult, type Landmark } from "./mediapipe";

/**
 * Automatic calibration for hand pointing — no setup step, no visitor cooperation.
 *
 * The problem this solves: a fixed mapping from "where the hand is in the camera frame" to
 * "where the cursor is on the screen" is wrong for everyone except the one person it was
 * tuned for. Stand closer and your whole arm sweep covers the frame twice over (measured:
 * at 0.5 m a comfortable sweep left the frame entirely, and tracking survived only 48% of
 * it). Stand further and the same sweep moves the cursor a few centimetres. Be shorter and
 * the whole mapping sits too high.
 *
 * Rather than calibrate per distance, the mapping is defined so distance cancels out:
 *
 *   1. SCALE comes from the visitor's own face. Face width is near enough a physical
 *      constant across adults (~15 cm), so its width in frame IS the scale of everything
 *      else at that distance — a ruler that walks in with every visitor and never has to be
 *      asked for. No distance is measured, and none needs to be.
 *
 *   2. The INTERACTION BOX is expressed in face widths and anchored to the face, so it
 *      travels with the person and rescales itself as they move. A hand halfway across the
 *      box points halfway across the screen whether the visitor is at one metre or three,
 *      is tall or short, stands centred or off to one side.
 *
 *   3. The PINCH THRESHOLD rides a rolling estimate of that hand's own open posture, so hand
 *      shape and finger length stop mattering too.
 *
 * What this deliberately does NOT fix: whether the camera can RESOLVE a hand at all at a
 * given distance. That is optics, not geometry, and no amount of calibration invents detail
 * the sensor never captured — so the confidence figure below exists to let the interaction
 * say "I can't see well enough" instead of producing a cursor that jitters and lies.
 *
 * Everything here takes raw, un-mirrored frame coordinates (as MediaPipe reports them) and
 * mirrors only at the point where a screen position is produced — mixing the two conventions
 * mid-pipeline is the classic source of a cursor that moves the wrong way for one input only.
 */

/** The interaction box, in face widths. Tuned once, then valid at every distance. */
export interface BoxConfig {
  /** how wide the box is, in face widths — a comfortable full sweep of both arms */
  widthFaces: number;
  /** how tall */
  heightFaces: number;
  /** how far the box centre sits BELOW the centre of the face — roughly chest height */
  dropFaces: number;
}

/**
 * Defaults in physical terms, taking a face as ~15 cm wide: a box about 68 cm wide and 45 cm
 * tall, centred ~39 cm below the eyes. That is the region a standing person's hand covers
 * without leaning or reaching, which is the region the mapping should spend the screen on.
 */
export const DEFAULT_BOX: BoxConfig = {
  widthFaces: 4.5,
  heightFaces: 3.0,
  dropFaces: 2.6,
};

export interface InteractionBox {
  /** raw frame coordinates, [0,1] per axis */
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  w: number;
  h: number;
  /** the face width this was derived from — the scale ruler, kept for callers */
  faceW: number;
  /**
   * True when the box was too big for the frame and had to be CUT. This is the "too close"
   * signal: the visitor will run out of camera before they run out of arm, and part of the
   * screen is unreachable however good tracking is.
   */
  clamped: boolean;
  /**
   * True when the box still fitted but had to be SLID back inside the frame — normally
   * upward, because at close range the chest sits below the bottom edge.
   *
   * Sliding rather than cutting matters more than it sounds. Cutting shrinks the box, and the
   * box size IS the gain of the mapping, so a cut box silently changes how far the cursor
   * travels per centimetre of hand — and it collapses whichever axis overflowed, which is how
   * a perfectly good mapping ends up sliding only sideways. Sliding keeps the gain exact and
   * gives up only the chest-height anchor, which is a preference, not a requirement.
   */
  shifted: boolean;
}

/**
 * Build the box from a detected face.
 *
 * `aspect` is frame width / height. It is needed because normalised coordinates are not
 * isotropic: 0.1 across is a different physical length from 0.1 down on any non-square
 * frame, so a box specified in face widths would come out squashed without it.
 */
export function interactionBox(
  face: FaceResult | null,
  aspect: number,
  cfg: BoxConfig = DEFAULT_BOX,
): InteractionBox | null {
  if (!face || !(face.w > 0) || !Number.isFinite(aspect) || aspect <= 0) return null;
  const f = face.w; // face width in x-units — one "ruler unit"
  const halfW = (cfg.widthFaces * f) / 2;
  // y-units are compressed relative to x-units by the aspect ratio, so any vertical
  // measurement expressed in face widths has to be scaled by it to stay physically square.
  const halfH = (cfg.heightFaces * f * aspect) / 2;
  const cx = face.cx;
  const cy = face.cy + cfg.dropFaces * f * aspect;

  // Slide the box back inside the frame if it hangs over an edge, and only cut it if it is
  // genuinely larger than the frame. See `shifted` above for why the order matters.
  const fit = (lo: number, hi: number): { lo: number; hi: number; cut: boolean; slid: boolean } => {
    const size = hi - lo;
    if (size >= 1) return { lo: 0, hi: 1, cut: true, slid: false };
    if (lo < 0) return { lo: 0, hi: size, cut: false, slid: true };
    if (hi > 1) return { lo: 1 - size, hi: 1, cut: false, slid: true };
    return { lo, hi, cut: false, slid: false };
  };

  const fx = fit(cx - halfW, cx + halfW);
  const fy = fit(cy - halfH, cy + halfH);

  return {
    x0: fx.lo,
    y0: fy.lo,
    x1: fx.hi,
    y1: fy.hi,
    w: fx.hi - fx.lo,
    h: fy.hi - fy.lo,
    faceW: f,
    clamped: fx.cut || fy.cut,
    shifted: fx.slid || fy.slid,
  };
}

/**
 * Palm width as a fraction of face width, for a hand at the same distance.
 *
 * Only used by the fallback below, and only as a rough constant — hand-to-face proportion
 * varies between people far less than the error it is being asked to cover.
 */
const PALM_PER_FACE = 0.62;

/**
 * The box to use when there is no face at all.
 *
 * The face is the ruler, and losing it should degrade the mapping, not switch the pointer
 * off — but that is exactly what it did: presence required a box, a box required a face, and
 * so a visitor whose face the detector could not find (stood off to one side, backlit, or
 * simply occluded by the very hand they were pointing with) got no cursor and no explanation,
 * while the idle tour played on as though nobody were there.
 *
 * The hand can stand in as its own ruler: a palm is a fairly reliable fraction of a face, so
 * its width in frame gives the same scale the face would have. What it cannot give is where
 * the body is, so the box is centred on the frame — worse ergonomically than one anchored to
 * a chest, and enormously better than nothing.
 */
export function fallbackBox(
  palmNorm: number,
  aspect: number,
  cfg: BoxConfig = DEFAULT_BOX,
): InteractionBox | null {
  if (!(palmNorm > 0) || !Number.isFinite(aspect) || aspect <= 0) return null;
  const faceW = palmNorm / PALM_PER_FACE;
  // Centred, and with no drop: without a face there is nothing to measure a drop from.
  return interactionBox({ cx: 0.5, cy: 0.5, w: faceW, h: faceW * 1.3, score: 0 }, aspect, {
    ...cfg,
    dropFaces: 0,
  });
}

/**
 * A steadied face anchor: smoothed while visible, held for a moment when it is not.
 *
 * Two problems, one object, because they are the same problem seen at two timescales.
 *
 * The box is rebuilt from the face every frame, so the box IS the mapping — and a detection
 * that jitters by a few pixels moves the mapping under a perfectly still hand. That is a
 * source of cursor jitter no amount of filtering on the HAND can reach, because the hand
 * isn't what moved. A person's head does not move quickly, so the anchor can be smoothed hard
 * at almost no cost in responsiveness.
 *
 * And the face is occluded constantly in this interaction — by the very hand that is doing
 * the pointing, every time it passes in front. Rebuilding from nothing means the box vanishes
 * and the cursor dies exactly when someone reaches across themselves. Nobody teleports, so
 * the last known anchor stays valid for a second or two; coasting on it is both more accurate
 * and far less alarming than dropping the interaction.
 */
export class FaceAnchor {
  private cx = 0;
  private cy = 0;
  private w = 0;
  private h = 0;
  private lastSeen = 0;
  private has = false;

  constructor(
    /** per-frame approach rate; the head is slow, so this can be low */
    private readonly ease = 0.15,
    /** how long to keep using the last anchor after the face is lost, in ms */
    private readonly holdMs = 2000,
  ) {}

  /** True when the returned anchor is remembered rather than currently seen. */
  held = false;

  update(face: FaceResult | null, now: number): FaceResult | null {
    if (face && face.w > 0) {
      if (!this.has) {
        this.cx = face.cx;
        this.cy = face.cy;
        this.w = face.w;
        this.h = face.h;
        this.has = true;
      } else {
        this.cx += (face.cx - this.cx) * this.ease;
        this.cy += (face.cy - this.cy) * this.ease;
        this.w += (face.w - this.w) * this.ease;
        this.h += (face.h - this.h) * this.ease;
      }
      this.lastSeen = now;
      this.held = false;
      return { cx: this.cx, cy: this.cy, w: this.w, h: this.h, score: face.score };
    }

    if (this.has && now - this.lastSeen < this.holdMs) {
      this.held = true;
      return { cx: this.cx, cy: this.cy, w: this.w, h: this.h, score: 0 };
    }
    this.held = false;
    this.has = false;
    return null;
  }

  reset(): void {
    this.has = false;
    this.held = false;
  }
}

/**
 * Where the hand IS, for pointing purposes: the centre of the palm, not a fingertip.
 *
 * A fingertip is the intuitive choice and the wrong one. The fingers are what perform the
 * click, so a cursor tied to a fingertip lurches at the exact moment of selection — the
 * failure Vogel & Balakrishnan designed ThumbTrigger around on large displays. The palm
 * triangle (wrist and the two outer knuckles) is rigid, moves only when the whole hand
 * moves, and is the most reliably tracked part of the skeleton.
 */
export function palmCenter(lm: Landmark[] | undefined): { x: number; y: number } | null {
  const a = lm?.[JOINT.wrist];
  const b = lm?.[JOINT.indexMcp];
  const c = lm?.[JOINT.pinkyMcp];
  if (!a || !b || !c) return null;
  return { x: (a.x + b.x + c.x) / 3, y: (a.y + b.y + c.y) / 3 };
}

/** Palm width in frame x-units — how big the hand is on the sensor, i.e. how much detail we have. */
export function palmWidthNorm(lm: Landmark[] | undefined): number {
  const b = lm?.[JOINT.indexMcp];
  const c = lm?.[JOINT.pinkyMcp];
  if (!b || !c) return Number.NaN;
  return Math.hypot(b.x - c.x, b.y - c.y);
}

/** A hand position mapped into the box, as screen-space unit coordinates. */
export interface Mapped {
  /** 0 = screen left, 1 = screen right (mirror already applied) */
  u: number;
  /** 0 = screen top, 1 = screen bottom */
  v: number;
  /** true when the hand was outside the box and the value had to be clamped to an edge */
  outside: boolean;
}

/**
 * Map a raw frame position into the box.
 *
 * The mirror happens here and only here: the camera faces the visitor, so a hand moved to
 * their right appears further LEFT in the raw frame, and a cursor driven from it unmirrored
 * would run away from the hand.
 */
export function mapToBox(box: InteractionBox, p: { x: number; y: number }): Mapped {
  const uRaw = box.w > 0 ? (p.x - box.x0) / box.w : 0.5;
  const vRaw = box.h > 0 ? (p.y - box.y0) / box.h : 0.5;
  const outside = uRaw < 0 || uRaw > 1 || vRaw < 0 || vRaw > 1;
  const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
  return { u: 1 - clamp01(uRaw), v: clamp01(vRaw), outside };
}

/**
 * How much the interaction should trust itself right now, and why.
 *
 * Reported rather than silently absorbed, because the two ways this fails want opposite
 * responses from the visitor — standing too close and standing too far both produce a bad
 * cursor, and only the system knows which is happening.
 */
export interface Confidence {
  /** 0..1 */
  value: number;
  /** one of a fixed set, so the UI can map it to a hint rather than print a sentence */
  reason: "ok" | "no-face" | "too-close" | "too-far" | "hand-too-small" | "no-hand";
}

/**
 * A hand whose palm spans fewer than this many pixels has too little detail left for the
 * finger geometry a pinch is read from. Set from the measured working case: the pinch was
 * cleanly separable (d ≈ 42) with a palm spanning roughly a tenth of a 1280-wide frame.
 */
const MIN_PALM_PX = 42;

/**
 * How much of the frame the reach box may occupy before the visitor is simply too close.
 *
 * Once a comfortable arm sweep fills most of the frame, the hand spends part of every gesture
 * outside it and tracking drops — measured at 0.5 m, a full sweep survived only 48% of its
 * frames. The box fitting is not enough to rule this out, since the box is only the part of
 * the reach we chose to map; this asks the blunter question of whether the visitor's arm has
 * room to move in shot at all.
 */
const MAX_BOX_COVERAGE = 0.7;

export function confidence(
  face: FaceResult | null,
  box: InteractionBox | null,
  palmPx: number,
): Confidence {
  if (!box) return { value: 0, reason: face ? "no-hand" : "no-face" };
  if (!Number.isFinite(palmPx)) return { value: 0, reason: "no-hand" };
  // A box without a face is the hand-scaled fallback: usable, but centred on the frame rather
  // than on a body, so it is worth saying that the pointing will feel off.
  if (!face) return { value: 0.5, reason: "no-face" };
  if (box.clamped || box.w > MAX_BOX_COVERAGE || box.h > MAX_BOX_COVERAGE) {
    return { value: 0.35, reason: "too-close" };
  }
  if (palmPx < MIN_PALM_PX * 0.6) return { value: 0.15, reason: "too-far" };
  if (palmPx < MIN_PALM_PX) return { value: 0.6, reason: "hand-too-small" };
  return { value: 1, reason: "ok" };
}

/**
 * Pinch thresholds, as aperture-over-palm-width. FITTED TO RECORDED DATA, not guessed.
 *
 * The shape is the one every hand-tracking vendor converges on — Ultraleap and Meta both
 * expose a normalised pinch STRENGTH with separate activate and deactivate distances — and
 * the important part is that the thresholds are FIXED against a rigid reference. The palm
 * (index knuckle to little-finger knuckle) is that reference here: it does not move when the
 * fingers do, and dividing by it cancels both distance from the camera and hand size, which
 * is exactly what a fixed threshold needs in order to mean the same thing for everybody.
 *
 * These two numbers come from sweeping every threshold pair against six recorded trials with
 * known answers (two runs of ten deliberate pinches, plus stills, a sweep, and an empty
 * room). Measured open hand: 1.44 ± 0.015. Measured pinches bottom out between 0.27 and 0.76.
 *
 * 0.74 rather than 0.72 for a specific measured reason: a pinch that is CLOSED AND HELD sits
 * at about 0.758 with very little variation, so 0.72 sat just inside it and a held pinch
 * registered only if it happened to wobble across the line. Two hundredths is the difference
 * between "hold still and nothing happens" and "hold still and it selects".
 *
 * WHAT THE SAME SWEEP ALSO ESTABLISHED, and it is the more important result: no threshold
 * pair does better than 4/10 and 7/10 on the deliberate pinches. Loosening does not help —
 * detection stays flat and false triggers climb. Roughly a third to a half of real pinches
 * simply leave no trace at this distance with this camera, because two fingertips two
 * centimetres apart, seen from metres away, is a signal the size of the noise. That is why
 * the fist exists alongside it, and why the camera is on the open-questions list.
 */
export const PINCH_ON = 0.74;
export const PINCH_OFF = 0.88;

/**
 * Pinch detection: a fixed threshold with hysteresis, and nothing clever.
 *
 * It used to adapt — tracking a rolling estimate of how open this particular hand had
 * recently been, and setting the thresholds as fractions of that. The idea was to absorb
 * differences between hands. What it actually did was deadlock: the estimate rose quickly and
 * fell slowly (so that a long deliberate pinch could not drag it down to meet itself), which
 * meant an estimate that started too HIGH could never come back down. A hand whose open
 * posture read below the threshold was classified as pinched from the first frame, and
 * escaping required a value it could never produce. The click stuck down permanently — taking
 * taps with it (they fire on release), dwell (it requires no pinch), and even the showreel's
 * steering (it holds still while pinched). One adaptive estimate, four dead interactions.
 *
 * Normalising against the palm already does the job the adaptation was invented for.
 */
export class PinchDetector {
  private on = false;
  /** consecutive frames with no usable hand */
  private missing = 0;
  count = 0;

  /** good frames seen since the last tracking gap */
  private settled = 0;

  constructor(
    private readonly onAt = PINCH_ON,
    private readonly offAt = PINCH_OFF,
    /** how many hand-less frames to ride out before releasing a held pinch (~5 = 165ms @30fps) */
    private readonly graceFrames = 5,
    /**
     * How many consecutive good frames must follow a tracking gap before a NEW pinch may
     * latch.
     *
     * The first frames after the hand is reacquired are the least trustworthy ones the model
     * ever produces — the pose is being reconstructed from scratch, and a half-formed skeleton
     * reads as a closed hand. Replaying a recorded arm sweep, where tracking dropped in and
     * out through half the frames, this alone accounted for five phantom clicks in ten
     * seconds: moving the cursor was firing it. Waiting a few frames costs nothing, because
     * nobody completes a deliberate pinch inside a tenth of a second anyway.
     */
    private readonly settleFrames = 8,
  ) {}

  /**
   * Feed one frame's aperture/palm ratio — NaN when no hand was tracked.
   *
   * A lost hand releases, but only after a short grace period, and both halves are deliberate.
   * Holding a pinch through a lost hand is the worse failure: a mouse button stuck down on a
   * cursor nobody is steering, which no gesture can lift. Releasing on the first missing frame
   * is wrong too — single dropped frames are common, and each one would end the hold and let
   * the next frame count a brand-new pinch, turning one press into a double click.
   */
  update(ratio: number): boolean {
    if (!Number.isFinite(ratio)) {
      this.missing += 1;
      this.settled = 0;
      if (this.missing > this.graceFrames) this.on = false;
      return this.on;
    }
    this.missing = 0;
    this.settled += 1;
    if (!this.on && this.settled > this.settleFrames && ratio < this.onAt) {
      this.on = true;
      this.count += 1;
    } else if (this.on && ratio > this.offAt) {
      this.on = false;
    }
    return this.on;
  }

  get pinched(): boolean {
    return this.on;
  }

  /**
   * A continuous 0..1, the way Ultraleap and Meta report it: 0 is an open hand, 1 is closed.
   * Nothing acts on it — the latch above does that — but it is what makes a live readout
   * legible, and "why did that not fire" answerable at the wall.
   */
  strength(ratio: number): number {
    if (!Number.isFinite(ratio)) return 0;
    const OPEN = 1.44; // measured open hand
    const v = (OPEN - ratio) / (OPEN - this.onAt);
    return v < 0 ? 0 : v > 1 ? 1 : v;
  }

  get thresholds(): { on: number; off: number } {
    return { on: this.onAt, off: this.offAt };
  }

  reset(): void {
    this.on = false;
    this.missing = 0;
    this.settled = 0;
    this.count = 0;
  }
}
