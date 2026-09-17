import { JOINT, type FaceResult, type Landmark } from "./mediapipe";

/**
 * Body-relative hand pointing plus a bounded, per-camera/display installation calibration.
 *
 * The problem this solves: a fixed mapping from "where the hand is in the camera frame" to
 * "where the cursor is on the screen" is wrong for everyone except the one person it was
 * tuned for. Stand closer and your whole arm sweep covers the frame twice over (measured:
 * at 0.5 m a comfortable sweep left the frame entirely, and tracking survived only 48% of
 * it). Stand further and the same sweep moves the cursor a few centimetres. Be shorter and
 * the whole mapping sits too high.
 *
 * The operator calibration records only a safe reach box for the installation. It does not
 * tune a visitor's hand or recognition thresholds. Distance is handled continuously because
 * the live mapping is defined so it cancels out:
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
 *   3. Gesture recognition is deliberately separate: the production default is a whole-hand
 *      fist, while the optional pinch uses fixed palm-normalised thresholds fitted offline.
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
  /**
   * How far the box centre sits to one SIDE of the face, in face widths. Raw frame direction,
   * like everything else in this file: positive is toward the right of the IMAGE, which is the
   * visitor's left. Mirroring happens once, in `mapToBox`.
   *
   * Zero for the hand-tuned default, because a symmetric guess is the only fair one to make
   * about a stranger. It is here for `reachFit`: a measured reach is never symmetric — people
   * favour a hand, and a camera is rarely mounted exactly on the centre line of where they
   * stand — and forcing the fitted box back to centre would throw away the reachable side to
   * match the unreachable one.
   */
  shiftFaces?: number;
}

/**
 * Defaults in physical terms, taking a face as ~15 cm wide: a box about 40 cm wide and 27 cm
 * tall, centred ~33 cm below the eyes — a hand moving in front of the chest, elbow bent.
 *
 * SMALLER THAN IT WAS, on purpose (4.5 x 3.0 faces, 68 x 45 cm, until Sept 2026). The old
 * box was "what a standing adult can comfortably reach", which is the wrong question: the
 * box is not where the hand CAN go, it is how much of that the screen should cost. A box
 * the size of a full reach means the corners of the screen are at the limit of the arm — and
 * at any distance inside a metre or so, outside the camera's picture altogether, because a
 * webcam's field of view is narrower than an arm is long. Every tester reported the same
 * thing: "I can't reach the corners." A small box in the middle of the frame is reachable
 * from every distance the camera can see a hand at; what it costs is precision, and the
 * cursor's targets are sized for that already.
 */
export const DEFAULT_BOX: BoxConfig = {
  widthFaces: 2.7,
  heightFaces: 1.8,
  dropFaces: 2.2,
  shiftFaces: 0,
};

/** How far inside the picture a box edge always stays, as a fraction of the frame. */
export const BOX_EDGE = 0.06;

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
  const cx = face.cx + (cfg.shiftFaces ?? 0) * f;
  const cy = face.cy + cfg.dropFaces * f * aspect;

  // Slide the box back inside the frame if it hangs over an edge, and only cut it if it is
  // genuinely larger than the frame. See `shifted` above for why the order matters.
  //
  // "Inside the frame" means inside BOX_EDGE of it, not the last pixel. Tracking does not stop
  // at the edge of the picture, it degrades for a while first — the palm half out of shot,
  // the landmarks extrapolated — and a box edge put on the frame edge puts the edge of the
  // SCREEN in the one place the pointer is least trustworthy. On the wall that was "I can't
  // reach the bottom right": the box had slid down to the frame's bottom row, and the wrist
  // had to leave the picture to get there.
  const fit = (lo: number, hi: number): { lo: number; hi: number; cut: boolean; slid: boolean } => {
    const size = hi - lo;
    const room = 1 - 2 * BOX_EDGE;
    if (size >= room) return { lo: BOX_EDGE, hi: 1 - BOX_EDGE, cut: true, slid: false };
    if (lo < BOX_EDGE) return { lo: BOX_EDGE, hi: BOX_EDGE + size, cut: false, slid: true };
    if (hi > 1 - BOX_EDGE) return { lo: 1 - BOX_EDGE - size, hi: 1 - BOX_EDGE, cut: false, slid: true };
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
  private lastUpdate: number | null = null;
  private has = false;
  private readonly tauMs: number;

  constructor(
    /**
     * Approach rate at the historical 30 fps reference cadence. Kept in this form for API
     * compatibility; `update` converts it to a wall-clock time constant for every sample.
     */
    ease = 0.15,
    /** how long to keep using the last anchor after the face is lost, in ms */
    private readonly holdMs = 2000,
  ) {
    const referenceMs = 1000 / 30;
    const clampedEase = Math.max(0, Math.min(1, ease));
    this.tauMs =
      clampedEase <= 0
        ? Number.POSITIVE_INFINITY
        : clampedEase >= 1
          ? 0
          : -referenceMs / Math.log1p(-clampedEase);
  }

  /** True when the returned anchor is remembered rather than currently seen. */
  held = false;

  update(face: FaceResult | null, now: number, retainForOwner = false): FaceResult | null {
    if (face && face.w > 0) {
      if (!this.has) {
        this.cx = face.cx;
        this.cy = face.cy;
        this.w = face.w;
        this.h = face.h;
        this.has = true;
      } else {
        // The former fixed `ease` was applied once per frame: the same head trajectory was
        // filtered twice as hard on a loaded 15 fps laptop as on a 30 fps one. Interpret that
        // value at its original 30 fps cadence and derive the exact continuous-time response.
        const dtMs =
          this.lastUpdate !== null && Number.isFinite(now)
            ? Math.max(0, now - this.lastUpdate)
            : 1000 / 30;
        const alpha = this.tauMs === 0 ? 1 : -Math.expm1(-dtMs / this.tauMs);
        this.cx += (face.cx - this.cx) * alpha;
        this.cy += (face.cy - this.cy) * alpha;
        this.w += (face.w - this.w) * alpha;
        this.h += (face.h - this.h) * alpha;
      }
      this.lastSeen = now;
      this.lastUpdate = now;
      this.held = false;
      return { cx: this.cx, cy: this.cy, w: this.w, h: this.h, score: face.score };
    }

    this.lastUpdate = now;
    // While the same physical hand owner is still visible, dropping this anchor would swap to
    // a frame-centred palm fallback in one sample. A motionless hand would then move the cursor
    // simply because its face had been occluded for two seconds. With no newer body evidence,
    // the last owner-specific anchor is the only continuous and therefore safest mapping.
    if (this.has && (retainForOwner || now - this.lastSeen < this.holdMs)) {
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
    this.lastSeen = 0;
    this.lastUpdate = null;
  }
}

/**
 * Where the hand IS, for pointing purposes: the WRIST. Not a fingertip, and no longer the
 * palm triangle either.
 *
 * A fingertip is the intuitive choice and the wrong one. The fingers are what perform the
 * click, so a cursor tied to a fingertip lurches at the exact moment of selection — the
 * failure Vogel & Balakrishnan designed ThumbTrigger around on large displays.
 *
 * The palm triangle (wrist plus the two outer knuckles) was the first answer, on the argument
 * that it is rigid. It is rigid in a skeleton and not in a hand: closing a fist cups the palm,
 * so both knuckles physically move, and the landmark model — now looking at a hand with most
 * of its features folded away — re-estimates them with visibly more noise every frame. On the
 * wall that was a cursor shivering under a hand held perfectly still, at exactly the moment a
 * click was being made. The wrist is the one point that does not move when the fingers do:
 * it sits where the hand meets the arm, the fist is made in front of it, not with it.
 *
 * `?point=palm` puts the triangle back, for comparing the two at the wall. The choice is read
 * once, here, because this function is the single definition of "where the hand is" — the
 * pointer, the calibration sweep and the reach test all go through it, so they cannot
 * disagree about the answer.
 */
export function palmCenter(lm: Landmark[] | undefined): { x: number; y: number } | null {
  const a = lm?.[JOINT.wrist];
  if (!a) return null;
  if (POINT === "palm") {
    const b = lm?.[JOINT.indexMcp];
    const c = lm?.[JOINT.pinkyMcp];
    if (!b || !c) return null;
    return { x: (a.x + b.x + c.x) / 3, y: (a.y + b.y + c.y) / 3 };
  }
  return { x: a.x, y: a.y };
}
const POINT: "wrist" | "palm" = (() => {
  if (typeof location === "undefined") return "wrist";
  return new URLSearchParams(location.search).get("point") === "palm" ? "palm" : "wrist";
})();

/**
 * Palm width in frame x-units — how big the hand is on the sensor, i.e. how much detail we
 * have. MediaPipe normalises x by frame width and y by frame height, so y must be divided by
 * width/height before the two axes can participate in one Euclidean distance. Without that
 * correction the exact same tilted hand looks wider on 16:9 than on 4:3 cameras.
 */
export function palmWidthNorm(lm: Landmark[] | undefined, aspect = 1): number {
  const b = lm?.[JOINT.indexMcp];
  const c = lm?.[JOINT.pinkyMcp];
  if (!b || !c) return Number.NaN;
  const safeAspect = Number.isFinite(aspect) && aspect > 0 ? aspect : 1;
  return Math.hypot(b.x - c.x, (b.y - c.y) / safeAspect);
}

/** Convert a frame-height-normalised y coordinate into the x-normalised units used by 3D input. */
export function frameYInXUnits(y: number, aspect: number): number {
  const safeAspect = Number.isFinite(aspect) && aspect > 0 ? aspect : 1;
  return y / safeAspect;
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
export const MIN_PALM_PX = 42;

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
/** Temporal gates are wall-clock durations, independent of the vision frame rate. */
export const PINCH_GRACE_MS = 165;
export const PINCH_SETTLE_MS = 265;
/** Positive closed-aperture evidence required to latch a new pinch. */
export const PINCH_ON_MS = 100;
/** Positive open-aperture evidence required to release an already-held pinch. */
export const PINCH_OFF_MS = 100;

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
  /** First decoded-sample time in the current tracking gap. */
  private missingSinceMs: number | null = null;
  private missingMs = 0;
  count = 0;

  /** First decoded-sample time in the current uninterrupted run of usable landmarks. */
  private validSinceMs: number | null = null;
  private settledMs = 0;
  /** Guards the temporal gates against a clock that jumps backwards. */
  private lastSampleAtMs: number | null = null;
  /** First sample in a continuous run above the release threshold. */
  private openSinceMs: number | null = null;
  /** First sample in a continuous run below the press threshold. */
  private closedSinceMs: number | null = null;

  constructor(
    private onAt = PINCH_ON,
    private offAt = PINCH_OFF,
    /** How long to ride out missing landmarks before releasing a held pinch. */
    private graceMs = PINCH_GRACE_MS,
    /**
     * How long usable landmarks must remain continuous after a tracking gap before a NEW
     * pinch may latch. This is elapsed decoded-sample time, not a frame count: rendering a Gaussian
     * scene can halve inference FPS without silently doubling the gate.
     *
     * The first frames after the hand is reacquired are the least trustworthy ones the model
     * ever produces — the pose is being reconstructed from scratch, and a half-formed skeleton
     * reads as a closed hand. Replaying a recorded arm sweep, where tracking dropped in and
     * out through half the frames, this alone accounted for five phantom clicks in ten
     * seconds: moving the cursor was firing it. Waiting briefly costs nothing, because
     * nobody completes a deliberate pinch inside a tenth of a second anyway.
     */
    private settleMs = PINCH_SETTLE_MS,
    /** One landmark spike above `offAt` is not an intentional open hand. */
    private offMs = PINCH_OFF_MS,
    /** One landmark spike below `onAt` is not an intentional pinch. */
    private onMs = PINCH_ON_MS,
  ) {}

  /**
   * Re-point the detector at explicit runtime or experiment numbers.
   *
   * The installation profile intentionally does not call this: per-visitor open/closed clouds
   * were unstable and made a camera/display calibration expire with the person who performed
   * it. This hook remains for the hand lab, URL diagnostics and deterministic tests. Temporal
   * gates remain wall-clock durations and likewise do not belong to a camera profile.
   *
   * Deliberately does NOT reset the latch: changing the numbers under a held pinch should
   * change what happens next, not fabricate a release.
   */
  configure(cfg: {
    on?: number;
    off?: number;
    graceMs?: number;
    settleMs?: number;
    offMs?: number;
    onMs?: number;
  }): void {
    if (Number.isFinite(cfg.on ?? NaN)) this.onAt = cfg.on!;
    if (Number.isFinite(cfg.off ?? NaN)) this.offAt = cfg.off!;
    if (Number.isFinite(cfg.graceMs ?? NaN)) this.graceMs = Math.max(0, cfg.graceMs!);
    if (Number.isFinite(cfg.settleMs ?? NaN)) this.settleMs = Math.max(0, cfg.settleMs!);
    if (Number.isFinite(cfg.offMs ?? NaN)) this.offMs = Math.max(0, cfg.offMs!);
    if (Number.isFinite(cfg.onMs ?? NaN)) this.onMs = Math.max(0, cfg.onMs!);
  }

  /**
   * Feed one decoded sample's aperture/palm ratio — NaN when no hand was tracked — and the
   * monotonic timestamp attached to that sample.
   *
   * A lost hand releases, but only after a short grace period, and both halves are deliberate.
   * Holding a pinch through a lost hand is the worse failure: a mouse button stuck down on a
   * cursor nobody is steering, which no gesture can lift. Releasing on the first missing frame
   * is wrong too — single dropped frames are common, and each one would end the hold and let
   * the next frame count a brand-new pinch, turning one press into a double click.
   */
  update(ratio: number, sampleAtMs: number): boolean {
    // A malformed timestamp must never advance a gate. Clamping a rare backwards timestamp
    // likewise fails closed while preserving an already-held posture until real evidence says
    // otherwise.
    const at = Number.isFinite(sampleAtMs)
      ? Math.max(sampleAtMs, this.lastSampleAtMs ?? sampleAtMs)
      : this.lastSampleAtMs;
    if (at === null) return this.on;
    this.lastSampleAtMs = at;

    if (!Number.isFinite(ratio)) {
      this.openSinceMs = null;
      this.closedSinceMs = null;
      if (this.missingSinceMs === null) this.missingSinceMs = at;
      this.missingMs = Math.max(0, at - this.missingSinceMs);
      this.validSinceMs = null;
      this.settledMs = 0;
      if (this.missingMs >= this.graceMs) this.on = false;
      return this.on;
    }

    // If usable landmarks return after a sparse gap, account for the whole elapsed gap before
    // clearing it. This matters when the renderer leaves no intermediate decoded samples.
    if (
      this.missingSinceMs !== null &&
      at - this.missingSinceMs >= this.graceMs
    ) {
      this.on = false;
    }
    this.missingSinceMs = null;
    this.missingMs = 0;
    if (this.validSinceMs === null) this.validSinceMs = at;
    this.settledMs = Math.max(0, at - this.validSinceMs);

    if (!this.on) {
      this.openSinceMs = null;
      if (this.settledMs >= this.settleMs && ratio < this.onAt) {
        if (this.closedSinceMs === null) this.closedSinceMs = at;
        if (at - this.closedSinceMs + 1e-6 >= this.onMs) {
          this.on = true;
          this.count += 1;
          this.closedSinceMs = null;
        }
      } else {
        this.closedSinceMs = null;
      }
    } else if (ratio > this.offAt) {
      this.closedSinceMs = null;
      if (this.openSinceMs === null) this.openSinceMs = at;
      if (at - this.openSinceMs + 1e-6 >= this.offMs) {
        this.on = false;
        this.openSinceMs = null;
      }
    } else {
      this.openSinceMs = null;
      this.closedSinceMs = null;
    }
    return this.on;
  }

  get pinched(): boolean {
    return this.on;
  }

  /**
   * The gate state, for the audit HUD. READ-ONLY and behaviour-free.
   *
   * `settledMs` below `settleMs` is a real, invisible refusal: for roughly a quarter second
   * after the hand is reacquired no pinch can latch at all, however deliberate. It happens
   * every time tracking blinks, and the HUD makes that refusal visible.
   */
  get gates(): { settledMs: number; settleMs: number; missingMs: number; graceMs: number } {
    return {
      settledMs: this.settledMs,
      settleMs: this.settleMs,
      missingMs: this.missingMs,
      graceMs: this.graceMs,
    };
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
    this.missingSinceMs = null;
    this.missingMs = 0;
    this.validSinceMs = null;
    this.settledMs = 0;
    this.lastSampleAtMs = null;
    this.openSinceMs = null;
    this.count = 0;
  }
}
