import { useEffect, useRef, useState } from "react";
import {
  JOINT,
  VisionEngine,
  extendedFingers,
  fingerCurlRatios,
  fistFromGeometry,
  type FaceResult,
  type Landmark,
  type VisionResult,
} from "./mediapipe";
import {
  DEFAULT_BOX,
  FaceAnchor,
  PINCH_OFF,
  PINCH_OFF_MS,
  PINCH_ON,
  PINCH_ON_MS,
  PINCH_GRACE_MS,
  PINCH_SETTLE_MS,
  PinchDetector,
  confidence,
  fallbackBox,
  frameYInXUnits,
  MIN_PALM_PX,
  interactionBox,
  mapToBox,
  palmCenter,
  palmWidthNorm,
  type BoxConfig,
  type Confidence,
  type InteractionBox,
} from "./calibration";
import { DEFAULT_ONE_EURO, OneEuroPoint, type OneEuroConfig } from "./oneEuro";
import { NO_FEATURES, pinchFeatures, type PinchFeatures } from "./features";
import { noteReject, type GesturePhase, type RejectReason } from "./trace";
import { SIM_ASPECT, activeSim, simFrame } from "./handSim";
import { visionLog } from "./visionLog";
import { StableHandOwner } from "./handOwner";
import { StableOwnerFace } from "./faceOwner";
import {
  CONTROL_FRESH_MIN_MS,
  CONTROL_MAX_INFERENCE_MS,
  CONTROL_MAX_SAMPLE_GAP_MS,
  CONTROL_TRACKING_GAP_GRACE_MS,
  ControlFreshnessEstimator,
  InferenceHealthMonitor,
} from "./controlFreshness";
import { RUNTIME_CLICK_GESTURE, type ClickGesture } from "./gestureRuntime";
import { PointerStabilizer } from "./pointerStabilizer";
import {
  startDecodedFrameLoop,
  type DecodedFrameStamp,
  type VideoFrameStaleReason,
} from "./videoFrameSource";
import { cameraIdentityFromTrack, publishCameraIdentity } from "./cameraPairing";

/**
 * Hand → cursor. The pointing half of the touchless kiosk.
 *
 * This is the Vision Pro model minus the half we cannot have. Apple's main interaction is
 * "eyes aim, hand confirms", and with no eye tracking that is simply unavailable — but Apple
 * ships a second, fully supported input for exactly that situation: Pointer Control, where a
 * hand drives an ordinary cursor and a pinch clicks, with Dwell as the alternative for anyone
 * whose pinch will not register. That is the model implemented here, and it is why this is an
 * alignment with visionOS rather than a departure from it.
 *
 * Three decisions worth knowing, each of which was arrived at the hard way:
 *
 * ABSOLUTE, NOT RELATIVE. The cursor is wherever the hand is inside the auto-calibrated box,
 * not an accumulation of hand movement. Relative pointing is what a mouse does and it needs
 * clutching — a way to lift, reposition and put down — which is a concept a passer-by has no
 * reason to know and no affordance to discover. Absolute mapping costs precision, and the
 * answer to that is large targets, which is Apple's advice for eye targeting anyway.
 *
 * POSITION FROM THE PALM, NEVER THE FINGERTIP. The fingers perform the click, so a cursor
 * tied to them lurches at the moment of selection.
 *
 * THE CURSOR FREEZES WHILE A CLICK IS PENDING. Even from the palm, a pinch disturbs the whole
 * hand enough to move the cursor a few pixels while the press registers — the failure Vogel &
 * Balakrishnan built ThumbTrigger to avoid on large displays. The aimed position stays pinned
 * while the closed hand remains inside the drag radius, so opening commits at that position;
 * real movement releases the cursor and reclassifies the same hold as scrolling.
 */

export interface PointerConfig {
  oneEuro: OneEuroConfig;
  box: BoxConfig;
  /** pinch trigger points, as aperture/palm ratios — fitted to recorded data, see calibration.ts */
  pinchOn: number;
  pinchOff: number;
  /** how long the cursor is pinned at the press position, in ms — the MINIMUM; see `holdRadius` */
  pressFreezeMs: number;
  /**
   * How far the hand may move, in screen fractions, while a click posture is held before the
   * cursor is let go of the press position.
   *
   * The freeze used to be a timer alone: 180ms, and then the cursor went back to following the
   * hand while the fist was still closed. And a closed fist is the NOISIEST thing the landmark
   * model tracks — the knuckles and wrist the position is read from are re-estimated every
   * frame from a hand with most of its features folded away — so a visitor holding perfectly
   * still watched the cursor shiver under their closed hand. With `beta` set high enough to
   * keep up with a real move, the 1€ filter reads that noise as speed and opens up for it.
   *
   * A held click that has not travelled this far is, by the interaction's own rule, not a
   * drag (`DRAG_START` in HandControl is the same number) — so there is no reason for the
   * cursor to move at all. It stays pinned until the hand has genuinely gone somewhere, and
   * then follows, so pinch-and-drag is unchanged.
   */
  holdRadius: number;
  /**
   * How far BACK the pinned position is taken from, in ms.
   *
   * Freezing at the instant the press is detected is too late, and measurably so. Closing a
   * pinch takes something like two tenths of a second, the whole hand drifts while it
   * happens, and the threshold is only crossed at the END of that movement — so the position
   * captured on the press edge is the position after the disturbance, not the one the visitor
   * aimed with. Reaching back past the gesture recovers the aim.
   */
  pressLookbackMs: number;
  /** hold still this long to trigger without a pinch; 0 disables dwell */
  dwellMs: number;
  /** how far the cursor may wander and still count as held still, in unit screen coords */
  dwellRadius: number;
  /**
   * Which posture counts as a click.
   *
   * Pinch is the visionOS gesture and the one to ship if it can be seen. Measurement says it
   * often cannot: a large minority of deliberate pinches leave no usable trace, because a
   * two-centimetre gap between two fingertips, three metres from one webcam, is a signal the
   * size of the noise. A fist has no such problem — it is a whole-hand posture, unmistakable
   * from any angle, and MediaPipe classifies it with a trained model rather than from
   * geometry we assemble ourselves. It is less elegant and much more reliable, which is the
   * trade this hardware forces.
   */
  clickGesture: ClickGesture;
  /**
   * A global multiplier on the box, 0..1. The box is the cost of the screen in hand movement,
   * and this is the one knob that makes it cheaper everywhere at once — measured or default,
   * at every distance — without touching what was measured. `?reach=0.7` at the wall.
   */
  reachScale: number;
  /** a hand must persist this long to count as a visitor (anti-flicker) */
  enterMs: number;
  /** ...and be gone this long before the cursor does */
  leaveMs: number;
}

/**
 * How far a held hand may wander before the cursor stops being pinned to the press — the same
 * distance `HandControl` uses to decide a press has become a drag, exported so the two cannot
 * drift apart: a cursor that moves while the interaction says "not a drag" is just jitter.
 */
export const HOLD_RADIUS = 0.025;

export interface GestureTimingConfig {
  pinchGraceMs: number;
  pinchSettleMs: number;
  pinchOnMs: number;
  pinchOffMs: number;
  fistOnMs: number;
  fistOffMs: number;
}

/** Recognition gates are elapsed decoded-sample time, never inferred from camera FPS. */
export const DEFAULT_GESTURE_TIMING: GestureTimingConfig = {
  pinchGraceMs: PINCH_GRACE_MS,
  pinchSettleMs: PINCH_SETTLE_MS,
  pinchOnMs: PINCH_ON_MS,
  pinchOffMs: PINCH_OFF_MS,
  fistOnMs: 66,
  fistOffMs: 100,
} as const;

export const DEFAULT_POINTER: PointerConfig = {
  oneEuro: { ...DEFAULT_ONE_EURO },
  box: { ...DEFAULT_BOX },
  pinchOn: PINCH_ON,
  pinchOff: PINCH_OFF,
  pressFreezeMs: 180,
  holdRadius: HOLD_RADIUS,
  pressLookbackMs: 420,
  /**
   * OFF. Dwell — select by resting on a target — is Apple's own documented fallback and it
   * was carried here for the visitors whose pinch a single webcam cannot read. In use it was
   * worse than the problem: a cursor that selects things simply by stopping means a visitor
   * cannot pause to read without activating whatever they paused over, and a hand-driven
   * cursor stops constantly. Every accidental trigger is a page the visitor did not ask for.
   *
   * The code stays, because the accessibility case for it is real and the trade may look
   * different on a better camera. `?dwell=900` turns it back on at the wall.
   */
  dwellMs: 0,
  dwellRadius: 0.035,
  clickGesture: RUNTIME_CLICK_GESTURE,
  reachScale: 1,
  enterMs: 250,
  leaveMs: 1200,
};

export type HandPosture = "open" | "closed" | "unknown";

/** Camera-space coordinates for scene interaction. Nothing UI-specific has touched them. */
export interface RawHandState {
  /** Raw camera direction: x grows toward image-right (the visitor's left in a selfie view). */
  frameX: number;
  /** Raw camera direction: y grows downward, converted to frame-x units. */
  frameY: number;
  /** Index-MCP to pinky-MCP span in frame-x units. */
  palmSpan: number;
  /** Optional body-relative coordinate from the steadied face ruler, still unmirrored. */
  body: { xFaces: number; yFaces: number; anchorHeld: boolean } | null;
}

export type PointerCancelReason =
  | "hand-lost"
  | "source-stale"
  | "track-ended"
  | "page-hidden"
  | "owner-changed"
  | "mapping-changed"
  | "hold-timeout";

interface PointerGestureEventBase {
  seq: number;
  at: number;
  ownerId: number;
  via: "pinch" | "fist";
  /** UI aim, already mapped and frozen for the press. */
  aim: { x: number; y: number };
  /** Unfrozen mapped cursor at this exact event frame (drag origin/update reference). */
  live: { x: number; y: number };
  /** Raw observation at this edge. Null only when tracking itself caused a cancellation. */
  rawHand: RawHandState | null;
  /** Adaptive result-age budget measured from this laptop's actual completion cadence. */
  freshForMs: number;
}

export type PointerGestureEvent =
  | (PointerGestureEventBase & { type: "press" })
  | (PointerGestureEventBase & { type: "release" })
  | (PointerGestureEventBase & { type: "cancel"; reason: PointerCancelReason });

/**
 * A dwell is produced by the camera clock but consumed by the display clock. Keeping it as a
 * queued event (instead of only a one-camera-frame boolean) makes it exactly-once even when a
 * 15fps camera feeds a 120Hz display, or when the display misses the firing frame entirely.
 */
export interface PointerDwellEvent {
  seq: number;
  at: number;
  ownerId: number;
  aim: { x: number; y: number };
  freshForMs: number;
}

interface ActivePress {
  ownerId: number;
  via: "pinch" | "fist";
  aim: { x: number; y: number };
  /** Last mapped position observed while the configured gesture was still closed. */
  lastHeldLive: { x: number; y: number };
  /** Conservative shape immediately before a fist press, used only to recognise relaxation. */
  fistBaseline: FistShape | null;
  startedAt: number;
}

interface FistShape {
  aperture: number | null;
  curls: [number, number, number, number] | null;
}

interface TimedFistShape extends FistShape {
  at: number;
}

/** Live pointer state. Mutated in place so a render loop can read it without re-rendering. */
export interface PointerState {
  /** Metadata from the one decoded video frame that produced this state. */
  sample: DecodedFrameStamp & {
    processedAtMs: number;
    inferenceMs: number;
    freshForMs: number;
    sourceFresh: boolean;
  };
  /** Stable interaction owner. `id` stays reserved briefly while `visible` is false. */
  owner: {
    id: number | null;
    visible: boolean;
    selectedIndex: number;
    handedness: string | null;
    acquiredAtMs: number;
    lastSeenAtMs: number;
  };
  /** Unmapped and unfiltered owner position for grip-relative scene navigation. */
  rawHand: RawHandState | null;
  /** Conservative sensor posture: uncertainty is never treated as an open hand. */
  posture: HandPosture;
  /** Independent classifier latches, exposed so calibration can prove each gesture honestly. */
  pinchHeld: boolean;
  fistHeld: boolean;
  /** Legacy edge fields are retained while consumers migrate to `drainEvents()`. */
  cancelled: boolean;
  cancelReason: PointerCancelReason | null;
  /** a hand has been present long enough to trust */
  present: boolean;
  /** unit screen coordinates, 0..1, already smoothed and mirrored */
  x: number;
  y: number;
  /**
   * The same position WITHOUT the press freeze — where the hand actually is right now.
   *
   * Both are needed and they mean different things. `x`/`y` is where a click should land: it
   * is pinned to the aim the visitor had before the pinch disturbed their hand. `liveX`/`liveY`
   * is where the hand has since travelled, which is the only honest way to ask "is this
   * turning into a drag?" — measuring drag against the frozen aim counts the freeze itself as
   * movement, and every tap gets thrown away as a drag.
   */
  liveX: number;
  liveY: number;
  /** a click posture is currently held (pinch or fist, per config) */
  pinched: boolean;
  /** which posture is holding it — so the UI can report what actually worked */
  pressVia: "pinch" | "fist" | null;
  /** true for exactly one frame, on the press and release edges */
  pressed: boolean;
  released: boolean;
  /**
   * The release happened because the hand was LOST, not because it opened.
   *
   * UI controls activate on the confirmed press, but continuous scroll/scene sessions still
   * end on a real release. This distinguishes "they let go" from "they walked away" so loss
   * can cancel motion without pretending the visitor deliberately completed it.
   */
  releasedByLoss: boolean;
  /**
   * 0..1 while a click posture is being held but has not yet been confirmed.
   *
   * The hold exists to keep noise out (see PRESS_DEBOUNCE_MS) and it is invisible, which makes
   * every refusal look identical to a camera that cannot see you: a pinch too short, a hand
   * that drifted, a press over nothing — all of them are "nothing happened". Exposing the
   * progress lets the cursor show the press filling up, so a visitor can tell the difference
   * between "not yet" and "not working", and learn how long to hold without being told.
   */
  pressProgress: number;
  /** 0..1 progress toward a dwell trigger; 1 fires it */
  dwell: number;
  /** Legacy camera-frame pulse; production consumers use `drainDwellEvents()` instead. */
  dwellFired: boolean;
  /** whether the geometry is good enough to be believed, and why not */
  conf: Confidence;
  /** the auto-calibrated box, for overlays */
  box: InteractionBox | null;
  /**
   * The steadied face anchor this frame — the ruler everything else is measured in.
   *
   * Exposed because installation axis holds are recorded relative to this ruler. Raw frame
   * coordinates describe where the operator stood; face-width units describe reachable camera
   * space and survive the next visitor standing closer or farther away.
   */
  face: FaceResult | null;
  /** the box is coasting on a remembered face — normally because a hand is in front of it */
  faceHeld: boolean;
  /** every tracked hand's 21 points, for drawing a skeleton */
  hands: Landmark[][];
  /** aperture / palm width — the pinch signal, exposed for debug readouts */
  ratio: number;
  /**
   * Measured update rate. Worth surfacing rather than assuming: everything downstream is
   * tuned in real time, so a loop running at half the expected rate makes a correctly tuned
   * filter feel broken — and two copies of this running at once (a stale hot-reloaded
   * instance still holding the camera) looks exactly like that.
   */
  fps: number;

  // --- AUDIT FIELDS. Written every frame, read by nothing in production. -------------------
  //
  // These exist because the pinch fails silently and everything below this line is an attempt
  // to make one specific failure distinguishable from the other eight. Adding them changes no
  // decision: every value here is derived from state the pointer already computed.

  /**
   * The frame's TRUE pixel size, straight from the camera. NaN until a real frame arrives.
   * Every pixel figure in `features` is only as honest as this pair.
   */
  frame: { w: number; h: number };
  /**
   * Landmarks arrived this frame. Explicit rather than inferred from a feature being finite —
   * the HUD's first version asked "is the pixel aperture a number?", which is also false when
   * the frame size is unknown, and so reported "no hand" beside "hand frames 100%".
   */
  handSeen: boolean;
  /** Every candidate pinch feature, side by side on this frame. See `features.ts`. */
  features: PinchFeatures;
  /** Palm width in ACTUAL camera pixels — the optics figure `confidence` should have used. */
  palmPx: number;
  /** Where the gesture state machine is, named. */
  phase: GesturePhase;
  /** The raw posture, BEFORE the 350ms debounce — what the sensor said, before policy. */
  rawHeld: boolean;
  /** How long the current raw posture has been held, ms. 0 when there is none. */
  gestureMs: number;
  /** Cursor speed, in screen fractions per second. Drives the drag/tap confusion. */
  velocity: number;
  /** Why no click came out of THIS frame, at the acquisition/recognition layers. */
  reject: RejectReason | null;
  /**
   * Running totals, kept so the three recall figures can be read straight off the state:
   * hand acquisition, pinch given a hand, click given a pinch.
   */
  counts: {
    frames: number;
    handFrames: number;
    /** raw posture latches (the sensor said "closed") */
    rawLatches: number;
    /** ...that survived the debounce and became a real press */
    presses: number;
    /** presses that ended by the hand vanishing rather than opening */
    lostReleases: number;
    /** presses force-released as a mis-read */
    stuckReleases: number;
  };
}

function blankState(): PointerState {
  return {
    sample: {
      seq: 0,
      receivedAtMs: 0,
      processedAtMs: 0,
      inferenceMs: 0,
      freshForMs: CONTROL_FRESH_MIN_MS,
      mediaTimeMs: 0,
      sourceFresh: false,
    },
    owner: {
      id: null,
      visible: false,
      selectedIndex: -1,
      handedness: null,
      acquiredAtMs: 0,
      lastSeenAtMs: 0,
    },
    rawHand: null,
    posture: "unknown",
    pinchHeld: false,
    fistHeld: false,
    cancelled: false,
    cancelReason: null,
    present: false,
    x: 0.5,
    y: 0.5,
    liveX: 0.5,
    liveY: 0.5,
    pinched: false,
    pressVia: null,
    pressed: false,
    released: false,
    releasedByLoss: false,
    pressProgress: 0,
    dwell: 0,
    dwellFired: false,
    conf: { value: 0, reason: "no-face" },
    box: null,
    face: null,
    faceHeld: false,
    hands: [],
    ratio: Number.NaN,
    fps: 0,
    frame: { w: Number.NaN, h: Number.NaN },
    handSeen: false,
    features: NO_FEATURES,
    palmPx: Number.NaN,
    phase: "IDLE",
    rawHeld: false,
    gestureMs: 0,
    velocity: 0,
    reject: null,
    counts: {
      frames: 0,
      handFrames: 0,
      rawLatches: 0,
      presses: 0,
      lostReleases: 0,
      stuckReleases: 0,
    },
  };
}

/**
 * Whether this state is safe to turn into an action RIGHT NOW.
 *
 * `present` intentionally has a long leave grace for the cursor and idle timer. It must never
 * be used as a motion-validity test: a camera can freeze while presence remains true forever.
 */
export function hasFreshOwner(
  state: Pick<PointerState, "sample" | "owner" | "rawHand">,
  nowMs: number,
  maxAgeMs?: number,
): boolean {
  const capturedAt = state.sample.receivedAtMs;
  const actionableAt = state.sample.processedAtMs;
  const allowedAge = maxAgeMs ?? state.sample.freshForMs;
  const inferenceAge = actionableAt - capturedAt;
  return (
    state.sample.sourceFresh &&
    state.owner.id !== null &&
    state.owner.visible &&
    state.rawHand !== null &&
    Number.isFinite(actionableAt) &&
    Number.isFinite(inferenceAge) &&
    inferenceAge >= 0 &&
    inferenceAge <= CONTROL_MAX_INFERENCE_MS &&
    Number.isFinite(allowedAge) &&
    nowMs >= actionableAt &&
    nowMs - capturedAt <= allowedAge
  );
}

/**
 * The pointing state machine. Framework-free and camera-free: feed it one vision result per
 * frame and read the state. Kept that way so the kiosk, the lab and any future test harness
 * all drive the exact same code, and a number that looks good in one cannot differ in another.
 */
export class HandPointer {
  readonly state: PointerState = blankState();

  private cfg: PointerConfig;
  private readonly smooth: OneEuroPoint;
  private readonly pinch: PinchDetector;
  private readonly fist = new FistLatch(
    DEFAULT_GESTURE_TIMING.fistOnMs,
    DEFAULT_GESTURE_TIMING.fistOffMs,
  );
  private readonly face = new FaceAnchor();
  private readonly owner = new StableHandOwner();
  private readonly ownerFace = new StableOwnerFace();
  private readonly freshness = new ControlFreshnessEstimator();
  private readonly stabilizer = new PointerStabilizer();
  private readonly events: PointerGestureEvent[] = [];
  private readonly dwellEvents: PointerDwellEvent[] = [];
  private activePress: ActivePress | null = null;
  /** Monotonic for this pointer lifetime, including camera/effect restarts. */
  private sampleSeq = 0;
  private seenSince = 0;
  private goneSince = 0;
  private freezeUntil = 0;
  private frozen = { x: 0.5, y: 0.5 };
  /** where the LIVE position was at the press, and whether it has since left `holdRadius` */
  private pressLive = { x: 0.5, y: 0.5 };
  private unpinned = true;
  /** recent smoothed positions, so a press can reach back past its own gesture */
  private history: Array<{ t: number; x: number; y: number }> = [];
  private frames = 0;
  private fpsAt = 0;
  /** when the cursor last stopped travelling — the earliest a press may take its aim from */
  private settledAt = 0;
  private dwellAnchor: { x: number; y: number } | null = null;
  private dwellSince = 0;
  private dwellPausedAt: number | null = null;
  /** dwell must leave the radius before it may fire again — otherwise it repeats forever */
  private dwellArmed = true;
  private dwellFiredAt = -Infinity;
  /** when the current raw click posture began — for the press debounce */
  private rawSince = 0;
  /** sustained neutral/open evidence used when a released fist is labelled `None` */
  private fistNeutralSince = 0;
  /** Recent closed-shape samples; press locks their conservative p75 as a relative baseline. */
  private fistShapeHistory: TimedFistShape[] = [];
  /** a click was force-released; ignore the posture until it ends */
  private suppressed = false;
  /** audit only: previous frame's clock, for a velocity that is per-second not per-frame */
  private lastAt = 0;
  /** Last decoded-frame delivery, used to reject elapsed time with no camera evidence. */
  private lastDecodedAtMs = 0;
  /** audit only: the last reason reported, so a steady state is not logged sixty times a second */
  private lastReject: RejectReason | null = null;

  constructor(cfg: PointerConfig = DEFAULT_POINTER) {
    this.cfg = { ...cfg, oneEuro: { ...cfg.oneEuro }, box: { ...cfg.box } };
    this.smooth = new OneEuroPoint(this.cfg.oneEuro);
    this.pinch = new PinchDetector(
      this.cfg.pinchOn,
      this.cfg.pinchOff,
      DEFAULT_GESTURE_TIMING.pinchGraceMs,
      DEFAULT_GESTURE_TIMING.pinchSettleMs,
      DEFAULT_GESTURE_TIMING.pinchOffMs,
      DEFAULT_GESTURE_TIMING.pinchOnMs,
    );
  }

  /**
   * Live-tunable so a slider — or a calibration — changes the feel without restarting the
   * camera.
   *
   * The thresholds have to be pushed INTO the detector, not just stored: `PinchDetector` is
   * built once in the constructor, so a merged config alone would leave the fitted numbers
   * sitting in `this.cfg` while the classifier went on using the shipped ones. That is the
   * quietest possible way for a calibration to appear to work and change nothing.
   */
  configure(cfg: Partial<PointerConfig> & { timing?: Partial<GestureTimingConfig> }): void {
    const { timing, ...rest } = cfg;
    const mappingChanged =
      (cfg.box !== undefined && !sameBox(this.cfg.box, cfg.box)) ||
      (cfg.reachScale !== undefined && cfg.reachScale !== this.cfg.reachScale) ||
      (cfg.oneEuro !== undefined && !sameOneEuro(this.cfg.oneEuro, cfg.oneEuro));

    if (mappingChanged) {
      const s = this.state;
      const now = Number.isFinite(s.sample.processedAtMs)
        ? s.sample.processedAtMs
        : typeof performance !== "undefined"
          ? performance.now()
          : 0;
      // Nothing measured in the previous coordinate system may land after a profile/display
      // switch. Replace any unconsumed edge with one cancellation that can also close a router
      // session whose press was already consumed.
      this.events.length = 0;
      this.dwellEvents.length = 0;
      if (this.activePress) {
        this.cancelActive("mapping-changed", now);
      } else if (s.owner.id !== null) {
        this.enqueue({
          type: "cancel",
          seq: s.sample.seq,
          at: now,
          ownerId: s.owner.id,
          via: s.pressVia ?? (this.cfg.clickGesture === "pinch" ? "pinch" : "fist"),
          aim: { x: s.x, y: s.y },
          live: { x: s.liveX, y: s.liveY },
          rawHand: s.rawHand ? cloneRawHand(s.rawHand) : null,
          freshForMs: s.sample.freshForMs,
          reason: "mapping-changed",
        });
        s.cancelled = true;
        s.cancelReason = "mapping-changed";
      }
      if (s.rawHeld) this.suppressed = true;
      s.sample.sourceFresh = false;
      this.resetSpatialState();
    }

    this.cfg = { ...this.cfg, ...rest };
    if (cfg.oneEuro) this.smooth.configure(cfg.oneEuro);
    if (cfg.pinchOn !== undefined || cfg.pinchOff !== undefined || timing) {
      this.pinch.configure({
        on: cfg.pinchOn,
        off: cfg.pinchOff,
        graceMs: timing?.pinchGraceMs,
        settleMs: timing?.pinchSettleMs,
        offMs: timing?.pinchOffMs,
        onMs: timing?.pinchOnMs,
      });
    }
    if (timing?.fistOnMs !== undefined || timing?.fistOffMs !== undefined) {
      this.fist.configure({ onMs: timing.fistOnMs, offMs: timing.fistOffMs });
    }
  }

  get config(): PointerConfig {
    return this.cfg;
  }

  /** The thresholds in force, and how closed the hand currently reads — for debug readouts. */
  get pinchThresholds() {
    return this.pinch.thresholds;
  }

  pinchStrength(): number {
    return this.pinch.strength(this.state.ratio);
  }

  /** Consume gesture edges exactly once. The interaction router is the sole intended reader. */
  drainEvents(): PointerGestureEvent[] {
    if (!this.events.length) return [];
    return this.events.splice(0, this.events.length);
  }

  /** Consume dwell completions exactly once, independently of display refresh rate. */
  drainDwellEvents(): PointerDwellEvent[] {
    if (!this.dwellEvents.length) return [];
    return this.dwellEvents.splice(0, this.dwellEvents.length);
  }

  /**
   * Invalidate control without pretending that the visitor opened their hand.
   * Called by the decoded-frame watchdog and track lifecycle events.
   */
  invalidate(
    now: number,
    reason: "source-stale" | "track-ended" | "page-hidden",
  ): void {
    const s = this.state;
    s.sample.sourceFresh = false;
    s.owner.visible = false;
    s.owner.selectedIndex = -1;
    s.rawHand = null;
    s.handSeen = false;
    s.posture = "unknown";
    s.pinchHeld = false;
    s.fistHeld = false;
    s.present = false;
    this.seenSince = 0;
    this.goneSince = now;
    s.pressed = false;
    s.released = false;
    s.releasedByLoss = true;
    s.dwellFired = false;
    this.cancelActive(reason, now);
    // Even if there was no active press, resuming directly into a closed posture is not a new
    // click. Positive open-hand evidence is required to begin the next gesture epoch.
    this.suppressed = true;
    this.resetTrackingState(true);
    // A resumed stream is a new observation epoch. Keeping the old spatial track through a
    // frozen/hidden source could let whichever hand appears next inherit an in-progress
    // visitor's identity.
    this.owner.reset();
    this.freshness.reset();
    this.lastDecodedAtMs = 0;
  }

  /** The configured box with `reachScale` applied about its centre. */
  private scaledBox(): BoxConfig {
    const k = this.cfg.reachScale;
    if (!(k > 0) || k === 1) return this.cfg.box;
    return {
      ...this.cfg.box,
      widthFaces: this.cfg.box.widthFaces * k,
      heightFaces: this.cfg.box.heightFaces * k,
    };
  }

  /** The smoothed position as it was at time `t` — how a press recovers its aim. */
  private positionAt(t: number): { x: number; y: number } {
    const h = this.history;
    if (!h.length) return { x: this.state.x, y: this.state.y };
    for (let i = h.length - 1; i >= 0; i -= 1) {
      const p = h[i];
      if (p && p.t <= t) return { x: p.x, y: p.y };
    }
    const first = h[0]!;
    return { x: first.x, y: first.y };
  }

  update(res: VisionResult, aspect: number, stampOrNow: number | DecodedFrameStamp): PointerState {
    const s = this.state;
    const stamp: DecodedFrameStamp =
      typeof stampOrNow === "number"
        ? {
            seq: ++this.sampleSeq,
            receivedAtMs: stampOrNow,
            processedAtMs: stampOrNow,
            inferenceMs: 0,
            mediaTimeMs: stampOrNow,
          }
        : { ...stampOrNow, seq: ++this.sampleSeq };
    const now = stamp.receivedAtMs;
    const processedAtMs =
      Number.isFinite(stamp.processedAtMs) && stamp.processedAtMs! >= now
        ? stamp.processedAtMs!
        : now;
    const inferenceMs =
      Number.isFinite(stamp.inferenceMs) && stamp.inferenceMs! >= 0 ? stamp.inferenceMs! : 0;
    const decodedGapMs = this.lastDecodedAtMs > 0 ? now - this.lastDecodedAtMs : 0;
    const decodedContinuityBroken =
      !Number.isFinite(decodedGapMs) ||
      decodedGapMs < 0 ||
      decodedGapMs > CONTROL_MAX_SAMPLE_GAP_MS;
    const sampleAgeMs = processedAtMs - now;
    const sampleTooOld =
      !Number.isFinite(sampleAgeMs) ||
      sampleAgeMs < 0 ||
      sampleAgeMs > CONTROL_MAX_INFERENCE_MS ||
      inferenceMs > CONTROL_MAX_INFERENCE_MS;
    const continuityBroken = decodedContinuityBroken || sampleTooOld;
    this.lastDecodedAtMs = now;

    if (continuityBroken) this.freshness.reset();
    const freshForMs = this.freshness.update(
      processedAtMs,
      sampleTooOld ? 0 : inferenceMs,
    );

    s.sample = {
      ...stamp,
      processedAtMs,
      inferenceMs,
      freshForMs,
      sourceFresh: !sampleTooOld,
    };
    s.pressed = false;
    s.released = false;
    s.releasedByLoss = false;
    s.cancelled = false;
    s.cancelReason = null;
    s.dwellFired = false;

    if (continuityBroken) {
      // Elapsed-time gesture gates may only count intervals bracketed by decoded observations.
      // Cancel an active operation, clear every recogniser accumulator and stay disarmed until
      // a real open hand is seen. The resumed closed frame may seed a new latch for diagnostics,
      // but suppression prevents it from becoming an action without that open transition.
      this.cancelActive("source-stale", now);
      this.suppressed = true;
      this.resetTrackingState();
    }

    this.frames += 1;
    if (!this.fpsAt) this.fpsAt = now;
    else if (now - this.fpsAt > 500) {
      s.fps = (this.frames / (now - this.fpsAt)) * 1000;
      this.frames = 0;
      this.fpsAt = now;
    }

    // MediaPipe result order is not identity. Select the same physical hand by continuity and
    // reserve it briefly through gaps so a bystander's hand cannot steal a held interaction.
    const previousOwnerId = s.owner.id;
    const selected = this.owner.update(
      res.hands,
      now,
      aspect,
      // `freshForMs` is measured from capture. On a loaded Gaussian page, most of that lease can
      // already have elapsed by the time inference completes, and one genuinely missing result
      // spans two completion periods between visible hands. Keep the immutable owner through one
      // bounded post-freshness hole; recovered coordinates still need to pass the ordinary match.
      this.activePress ? freshForMs + CONTROL_TRACKING_GAP_GRACE_MS : undefined,
    );
    s.owner = {
      id: selected.ownerId,
      visible: selected.visible,
      selectedIndex: selected.selectedIndex,
      handedness: selected.handedness,
      acquiredAtMs: selected.acquiredAtMs,
      lastSeenAtMs: selected.lastSeenAtMs,
    };
    const identityBoundary =
      selected.changed ||
      (previousOwnerId !== null &&
        (selected.ownerId === null || previousOwnerId !== selected.ownerId));
    if (identityBoundary) {
      const lostActive = this.activePress !== null;
      const boundaryReason = selected.ownerId === null ? "hand-lost" : "owner-changed";
      this.cancelActive(boundaryReason, now);
      if (lostActive && boundaryReason === "hand-lost") {
        s.counts.lostReleases += 1;
        noteReject("PINCH_RELEASE_NOT_FOUND", "owner missing beyond tracking grace", now);
      }
      this.resetTrackingState(true);
      s.present = false;
      this.seenSince = 0;
      this.goneSince = now;
    }

    const hand = selected.hand;
    const palm = palmCenter(hand?.landmarks);
    const palmNorm = palmWidthNorm(hand?.landmarks, aspect);
    const wrist = hand?.landmarks[JOINT.wrist] ?? null;

    const associatedFace = this.ownerFace.update(
      res.faces ?? (res.face ? [res.face] : []),
      selected.ownerId,
      wrist,
      palmNorm,
      now,
      aspect,
    );
    // A face narrower than the visitor's own palm is likely a poster or somebody behind them.
    const plausibleFace =
      associatedFace && palmNorm > 0 && associatedFace.w < palmNorm * MIN_FACE_PER_PALM
        ? null
        : associatedFace;
    const face = this.face.update(plausibleFace, now, selected.visible);
    const boxCfg = this.scaledBox();
    const box = interactionBox(face, aspect, boxCfg) ?? fallbackBox(palmNorm, aspect, boxCfg);
    const ratio = handRatio(hand);

    s.box = box;
    s.face = face;
    s.faceHeld = this.face.held;
    s.hands = res.hands.map((item) => item.landmarks);
    s.ratio = ratio;
    s.rawHand =
      wrist && Number.isFinite(wrist.x) && Number.isFinite(wrist.y) && palmNorm > 0
        ? {
            frameX: wrist.x,
            frameY: frameYInXUnits(wrist.y, aspect),
            palmSpan: palmNorm,
            body:
              face && face.w > 0
                ? {
                    xFaces: (wrist.x - face.cx) / face.w,
                    yFaces: (wrist.y - face.cy) / face.w,
                    anchorHeld: this.face.held,
                  }
                : null,
          }
        : null;

    const trueFrameW = res.frame?.w && res.frame.w > 0 ? res.frame.w : 1280;
    s.conf = confidence(face, box, hand ? palmNorm * trueFrameW : Number.NaN);

    // --- audit instrumentation ------------------------------------------------------------
    const frameW = res.frame?.w ?? Number.NaN;
    const frameH = res.frame?.h ?? Number.NaN;
    s.frame = { w: frameW, h: frameH };
    s.handSeen = !!hand;
    s.features = pinchFeatures(hand, frameW, frameH);
    s.palmPx = palmNorm * frameW;
    s.counts.frames += 1;
    if (hand) s.counts.handFrames += 1;
    const dtS = this.lastAt ? Math.max(1e-3, (now - this.lastAt) / 1000) : 0;
    this.lastAt = now;

    // Presence remains deliberately forgiving for cursor visibility and the kiosk idle timer.
    // Action validity is the much tighter `hasFreshOwner`, never this flag.
    if (hand && palm && box) {
      this.goneSince = 0;
      if (!this.seenSince) this.seenSince = now;
      if (!s.present && now - this.seenSince > this.cfg.enterMs) s.present = true;
    } else {
      this.seenSince = 0;
      if (!this.goneSince) this.goneSince = now;
      if (s.present && now - this.goneSince > this.cfg.leaveMs) {
        s.present = false;
        this.smooth.reset();
        this.dwellAnchor = null;
        s.dwell = 0;
      }
    }

    // MediaPipe commonly loses the landmarks for one or two frames exactly while the fingers
    // fold over the palm. StableHandOwner has reserved the same non-null identity, so this is an
    // observation gap, not a release and not an invitation for another hand to take over. Keep
    // the immutable press and last held position, pause every recogniser/off timer, and let the
    // owner reservation provide the hard bound. Once that reservation expires the identity
    // boundary above cancels the operation normally.
    if (!hand && this.activePress && selected.ownerId === this.activePress.ownerId) {
      s.rawHand = null;
      s.owner.visible = false;
      s.posture = "unknown";
      s.pressed = false;
      s.released = false;
      s.rawHeld = true;
      s.pinched = true;
      s.pressVia = this.activePress.via;
      s.pressProgress = 0;
      s.phase = "HELD";
      s.reject = "HAND_NOT_FOUND";
      this.lastReject = "HAND_NOT_FOUND";
      return s;
    }

    // --- recognition and explicit open/closed/unknown posture ----------------------------
    const g = this.cfg.clickGesture;
    const pinching = g !== "fist" && this.pinch.update(ratio, now);
    const rawGeometricFist = hand ? fistFromGeometry(hand.world) : false;
    const classifierFist =
      !!hand && hand.label === "Closed_Fist" && hand.score >= FIST_MIN_SCORE;
    const confidentClassifierFist =
      !!hand && hand.label === "Closed_Fist" && hand.score >= FIST_RELEASE_VETO_SCORE;
    const curls = hand ? fingerCurlRatios(hand.world) : null;
    const currentShape: FistShape = {
      aperture: Number.isFinite(ratio) ? ratio : null,
      curls,
    };
    const baseline = this.activePress?.via === "fist" ? this.activePress.fistBaseline : null;
    const apertureRelaxed =
      !confidentClassifierFist &&
      !rawGeometricFist &&
      baseline?.aperture != null &&
      currentShape.aperture != null &&
      currentShape.aperture - baseline.aperture >= FIST_APERTURE_RELAX_DELTA;
    const curlRelaxed =
      !confidentClassifierFist && fistCurlRelaxed(baseline?.curls ?? null, currentShape.curls);
    const relativeFistRelaxed = curlRelaxed || apertureRelaxed;
    // Only multi-finger uncurl may override a geometry vote that is still technically below
    // the old 1.0 boundary. Merely opening the thumb/index aperture cannot release a true fist.
    const geometricFist = rawGeometricFist && !curlRelaxed;
    // A 0.4 classifier vote is useful for acquiring a fist, but it is not strong enough to veto
    // a sustained, multi-finger release measured relative to this exact press. Keep a higher veto
    // threshold for that conflict so a stale 0.41 label cannot hold the UI down for 30 seconds.
    const effectiveClassifierFist =
      classifierFist && !(this.activePress?.via === "fist" && relativeFistRelaxed);
    const fistEvidence = !!hand && (effectiveClassifierFist || geometricFist);
    const fisting =
      g !== "pinch" &&
      this.fist.update(
        effectiveClassifierFist ? "Closed_Fist" : null,
        effectiveClassifierFist ? hand?.score ?? 0 : 0,
        geometricFist,
        now,
      );
    if (g === "fist") this.pinch.update(ratio, now);
    s.pinchHeld = pinching;
    s.fistHeld = fisting;

    const fingers = hand ? extendedFingers(hand.landmarks) : null;
    const openPalm =
      !!hand &&
      ((hand.label === "Open_Palm" && hand.score >= OPEN_PALM_MIN_SCORE) ||
        (fingers ? fingers.slice(1).filter(Boolean).length >= 3 : false));
    const pinchOpen = !!hand && Number.isFinite(ratio) && ratio > this.cfg.pinchOff;
    // `fisting` already contains the first elapsed-time release hysteresis. Do not override it
    // with one Open_Palm label or one noisy geometry vote: doing so turns a single bad frame
    // into release -> second press while the visitor never opened their fist.
    //
    // MediaPipe commonly labels an ordinarily relaxed hand `None`, however. Requiring a
    // classifier-perfect Open_Palm left the accepted fist latched forever, so no later control
    // could produce another press. For that neutral path, require a wide thumb/index aperture
    // to remain after the fist latch has gone off for a second, independent time gate.
    const activeFistNeedsNaturalProof = this.activePress?.via === "fist";
    const neutralFistCandidate =
      !!hand &&
      !fisting &&
      !fistEvidence &&
      (!activeFistNeedsNaturalProof || openPalm || pinchOpen || relativeFistRelaxed);
    if (neutralFistCandidate) {
      if (!this.fistNeutralSince) this.fistNeutralSince = now;
    } else {
      this.fistNeutralSince = 0;
    }
    const neutralFistOpen =
      this.fistNeutralSince > 0 && now - this.fistNeutralSince >= FIST_NEUTRAL_RELEASE_MS;
    const confirmedFistOpen = !fisting && !fistEvidence && (openPalm || neutralFistOpen);
    // Aperture above the off threshold is only provisional open evidence. The detector's
    // elapsed release grace must complete before a pinch can release or re-arm; otherwise one
    // noisy fingertip frame can end a held click and manufacture another press.
    const confirmedPinchOpen = pinchOpen && !pinching;
    const rawHeld = !!hand && (pinching || fisting);
    const pinchEvidence = !!hand && Number.isFinite(ratio) && ratio <= this.cfg.pinchOff;
    const directGestureClosed =
      g === "fist"
        ? fistEvidence
        : g === "pinch"
          ? pinchEvidence
          : fistEvidence || pinchEvidence;
    const explicitGestureOpen =
      g === "fist"
        ? confirmedFistOpen
        : g === "pinch"
          ? confirmedPinchOpen
          : confirmedFistOpen && confirmedPinchOpen;
    // The router and the press latch must agree about whether this gesture epoch is open.
    // Previously a neutral-labelled hand was published as `open` from its aperture while the
    // fist press itself remained held, so the router re-armed even though HandPointer could
    // never emit another press. One canonical value now drives both decisions.
    // Direct evidence publishes CLOSED immediately so the router keeps its neutral arming while
    // the temporal latch is still proving a deliberate close. Once an active press exists, the
    // latch remains held briefly after that direct evidence disappears; publish this release-
    // hysteresis interval as UNKNOWN, not CLOSED. Opening can move the mapped hand shape, and
    // treating those frames as held motion would turn a stationary tap into scroll. UI sessions
    // wait safely for the durable release edge; scene motion fails closed.
    const closingOrHeld = directGestureClosed || (rawHeld && !this.activePress);
    s.posture = closingOrHeld
      ? "closed"
      : rawHeld
        ? "unknown"
        : explicitGestureOpen
          ? "open"
          : "unknown";

    if (rawHeld && !s.rawHeld) {
      s.counts.rawLatches += 1;
      this.frozen = this.positionAt(Math.max(now - this.cfg.pressLookbackMs, this.settledAt));
      this.pressLive = { x: s.liveX, y: s.liveY };
      this.unpinned = false;
    }
    if (!rawHeld && s.rawHeld && s.pressProgress > 0 && !this.activePress) {
      noteReject(
        "PINCH_TOO_SHORT",
        `held ${(now - this.rawSince).toFixed(0)}ms of ${PRESS_DEBOUNCE_MS}ms`,
        now,
      );
    }
    s.rawHeld = rawHeld;
    if (!rawHeld) {
      this.rawSince = 0;
      // A timeout/discontinuity suppression is released only by the configured gesture's
      // canonical open evidence. For a fist, aperture alone is not enough: it must follow the
      // non-fist latch and survive the neutral-release gate. A lost hand can never re-arm it.
      if (explicitGestureOpen && !sampleTooOld) this.suppressed = false;
    } else if (!this.rawSince) {
      this.rawSince = now;
    }

    if (!this.activePress && (classifierFist || rawGeometricFist)) {
      this.fistShapeHistory.push({ at: now, ...currentShape });
      const cutoff = now - FIST_BASELINE_HISTORY_MS;
      while (
        this.fistShapeHistory.length > 1 &&
        (this.fistShapeHistory[0]?.at ?? 0) < cutoff
      ) {
        this.fistShapeHistory.shift();
      }
    } else if (!this.activePress && !rawHeld) {
      this.fistShapeHistory = [];
    }

    const debouncedHeld =
      !this.suppressed && rawHeld && this.rawSince > 0 && now - this.rawSince >= PRESS_DEBOUNCE_MS;
    s.pressProgress =
      this.suppressed || !rawHeld || this.activePress
        ? 0
        : Math.min(1, (now - this.rawSince) / PRESS_DEBOUNCE_MS);

    let pendingPress = false;
    let pendingRelease: ActivePress | null = null;
    if (!this.activePress && debouncedHeld && s.owner.id !== null && s.rawHand) {
      if (this.unpinned) {
        this.frozen = this.positionAt(Math.max(now - this.cfg.pressLookbackMs, this.settledAt));
        this.pressLive = { x: s.liveX, y: s.liveY };
        this.unpinned = false;
      }
      // A real fist often also collapses the thumb/index aperture below the pinch threshold.
      // Prefer the whole-hand posture when both classifiers are true: its release requires
      // either an explicit open palm or the separately gated neutral-hand proof, while a pinch
      // release is governed by the aperture detector.
      const via: "pinch" | "fist" = fisting ? "fist" : "pinch";
      this.activePress = {
        ownerId: s.owner.id,
        via,
        aim: { ...this.frozen },
        lastHeldLive: { x: s.liveX, y: s.liveY },
        fistBaseline: via === "fist" ? fistShapeBaseline(this.fistShapeHistory) : null,
        startedAt: now,
      };
      pendingPress = true;
      s.pressed = true;
      s.counts.presses += 1;
      this.freezeUntil = now + this.cfg.pressFreezeMs;
      this.dwellAnchor = null;
      s.dwell = 0;
      this.dwellArmed = false;
    }

    if (this.activePress) {
      const explicitOpen =
        this.activePress.via === "pinch" ? confirmedPinchOpen : confirmedFistOpen;
      if (explicitOpen) {
        pendingRelease = this.activePress;
        this.activePress = null;
        s.released = true;
        // In `either` mode a fist can also satisfy the pinch detector (and vice versa). Releasing
        // the detector that owns this epoch must not let the still-held secondary detector create
        // an immediate second press. Suppress until both channels have observed canonical open.
        if (rawHeld) this.suppressed = true;
      } else if (now - this.activePress.startedAt > MAX_HOLD_MS) {
        this.suppressed = true;
        s.counts.stuckReleases += 1;
        noteReject("PINCH_HELD_TOO_LONG", `${(now - this.activePress.startedAt).toFixed(0)}ms`, now);
        this.cancelActive("hold-timeout", now);
      }
    }
    s.pinched = this.activePress !== null;
    s.pressVia = this.activePress?.via ?? null;

    // --- mapped UI position (separate from raw scene coordinates) -------------------------
    if (palm && box) {
      const m = mapToBox(box, palm);
      const filtered = this.smooth.filter(m.u, m.v, now);
      const f = this.stabilizer.filter(
        filtered.x,
        filtered.y,
        s.posture === "open" && !this.activePress,
        now,
      );
      this.history.push({ t: now, x: f.x, y: f.y });
      const cutoff = now - HISTORY_MS;
      while (this.history.length > 1 && (this.history[0]?.t ?? 0) < cutoff) this.history.shift();

      const moved = Math.hypot(f.x - s.liveX, f.y - s.liveY);
      if (dtS) s.velocity = moved / dtS;
      if (moved > 0.004) this.settledAt = now;
      s.liveX = f.x;
      s.liveY = f.y;
      if (
        !this.unpinned &&
        Math.hypot(f.x - this.pressLive.x, f.y - this.pressLive.y) > this.cfg.holdRadius
      ) {
        this.unpinned = true;
      }
      if (now < this.freezeUntil || ((s.pinched || rawHeld) && !this.unpinned)) {
        s.x = this.frozen.x;
        s.y = this.frozen.y;
      } else {
        s.x = f.x;
        s.y = f.y;
      }
    }

    // Opening a fist changes the hand silhouette and can move the mapped wrist a little even
    // when the visitor intended a stationary tap. A release must decide tap-versus-scroll from
    // the last position while the gesture was actually held, not from that opening frame. This
    // still captures a real fast drag because every closed camera sample advances this value.
    const activeStillClosed =
      this.activePress?.via === "fist" ? fistEvidence : pinchEvidence;
    if (this.activePress && activeStillClosed) {
      this.activePress.lastHeldLive = { x: s.liveX, y: s.liveY };
    }

    if (pendingPress && this.activePress && s.rawHand) {
      this.enqueue({
        type: "press",
        seq: s.sample.seq,
        // Freshness is total age since capture, not a new lease beginning when inference ends.
        at: now,
        ownerId: this.activePress.ownerId,
        via: this.activePress.via,
        aim: { ...this.activePress.aim },
        live: { ...this.activePress.lastHeldLive },
        rawHand: cloneRawHand(s.rawHand),
        freshForMs,
      });
    }
    if (pendingRelease) {
      this.enqueue({
        type: "release",
        seq: s.sample.seq,
        at: now,
        ownerId: pendingRelease.ownerId,
        via: pendingRelease.via,
        aim: { ...pendingRelease.aim },
        live: { ...pendingRelease.lastHeldLive },
        rawHand: s.rawHand ? cloneRawHand(s.rawHand) : null,
        freshForMs,
      });
      this.fistShapeHistory = [];
    }

    // --- dwell ---------------------------------------------------------------------------
    if (
      this.cfg.dwellMs > 0 &&
      s.present &&
      !rawHeld &&
      !s.pinched &&
      hasFreshOwner(s, processedAtMs)
    ) {
      if (this.dwellPausedAt !== null) {
        // A possible click posture pauses dwell rather than earning dwell time. Brief pinch
        // noise therefore does not destroy accessibility progress, while a real gesture can
        // never complete both activation paths at once.
        this.dwellSince += Math.max(0, now - this.dwellPausedAt);
        this.dwellPausedAt = null;
      }
      const a = this.dwellAnchor;
      const moved = a ? Math.hypot(s.x - a.x, s.y - a.y) : Infinity;
      const rearmAt = this.cfg.dwellRadius * REARM_FACTOR;
      if (!a || moved > (this.dwellArmed ? this.cfg.dwellRadius : rearmAt)) {
        this.dwellAnchor = { x: s.x, y: s.y };
        this.dwellSince = now;
        if (!this.dwellArmed && now - this.dwellFiredAt > DWELL_REFRACTORY_MS) {
          this.dwellArmed = true;
        }
        s.dwell = 0;
      } else if (this.dwellArmed) {
        const held = now - this.dwellSince;
        s.dwell = Math.min(1, held / this.cfg.dwellMs);
        if (s.dwell >= 1) {
          s.dwellFired = true;
          this.dwellArmed = false;
          this.dwellFiredAt = now;
          if (s.owner.id !== null) {
            this.dwellEvents.push({
              seq: s.sample.seq,
              at: now,
              ownerId: s.owner.id,
              aim: { x: s.x, y: s.y },
              freshForMs,
            });
            if (this.dwellEvents.length > MAX_EVENT_QUEUE) {
              this.dwellEvents.splice(0, this.dwellEvents.length - MAX_EVENT_QUEUE);
            }
          }
        }
      } else {
        s.dwell = 0;
      }
    } else {
      s.dwell = 0;
      if (rawHeld && this.dwellPausedAt === null) this.dwellPausedAt = now;
      if (!rawHeld && (!s.present || !hasFreshOwner(s, processedAtMs))) {
        this.dwellPausedAt = null;
        this.dwellAnchor = null;
      }
    }

    // --- audit rejection -----------------------------------------------------------------
    const gates = this.pinch.gates;
    s.gestureMs = this.rawSince ? now - this.rawSince : 0;
    s.phase = this.suppressed
      ? "SUPPRESSED"
      : s.pinched
        ? "HELD"
        : rawHeld
          ? "ARMING"
          : this.pinch.strength(ratio) > 0.15
            ? "CLOSING"
            : "IDLE";

    let reject: RejectReason | null = null;
    let detail = "";
    if (!hand) {
      reject = "HAND_NOT_FOUND";
    } else if (!box) {
      reject = "NO_INTERACTION_BOX";
      detail = "no face and no usable palm scale";
    } else if (this.suppressed) {
      reject = "PINCH_HELD_TOO_LONG";
    } else if (!s.pinched && !rawHeld) {
      if (Number.isFinite(s.palmPx) && s.palmPx < MIN_PALM_PX) {
        reject = "HAND_TOO_SMALL";
        detail = `palm ${s.palmPx.toFixed(0)}px < ${MIN_PALM_PX}px floor`;
      } else if (gates.settledMs < gates.settleMs) {
        reject = "LANDMARK_UNSTABLE";
        detail = `settling ${gates.settledMs.toFixed(0)}/${gates.settleMs.toFixed(0)}ms after a tracking gap`;
      } else if (s.phase === "CLOSING" && Number.isFinite(ratio) && ratio >= this.cfg.pinchOn) {
        reject = "PINCH_SCORE_ABOVE_THRESHOLD";
        detail = `ratio ${ratio.toFixed(3)} ≥ on ${this.cfg.pinchOn}, closed ${(
          this.pinch.strength(ratio) * 100
        ).toFixed(0)}% of the way`;
      }
    }
    s.reject = reject;
    if (reject && reject !== this.lastReject) noteReject(reject, detail, now);
    this.lastReject = reject;
    return s;
  }

  private enqueue(event: PointerGestureEvent): void {
    this.events.push(event);
    if (this.events.length > MAX_EVENT_QUEUE) this.events.splice(0, this.events.length - MAX_EVENT_QUEUE);
  }

  private cancelActive(reason: PointerCancelReason, now: number): void {
    const active = this.activePress;
    if (!active) return;
    const s = this.state;
    this.enqueue({
      type: "cancel",
      seq: s.sample.seq,
      at: now,
      ownerId: active.ownerId,
      via: active.via,
      aim: { ...active.aim },
      live: { x: s.liveX, y: s.liveY },
      rawHand: s.rawHand ? cloneRawHand(s.rawHand) : null,
      freshForMs: s.sample.freshForMs,
      reason,
    });
    this.activePress = null;
    // A cancelled close is not an open. Require positive open-hand evidence before another
    // press, otherwise a one-frame occlusion or owner replacement can manufacture a second
    // press from the same uninterrupted fist.
    this.suppressed = true;
    s.pinched = false;
    s.pressVia = null;
    s.cancelled = true;
    s.cancelReason = reason;
    s.released = false;
    s.releasedByLoss = reason !== "hold-timeout";
  }

  private resetTrackingState(resetFace = false): void {
    const s = this.state;
    this.smooth.reset();
    this.stabilizer.reset();
    this.pinch.reset();
    this.fist.reset();
    if (resetFace) {
      this.face.reset();
      this.ownerFace.reset();
    }
    this.rawSince = 0;
    this.fistNeutralSince = 0;
    this.fistShapeHistory = [];
    this.freezeUntil = 0;
    this.history = [];
    this.unpinned = true;
    this.dwellAnchor = null;
    this.dwellPausedAt = null;
    this.dwellArmed = true;
    this.lastAt = 0;
    s.rawHeld = false;
    s.pinchHeld = false;
    s.fistHeld = false;
    s.pressProgress = 0;
    s.pinched = false;
    s.pressVia = null;
    s.dwell = 0;
    s.phase = "IDLE";
  }

  /** Forget coordinates without discarding the physical owner or the face ruler. */
  private resetSpatialState(): void {
    const s = this.state;
    this.smooth.reset();
    this.stabilizer.reset();
    this.history = [];
    this.freezeUntil = 0;
    this.unpinned = true;
    this.settledAt = 0;
    this.lastAt = 0;
    this.dwellAnchor = null;
    this.dwellSince = 0;
    this.dwellPausedAt = null;
    this.dwellArmed = true;
    s.velocity = 0;
    s.dwell = 0;
    s.dwellFired = false;
  }
}

function sameBox(a: BoxConfig, b: BoxConfig): boolean {
  return (
    a.widthFaces === b.widthFaces &&
    a.heightFaces === b.heightFaces &&
    a.dropFaces === b.dropFaces &&
    a.shiftFaces === b.shiftFaces
  );
}

function sameOneEuro(a: OneEuroConfig, b: OneEuroConfig): boolean {
  return a.minCutoff === b.minCutoff && a.beta === b.beta && a.dCutoff === b.dCutoff;
}

function cloneRawHand(raw: RawHandState): RawHandState {
  return {
    frameX: raw.frameX,
    frameY: raw.frameY,
    palmSpan: raw.palmSpan,
    body: raw.body ? { ...raw.body } : null,
  };
}

/** A face this much narrower than the palm beside it is somebody else's — see `update`. */
const MIN_FACE_PER_PALM = 0.9;
const OPEN_PALM_MIN_SCORE = 0.4;
const FIST_MIN_SCORE = 0.4;
/** Only a clearly confident classifier may overrule sustained relative opening evidence. */
const FIST_RELEASE_VETO_SCORE = 0.75;
/**
 * A released fist is commonly labelled `None`, not `Open_Palm`, especially when a visitor
 * merely relaxes their hand instead of presenting a flat palm to the camera. The fist latch
 * already requires sustained non-fist evidence; require this additional interval of clearly
 * open thumb/index aperture before a neutral-labelled hand may end the click epoch.
 */
const FIST_NEUTRAL_RELEASE_MS = 180;
/** Closed-shape history locked when a fist becomes a confirmed press. */
const FIST_BASELINE_HISTORY_MS = 240;
/** Thumb/index separation change, in palm widths, that is visibly more open than the press. */
const FIST_APERTURE_RELAX_DELTA = 0.25;
/** At least two non-thumb fingers must uncurl this much relative to the press baseline. */
const FIST_CURL_RELAX_DELTA = 0.15;
/** And one of those fingers must approach the historical absolute open boundary. */
const FIST_CURL_RELAX_FLOOR = 0.9;
const MAX_EVENT_QUEUE = 64;
/** Camera permission/model load may be slow; decoded frames themselves should not be. */
const CAMERA_STARTUP_TIMEOUT_MS = 4_000;
/** A freshness watchdog cancels control promptly; only a sustained gap rebuilds hardware. */
const CAMERA_STALL_RECONNECT_MS = 1_500;
/** Finite retries: a dead or busy camera must eventually become an honest terminal error. */
const CAMERA_RECONNECT_DELAYS_MS = [0, 500, 1_000, 2_000] as const;
/** One lucky frame is not recovery. Only sustained decoded evidence restores the retry budget. */
const CAMERA_RECOVERY_STABLE_MS = 2_000;
const CAMERA_RECOVERY_STABLE_FRAMES = 12;
/** A reconnect prompt/play operation may not leave the kiosk loading forever. */
const CAMERA_RECONNECT_ACQUIRE_MS = 10_000;
const CAMERA_PLAY_TIMEOUT_MS = 5_000;
/** How much recent position history to keep, in ms. Only has to outlast `pressLookbackMs`. */
const HISTORY_MS = 600;
/** Re-arming dwell needs a real move, not the smoothing's settling creep. */
const REARM_FACTOR = 2.5;
/** ...and no dwell may follow another this soon, whatever the cursor did. */
const DWELL_REFRACTORY_MS = 700;

function percentile75(values: number[]): number | null {
  const finite = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (finite.length < 3) return null;
  return finite[Math.floor((finite.length - 1) * 0.75)] ?? null;
}

function fistShapeBaseline(samples: TimedFistShape[]): FistShape | null {
  if (samples.length < 3) return null;
  const aperture = percentile75(
    samples.flatMap((sample) => (sample.aperture === null ? [] : [sample.aperture])),
  );
  const channels = [0, 1, 2, 3].map((index) =>
    percentile75(
      samples.flatMap((sample) => {
        const value = sample.curls?.[index];
        return value === undefined ? [] : [value];
      }),
    ),
  );
  const curls = channels.every((value): value is number => value !== null)
    ? (channels as [number, number, number, number])
    : null;
  return aperture === null && curls === null ? null : { aperture, curls };
}

function fistCurlRelaxed(
  baseline: [number, number, number, number] | null,
  current: [number, number, number, number] | null,
): boolean {
  if (!baseline || !current) return false;
  const relaxed = current.filter(
    (value, index) => value - baseline[index]! >= FIST_CURL_RELAX_DELTA,
  );
  return relaxed.length >= 2 && relaxed.some((value) => value >= FIST_CURL_RELAX_FLOOR);
}
/**
 * How long a click posture must be held before it counts as a press at all.
 *
 * FITTED, not chosen. Replaying the recorded trials at every value from 120ms to 600ms, the
 * number of real pinches detected does not move at all — 4, 7 and 1, at every setting — while
 * false clicks fall from three to zero. Real pinches are HELD; the false ones are momentary
 * artefacts of a hand being reacquired mid-movement. So this costs nothing and buys the
 * difference between a cursor that occasionally activates things by itself and one that does
 * not.
 *
 * That mattered enough to pay 350ms for: an arm sweep — just moving the cursor — was firing
 * clicks, and stray activations are the failure that makes a touchless screen feel broken
 * rather than imprecise. `pressLookbackMs` is set past this so the aim still comes from
 * before the hand began closing.
 *
 * Re-checked Sept 2026 when the fist was made easier to read: the idle recordings start
 * producing a phantom click at 280ms and are clean again at 300ms, so 350 keeps a margin and
 * stays. "Held it and nothing happened" was never this number — it was the fist not being
 * recognised at all (see `FistLatch`).
 */
export const PRESS_DEBOUNCE_MS = 350;
/**
 * The longest a click posture can be held before it is treated as a mistake rather than an
 * intention.
 *
 * A scene grab or a long page scroll may legitimately last several seconds, so this is a
 * backstop for a genuinely stuck classifier rather than a click-duration policy. Timing out is
 * a cancellation and stays suppressed until canonical open evidence is observed.
 */
const MAX_HOLD_MS = 30_000;

/**
 * Fist detection: MediaPipe's own gesture classifier, OR the hand's 3D geometry.
 *
 * It used to be the classifier alone, on the argument that geometry fails where a trained
 * model copes — a hand edge-on, at an angle, partly self-occluded. The wall said otherwise: the
 * most common report from in front of it was "I made a fist and held it and nothing happened",
 * and the recording shows why — the label sits at "None" for the whole hold, at a confidence
 * just under the bar, and the visitor has no way of knowing the hand they are holding shut is
 * being read as open. A click that needs a second opinion is better than one that needs a
 * perfect first.
 *
 * So both are read, and either is enough. The geometric read is on the WORLD landmarks, which
 * is what takes away the classic false positive (a finger pointed at the lens, foreshortened to
 * nothing) — see `fistFromGeometry`. The score bar on the label came down as well: 0.5 was
 * refusing frames the model itself ranked as "fist, more likely than not".
 *
 * Elapsed-time gates rather than a score threshold do the hysteresis, because both signals
 * flicker even when the posture is unambiguous to a human. They run on decoded-sample
 * timestamps so loading the Gaussian renderer cannot change their duration.
 */
export class FistLatch {
  private on = false;
  private closedSinceMs: number | null = null;
  private openedSinceMs: number | null = null;
  private lastSampleAtMs: number | null = null;
  count = 0;

  constructor(
    private onMs = DEFAULT_GESTURE_TIMING.fistOnMs,
    private offMs = DEFAULT_GESTURE_TIMING.fistOffMs,
    private readonly minScore = FIST_MIN_SCORE,
  ) {}

  configure(cfg: { onMs?: number; offMs?: number }): void {
    if (Number.isFinite(cfg.onMs ?? NaN)) this.onMs = Math.max(0, cfg.onMs!);
    if (Number.isFinite(cfg.offMs ?? NaN)) this.offMs = Math.max(0, cfg.offMs!);
  }

  update(label: string | null, score: number, geometric: boolean, sampleAtMs: number): boolean {
    const at = Number.isFinite(sampleAtMs)
      ? Math.max(sampleAtMs, this.lastSampleAtMs ?? sampleAtMs)
      : this.lastSampleAtMs;
    if (at === null) return this.on;
    this.lastSampleAtMs = at;

    const isFist = (label === "Closed_Fist" && score >= this.minScore) || geometric;
    if (isFist) {
      if (this.closedSinceMs === null) this.closedSinceMs = at;
      this.openedSinceMs = null;
    } else {
      if (this.openedSinceMs === null) this.openedSinceMs = at;
      this.closedSinceMs = null;
    }

    if (
      !this.on &&
      this.closedSinceMs !== null &&
      at - this.closedSinceMs >= this.onMs
    ) {
      this.on = true;
      this.count += 1;
    } else if (
      this.on &&
      this.openedSinceMs !== null &&
      at - this.openedSinceMs >= this.offMs
    ) {
      this.on = false;
    }
    return this.on;
  }

  reset(): void {
    this.on = false;
    this.closedSinceMs = null;
    this.openedSinceMs = null;
    this.lastSampleAtMs = null;
    this.count = 0;
  }
}

/** Aperture over palm width — scale-free, so it means the same at any distance or hand size. */
function handRatio(hand: { world: Landmark[]; landmarks: Landmark[] } | null): number {
  if (!hand) return Number.NaN;
  const w = hand.world;
  const a = w[4];
  const b = w[8];
  const c = w[5];
  const d = w[17];
  if (!a || !b || !c || !d) return Number.NaN;
  const aperture = Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
  const span = Math.hypot(c.x - d.x, c.y - d.y, c.z - d.z);
  return aperture / span;
}

export type PointerStatus = "idle" | "loading" | "running" | "error";

/**
 * The one live pointer, reachable without prop-drilling.
 *
 * There is exactly one camera and exactly one instance of this (CLAUDE.md §5 rule 4), so a
 * second consumer — the calibration screen, which has to read the same palm and the same face
 * anchor the pointer is reading, and then hand back the numbers it measured — does not need a
 * second pipeline or a React context threaded through the tree. Same pattern as `flightInput`
 * and `cursorPosition`: a plain module singleton the loops read.
 *
 * Null until the hook mounts, and again after it unmounts.
 */
let live: HandPointer | null = null;
export function activePointer(): HandPointer | null {
  return live;
}

/**
 * Camera + models + the pointer loop, as a hook. The state is handed back as a ref that the
 * loop mutates in place; React re-renders only for `present` and `status`, because a pointer
 * that re-rendered the tree sixty times a second would be its own performance problem.
 */
export function useHandPointer(enabled = true, cfg: PointerConfig = DEFAULT_POINTER) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [status, setStatus] = useState<PointerStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const [present, setPresent] = useState(false);
  // Lazily, so a re-render doesn't build (and discard) a whole pointer with its filters.
  // Created before first use, so the ref is handed out as non-null.
  const lazyRef = useRef<HandPointer | null>(null);
  if (!lazyRef.current) lazyRef.current = new HandPointer(cfg);
  const pointerRef = lazyRef as { current: HandPointer };

  useEffect(() => {
    const pointer = pointerRef.current;
    live = pointer;
    const clearLive = () => {
      if (live === pointer) live = null;
    };
    if (!enabled) {
      pointer.invalidate(performance.now(), "source-stale");
      pointer.drainEvents();
      pointer.drainDwellEvents();
      setPresent(false);
      setStatus("idle");
      setError(null);
      clearLive();
      return clearLive;
    }

    let raf = 0;
    let stopped = false;
    let stream: MediaStream | null = null;
    let stopFrameLoop: (() => void) | null = null;
    let startupTimer = 0;
    let stallTimer = 0;
    let retryTimer = 0;
    let sourceEpoch = 0;
    let engineReady = false;
    let engineLoadPromise: Promise<void> | null = null;
    let engineGeneration = 0;
    let reconnectFailures = 0;
    let pendingWhileHidden = false;
    let pendingRetryWhileHidden = false;
    let pendingReason = "camera feed interrupted";
    let healthySince = 0;
    let healthyFrames = 0;
    let hasActionableFrame = false;
    let removeVisibilityListener: (() => void) | null = null;
    let removeDeviceListener: (() => void) | null = null;
    let waitingForDeviceChange = false;
    const engine = new VisionEngine();
    const inferenceHealth = new InferenceHealthMonitor();
    const video = videoRef.current;
    if (!video) {
      clearLive();
      return;
    }
    let lastTs = 0;

    const invalidateSource = (reason: VideoFrameStaleReason, atMs = performance.now()) => {
      pointer.invalidate(atMs, reason === "video-stale" ? "source-stale" : reason);
      setPresent((presentNow) =>
        presentNow === pointer.state.present ? presentNow : pointer.state.present,
      );
    };

    const clearSourceTimers = () => {
      if (startupTimer) window.clearTimeout(startupTimer);
      if (stallTimer) window.clearTimeout(stallTimer);
      startupTimer = 0;
      stallTimer = 0;
    };

    const stopOwnedStream = (owned: MediaStream | null) => {
      if (!owned) return;
      if (video.srcObject === owned) video.srcObject = null;
      owned.getTracks().forEach((track) => track.stop());
    };

    const stopCurrentSource = () => {
      // Remove the track-ended listener before stopping the track ourselves; teardown is not a
      // new hardware failure and must not schedule another reconnect.
      stopFrameLoop?.();
      stopFrameLoop = null;
      const owned = stream;
      stream = null;
      stopOwnedStream(owned);
      healthySince = 0;
      healthyFrames = 0;
      hasActionableFrame = false;
      inferenceHealth.reset();
    };

    const withDeadline = <T,>(promise: Promise<T>, ms: number, message: string): Promise<T> =>
      new Promise<T>((resolve, reject) => {
        const timer = window.setTimeout(() => reject(new Error(message)), ms);
        promise.then(
          (value) => {
            window.clearTimeout(timer);
            resolve(value);
          },
          (cause) => {
            window.clearTimeout(timer);
            reject(cause);
          },
        );
      });

    const errorMessage = (cause: unknown): string =>
      cause instanceof Error ? cause.message : String(cause);

    const retryableCameraError = (cause: unknown): boolean => {
      if (!(cause instanceof DOMException)) return true;
      return ![
        "NotAllowedError",
        "SecurityError",
        "NotFoundError",
        "OverconstrainedError",
      ].includes(cause.name);
    };

    const terminalError = (
      message: string,
      closeEngine = true,
      recoverOnDeviceChange = false,
    ) => {
      if (stopped) return;
      sourceEpoch += 1;
      clearSourceTimers();
      if (retryTimer) window.clearTimeout(retryTimer);
      retryTimer = 0;
      pendingWhileHidden = false;
      waitingForDeviceChange = recoverOnDeviceChange;
      stopCurrentSource();
      invalidateSource("video-stale");
      if (closeEngine) {
        engineGeneration += 1;
        engine.close();
        engineReady = false;
        engineLoadPromise = null;
      }
      setError(message);
      setStatus("error");
    };

    let openSource: (initial?: boolean, countsAsRetry?: boolean) => Promise<void>;

    const scheduleReconnect = () => {
      if (stopped || retryTimer) return;
      if (document.visibilityState !== "visible") {
        pendingWhileHidden = true;
        pendingRetryWhileHidden = true;
        return;
      }
      const delay = CAMERA_RECONNECT_DELAYS_MS[reconnectFailures];
      if (delay === undefined) {
        terminalError(`${pendingReason}; automatic camera reconnect failed`, true, true);
        return;
      }
      setStatus("loading");
      setError(
        `${pendingReason}; reconnecting camera${delay > 0 ? ` in ${(delay / 1000).toFixed(1)}s` : ""}`,
      );
      retryTimer = window.setTimeout(() => {
        retryTimer = 0;
        void openSource(false, true);
      }, delay);
    };

    const requestReconnect = (epoch: number, reason: string) => {
      if (stopped || epoch !== sourceEpoch) return;
      // Retire this epoch before stopping its track, so every late frame/play promise is inert.
      sourceEpoch += 1;
      clearSourceTimers();
      stopCurrentSource();
      invalidateSource("video-stale");
      pendingReason = reason;
      if (document.visibilityState !== "visible") {
        pendingWhileHidden = true;
        pendingRetryWhileHidden = true;
        setStatus("loading");
        setError(`${reason}; camera reconnect will resume when this page is visible`);
        return;
      }
      scheduleReconnect();
    };

    const dispose = () => {
      stopped = true;
      sourceEpoch += 1;
      cancelAnimationFrame(raf);
      clearSourceTimers();
      if (retryTimer) window.clearTimeout(retryTimer);
      retryTimer = 0;
      removeVisibilityListener?.();
      removeVisibilityListener = null;
      removeDeviceListener?.();
      removeDeviceListener = null;
      stopCurrentSource();
      pointer.invalidate(performance.now(), "source-stale");
      // No consumer should replay a lifecycle-teardown edge after this same ref mounts again.
      pointer.drainEvents();
      pointer.drainDwellEvents();
      engineGeneration += 1;
      engine.close();
      if (typeof window !== "undefined") window.__handState = undefined;
      clearLive();
    };

    // A driver has installed a synthetic hand: run the whole pipeline off that instead of a
    // camera, so the interaction can be exercised exactly and repeatably. DEV only, and only
    // when something has explicitly asked for it. See `handSim`.
    if (activeSim()) {
      setStatus("running");
      const simTick = () => {
        if (stopped) return;
        raf = requestAnimationFrame(simTick);
        const sim = activeSim();
        if (!sim) return;
        const s = pointer.update(simFrame(sim), SIM_ASPECT, performance.now());
        visionLog.fps = s.fps;
        visionLog.tick(s);
        setPresent((p) => (p === s.present ? p : s.present));
      };
      if (typeof window !== "undefined") {
        window.__handState = () => ({ ...pointer.state, box: undefined, hands: undefined });
      }
      visionLog.start();
      raf = requestAnimationFrame(simTick);
      return dispose;
    }

    openSource = async (initial = false, countsAsRetry = false) => {
      if (stopped) return;
      if (document.visibilityState !== "visible") {
        pendingWhileHidden = true;
        pendingRetryWhileHidden ||= countsAsRetry;
        pendingReason = initial ? "camera startup paused" : pendingReason;
        setStatus("loading");
        return;
      }

      if (countsAsRetry) {
        if (reconnectFailures >= CAMERA_RECONNECT_DELAYS_MS.length) {
          terminalError(`${pendingReason}; automatic camera reconnect failed`);
          return;
        }
        // Count an attempt only once it actually starts. A timer postponed by a hidden page
        // consumes no recovery budget.
        reconnectFailures += 1;
      }

      clearSourceTimers();
      stopCurrentSource();
      const epoch = ++sourceEpoch;
      pendingWhileHidden = false;
      setStatus("loading");
      if (initial) setError(null);

      if (!navigator.mediaDevices?.getUserMedia) {
        terminalError(
          "camera API unavailable — open via http://localhost:5173 (or HTTPS); " +
            "insecure http://<LAN-IP> origins block the webcam",
        );
        return;
      }

      let acquired: MediaStream | null = null;
      try {
        const acquisition = navigator.mediaDevices.getUserMedia({
          video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: "user" },
          audio: false,
        });
        // getUserMedia cannot be aborted. If a timed-out/retired attempt resolves later, stop
        // only the stream it produced; never clear a newer epoch's video element.
        void acquisition.then(
          (late) => {
            if (stopped || epoch !== sourceEpoch) stopOwnedStream(late);
          },
          () => undefined,
        );
        acquired = initial
          ? await acquisition
          : await withDeadline(
              acquisition,
              CAMERA_RECONNECT_ACQUIRE_MS,
              "camera reconnect timed out while opening the device",
            );
        if (stopped || epoch !== sourceEpoch) {
          stopOwnedStream(acquired);
          return;
        }
        stream = acquired;
        video.srcObject = acquired;
        await withDeadline(
          video.play(),
          CAMERA_PLAY_TIMEOUT_MS,
          "camera opened, but video playback did not start",
        );
        if (stopped || epoch !== sourceEpoch) {
          stopOwnedStream(acquired);
          return;
        }

        if (!engineReady) {
          const loadGeneration = engineGeneration;
          try {
            engineLoadPromise ??= engine.load();
            await engineLoadPromise;
          } catch (cause) {
            if (
              stopped ||
              loadGeneration !== engineGeneration ||
              epoch !== sourceEpoch
            ) {
              stopOwnedStream(acquired);
              return;
            }
            engineLoadPromise = null;
            terminalError(`vision model failed to load: ${errorMessage(cause)}`, true);
            return;
          }
          if (stopped || loadGeneration !== engineGeneration) {
            // `load()` may finish after a StrictMode cleanup. Close the resources it just
            // created instead of leaving a GPU/WASM recogniser alive off-screen. A terminal
            // error increments the same generation, covering a late resolve after teardown.
            engine.close();
            engineReady = false;
            stopOwnedStream(acquired);
            return;
          }
          engineReady = true;
          visionLog.video = video;
          visionLog.start();
          if (epoch !== sourceEpoch) {
            // A visibility/source epoch changed while the shared model was loading. Keep the
            // loaded engine for the newer attempt, but this attempt's stream has no authority.
            stopOwnedStream(acquired);
            return;
          }
        }

        const videoTrack = acquired.getVideoTracks()[0];
        if (!videoTrack || videoTrack.readyState !== "live") {
          requestReconnect(epoch, "camera track ended before its first decoded frame");
          return;
        }
        // This may be a replacement device selected by the browser after a disconnect. Publish
        // it before the first decoded frame so App can revoke the old camera/display profile
        // before any observation from the new optics becomes actionable.
        publishCameraIdentity(cameraIdentityFromTrack(videoTrack));

        // The recorder needs the element to read the track's real settings off at the end.
        visionLog.video = video;

        let receivedFirstFrame = false;
        startupTimer = window.setTimeout(() => {
          startupTimer = 0;
          if (stopped || epoch !== sourceEpoch || receivedFirstFrame) return;
          invalidateSource("video-stale");
          requestReconnect(epoch, "camera opened, but no decoded video frame arrived");
        }, CAMERA_STARTUP_TIMEOUT_MS);

        stopFrameLoop = startDecodedFrameLoop(video, {
          onFrame: (stamp) => {
            if (
              stopped ||
              epoch !== sourceEpoch ||
              document.visibilityState !== "visible"
            ) {
              if (!stopped && epoch === sourceEpoch) {
                invalidateSource("page-hidden", performance.now());
              }
              return;
            }
            try {
              // MediaPipe rejects equal timestamps. The decoded-frame clock is monotonic in
              // browsers, but the +1 guard also covers a media-track discontinuity.
              let ts = stamp.receivedAtMs;
              if (ts <= lastTs) ts = lastTs + 1;
              lastTs = ts;

              const aspect =
                video.videoHeight > 0 ? video.videoWidth / video.videoHeight : 16 / 9;
              const inferenceStartedAtMs = performance.now();
              const res = engine.process(video, ts);
              const processedAtMs = performance.now();
              const state = pointer.update(res, aspect, {
                ...stamp,
                processedAtMs,
                inferenceMs: Math.max(0, processedAtMs - inferenceStartedAtMs),
              });
              const processing = inferenceHealth.update(state.sample.inferenceMs, processedAtMs);
              if (!receivedFirstFrame) {
                receivedFirstFrame = true;
                clearSourceTimers();
              } else if (stallTimer) {
                window.clearTimeout(stallTimer);
                stallTimer = 0;
              }
              if (processing.terminal) {
                terminalError(
                  `vision processing stayed too slow (${Math.round(state.sample.inferenceMs)} ms/frame; ` +
                    `interactive limit ${CONTROL_MAX_INFERENCE_MS} ms)`,
                  true,
                );
                return;
              }
              if (processing.overBudget) {
                // Decoded video is alive, but these observations are too old to authorize an
                // action. Do not let them restore a camera retry budget or claim RUNNING.
                healthySince = 0;
                healthyFrames = 0;
              } else {
                if (!hasActionableFrame) {
                  hasActionableFrame = true;
                  waitingForDeviceChange = false;
                  setError(null);
                  setStatus("running");
                }
                // `onStale` clears the health epoch. A resumed decoder must earn a fresh two
                // seconds of continuous evidence before it can restore the finite retry budget.
                if (healthySince === 0) {
                  healthySince = processedAtMs;
                  healthyFrames = 0;
                }
                healthyFrames += 1;
                if (
                  reconnectFailures > 0 &&
                  healthyFrames >= CAMERA_RECOVERY_STABLE_FRAMES &&
                  processedAtMs - healthySince >= CAMERA_RECOVERY_STABLE_MS
                ) {
                  reconnectFailures = 0;
                }
              }
              // Sampled HERE rather than from the interaction loop, so the log has exactly one
              // row per decoded camera frame — the denominator of every audit recall figure.
              visionLog.fps = state.fps;
              visionLog.tick(state);
              setPresent((presentNow) =>
                presentNow === state.present ? presentNow : state.present,
              );
            } catch (cause) {
              // Stop this loop: repeatedly invoking a failed GPU/WASM recogniser at camera rate
              // hides the original failure and can pin a CPU core.
              invalidateSource("video-stale", performance.now());
              terminalError(`vision processing failed: ${errorMessage(cause)}`, true);
            }
          },
          onStale: (event) => {
            if (stopped || epoch !== sourceEpoch) return;
            invalidateSource(event.reason, event.atMs);
            if (event.reason === "video-stale") {
              healthySince = 0;
              healthyFrames = 0;
            }
            if (event.reason === "track-ended") {
              requestReconnect(epoch, "camera video track ended");
            } else if (
              event.reason === "video-stale" &&
              receivedFirstFrame &&
              !stallTimer
            ) {
              // Control already failed closed above. Give a transient decoder/main-thread pause
              // room to recover before replacing the physical track.
              stallTimer = window.setTimeout(() => {
                stallTimer = 0;
                if (stopped || epoch !== sourceEpoch) return;
                requestReconnect(epoch, "camera feed stopped producing frames");
              }, CAMERA_STALL_RECONNECT_MS);
            }
          },
        });
      } catch (cause) {
        if (stopped || epoch !== sourceEpoch) {
          stopOwnedStream(acquired);
          return;
        }
        const message = errorMessage(cause);
        if (!retryableCameraError(cause)) {
          terminalError(
            message,
            true,
            cause instanceof DOMException && cause.name === "NotFoundError",
          );
        } else {
          requestReconnect(epoch, message);
        }
      }
    };

    const onDeviceChange = () => {
      if (stopped || !waitingForDeviceChange) return;
      // A terminal "no camera" state must not require a page refresh after someone reconnects
      // the webcam. A new physical identity is published before its first actionable frame,
      // which reopens calibration for that exact camera/display pair.
      waitingForDeviceChange = false;
      reconnectFailures = 0;
      pendingReason = "camera device changed";
      setStatus("loading");
      setError("camera device changed; reopening camera");
      void openSource(false, false);
    };
    navigator.mediaDevices?.addEventListener("devicechange", onDeviceChange);
    removeDeviceListener = () =>
      navigator.mediaDevices?.removeEventListener("devicechange", onDeviceChange);

    const onVisibility = () => {
      if (stopped) return;
      if (document.visibilityState !== "visible") {
        const retryWasPending = retryTimer !== 0 || pendingRetryWhileHidden;
        if (retryTimer) window.clearTimeout(retryTimer);
        retryTimer = 0;
        // Hidden pages own no gesture authority, even on browsers that keep delivering video
        // callbacks in the background. Retire the epoch now; visible resumes from a fresh source
        // and must observe canonical open posture evidence before any new press can arm.
        sourceEpoch += 1;
        clearSourceTimers();
        stopCurrentSource();
        invalidateSource("page-hidden");
        pendingWhileHidden = true;
        pendingRetryWhileHidden = retryWasPending;
        setStatus("loading");
        if (!retryWasPending) setError(null);
        return;
      }
      if (!pendingWhileHidden || retryTimer) return;
      const resumeRetry = pendingRetryWhileHidden;
      pendingWhileHidden = false;
      pendingRetryWhileHidden = false;
      if (resumeRetry) scheduleReconnect();
      else void openSource(false, false);
    };
    document.addEventListener("visibilitychange", onVisibility);
    removeVisibilityListener = () => document.removeEventListener("visibilitychange", onVisibility);

    void openSource(true);

    return dispose;
  }, [enabled]);

  return { videoRef, status, error, pointer: pointerRef, present };
}
