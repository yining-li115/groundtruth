import { useEffect, useRef, useState } from "react";
import { VisionEngine, type Landmark, type VisionResult } from "./mediapipe";
import {
  DEFAULT_BOX,
  FaceAnchor,
  PINCH_OFF,
  PINCH_ON,
  PinchDetector,
  confidence,
  fallbackBox,
  interactionBox,
  mapToBox,
  palmCenter,
  palmWidthNorm,
  type BoxConfig,
  type Confidence,
  type InteractionBox,
} from "./calibration";
import { DEFAULT_ONE_EURO, OneEuroPoint, type OneEuroConfig } from "./oneEuro";
import { SIM_ASPECT, activeSim, simFrame } from "./handSim";

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
 * THE CURSOR FREEZES AS A CLICK LANDS. Even from the palm, a pinch disturbs the whole hand
 * enough to move the cursor a few pixels while the press registers — the failure Vogel &
 * Balakrishnan built ThumbTrigger to avoid on large displays. The position is held for a
 * moment after the press so the click lands where it was aimed, then released so that
 * pinch-and-drag still works.
 */

export interface PointerConfig {
  oneEuro: OneEuroConfig;
  box: BoxConfig;
  /** pinch trigger points, as aperture/palm ratios — fitted to recorded data, see calibration.ts */
  pinchOn: number;
  pinchOff: number;
  /** how long the cursor is pinned at the press position, in ms */
  pressFreezeMs: number;
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
  clickGesture: "pinch" | "fist" | "either";
  /** a hand must persist this long to count as a visitor (anti-flicker) */
  enterMs: number;
  /** ...and be gone this long before the cursor does */
  leaveMs: number;
}

export const DEFAULT_POINTER: PointerConfig = {
  oneEuro: { ...DEFAULT_ONE_EURO },
  box: { ...DEFAULT_BOX },
  pinchOn: PINCH_ON,
  pinchOff: PINCH_OFF,
  pressFreezeMs: 180,
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
  clickGesture: "either",
  enterMs: 250,
  leaveMs: 1200,
};

/** Live pointer state. Mutated in place so a render loop can read it without re-rendering. */
export interface PointerState {
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
   * A tap fires on release, so this is the difference between "they let go" and "they walked
   * away" — and without it, lowering an arm leaves a click behind on whatever the cursor was
   * last over.
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
  /** true for exactly one frame when dwell fires */
  dwellFired: boolean;
  /** whether the geometry is good enough to be believed, and why not */
  conf: Confidence;
  /** the auto-calibrated box, for overlays */
  box: InteractionBox | null;
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
}

function blankState(): PointerState {
  return {
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
    faceHeld: false,
    hands: [],
    ratio: Number.NaN,
    fps: 0,
  };
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
  private readonly fist = new FistLatch();
  private readonly face = new FaceAnchor();
  private seenSince = 0;
  private goneSince = 0;
  private freezeUntil = 0;
  private frozen = { x: 0.5, y: 0.5 };
  /** recent smoothed positions, so a press can reach back past its own gesture */
  private history: Array<{ t: number; x: number; y: number }> = [];
  private frames = 0;
  private fpsAt = 0;
  /** when the cursor last stopped travelling — the earliest a press may take its aim from */
  private settledAt = 0;
  private dwellAnchor: { x: number; y: number } | null = null;
  private dwellSince = 0;
  /** dwell must leave the radius before it may fire again — otherwise it repeats forever */
  private dwellArmed = true;
  private dwellFiredAt = -Infinity;
  /** when the current raw click posture began — for the press debounce */
  private rawSince = 0;
  /** a click was force-released; ignore the posture until it ends */
  private suppressed = false;

  constructor(cfg: PointerConfig = DEFAULT_POINTER) {
    this.cfg = { ...cfg, oneEuro: { ...cfg.oneEuro }, box: { ...cfg.box } };
    this.smooth = new OneEuroPoint(this.cfg.oneEuro);
    this.pinch = new PinchDetector(this.cfg.pinchOn, this.cfg.pinchOff);
  }

  /** Live-tunable so a slider changes the feel without restarting the camera. */
  configure(cfg: Partial<PointerConfig>): void {
    this.cfg = { ...this.cfg, ...cfg };
    if (cfg.oneEuro) this.smooth.configure(cfg.oneEuro);
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

  update(res: VisionResult, aspect: number, now: number): PointerState {
    const s = this.state;
    s.pressed = false;
    s.released = false;
    s.releasedByLoss = false;
    s.dwellFired = false;

    this.frames += 1;
    if (!this.fpsAt) this.fpsAt = now;
    else if (now - this.fpsAt > 500) {
      s.fps = (this.frames / (now - this.fpsAt)) * 1000;
      this.frames = 0;
      this.fpsAt = now;
    }

    const hand = res.hands[0] ?? null;
    // Steadied anchor, not the raw detection: it stops the mapping shivering under a still
    // hand, and it survives the hand passing in front of the face — which happens constantly.
    const face = this.face.update(res.face, now);
    const palm = palmCenter(hand?.landmarks);
    const palmNorm = palmWidthNorm(hand?.landmarks);
    // The face is the ruler, but never the gate. When it cannot be found at all, the hand
    // measures itself and the mapping degrades instead of the pointer switching off.
    const box =
      interactionBox(face, aspect, this.cfg.box) ?? fallbackBox(palmNorm, aspect, this.cfg.box);
    const ratio = handRatio(hand);

    s.box = box;
    s.faceHeld = this.face.held;
    s.hands = res.hands.map((h) => h.landmarks);
    s.ratio = ratio;
    s.conf = confidence(face, box, hand ? palmNorm * 1280 : Number.NaN);

    // --- presence, with hysteresis on both edges so a dropped frame is not an exit ---
    if (hand && palm && box) {
      this.goneSince = 0;
      if (!this.seenSince) this.seenSince = now;
      if (!s.present && now - this.seenSince > this.cfg.enterMs) s.present = true;
    } else {
      this.seenSince = 0;
      if (!this.goneSince) this.goneSince = now;
      if (s.present && now - this.goneSince > this.cfg.leaveMs) {
        s.present = false;
        // Forget the filter history, or the next visitor's cursor glides in from where the
        // last one left it — which reads as the screen being haunted rather than responsive.
        this.smooth.reset();
        this.dwellAnchor = null;
        s.dwell = 0;
      }
    }

    // --- the click, before the position: a press must be able to freeze where it was aimed ---
    const wasPinched = s.pinched;
    const g = this.cfg.clickGesture;
    const pinching = g !== "fist" && this.pinch.update(ratio);
    const fisting =
      g !== "pinch" && this.fist.update(hand?.label ?? null, hand?.score ?? 0);
    // Keep the pinch calibrator fed even when it isn't driving, so its open reference stays
    // converged and switching gesture mid-session doesn't start from a stale baseline.
    if (g === "fist") this.pinch.update(ratio);

    // Debounced: a posture has to survive PRESS_DEBOUNCE_MS before the rest of the system
    // hears about it at all. See the constant for what happened without this.
    const rawHeld = pinching || fisting;
    if (!rawHeld) {
      this.rawSince = 0;
      this.suppressed = false; // the posture ended; a new one may start
    } else if (!this.rawSince) this.rawSince = now;
    s.pinched = !this.suppressed && rawHeld && now - this.rawSince >= PRESS_DEBOUNCE_MS;
    s.pressProgress =
      this.suppressed || !rawHeld || s.pinched
        ? 0
        : Math.min(1, (now - this.rawSince) / PRESS_DEBOUNCE_MS);

    // Held impossibly long? Then it was never a click — let go, whatever the sensor thinks.
    // With fixed thresholds a permanent stick should be impossible, but a click that cannot
    // be released is the one failure that disables everything else, so it keeps a backstop.
    if (s.pinched && now - this.rawSince > MAX_HOLD_MS) {
      // Only the suppression flag — deliberately NOT resetting the detectors. Resetting them
      // makes the posture read as absent for a few frames, which clears the very flag that is
      // meant to hold the release, and the click latches straight back on. The flag alone
      // keeps it down until the hand genuinely opens.
      this.suppressed = true;
      s.pinched = false;
    }
    s.pressVia = s.pinched ? (pinching ? "pinch" : "fist") : null;
    if (s.pinched && !wasPinched) {
      s.pressed = true;
      // Never reach back past the moment the hand settled. The lookback exists to undo the
      // drift a pinch causes, but applied blindly it also reaches into the travel that brought
      // the cursor here — so pinching the instant you arrive delivered the click to where you
      // came FROM. Measured: pinching immediately did nothing; waiting 200ms worked.
      this.frozen = this.positionAt(
        Math.max(now - this.cfg.pressLookbackMs, this.settledAt),
      );
      this.freezeUntil = now + this.cfg.pressFreezeMs;
      // A deliberate click ends any dwell in progress — otherwise a slow, careful pinch fires
      // both, and the visitor gets two actions for one intention.
      this.dwellAnchor = null;
      s.dwell = 0;
      this.dwellArmed = false;
    } else if (!s.pinched && wasPinched) {
      s.released = true;
      // No hand this frame means the fingers never opened — the tracking simply stopped.
      s.releasedByLoss = !hand;
    }

    // --- position ---
    if (palm && box) {
      const m = mapToBox(box, palm);
      const f = this.smooth.filter(m.u, m.v, now);
      // History holds the LIVE filtered position, never the frozen output — otherwise a press
      // writes its own frozen value back into the record it will read from next time.
      this.history.push({ t: now, x: f.x, y: f.y });
      const cutoff = now - HISTORY_MS;
      while (this.history.length > 1 && (this.history[0]?.t ?? 0) < cutoff) this.history.shift();

      // Travelling fast means the visitor is still moving toward something; the moment that
      // stops is the moment their aim exists.
      const moved = Math.hypot(f.x - s.liveX, f.y - s.liveY);
      if (moved > 0.004) this.settledAt = now;
      s.liveX = f.x;
      s.liveY = f.y;
      if (now < this.freezeUntil) {
        s.x = this.frozen.x;
        s.y = this.frozen.y;
      } else {
        s.x = f.x;
        s.y = f.y;
      }
    }

    // --- dwell: the fallback for when a pinch will not read ---
    if (this.cfg.dwellMs > 0 && s.present && !s.pinched) {
      const a = this.dwellAnchor;
      // Re-arming asks for a bigger movement than merely leaving the hold radius, and waits
      // out a refractory period. Without both, a hand held perfectly still fires twice: the
      // smoothing keeps creeping toward its final value long after the dwell completes, and
      // that creep alone was enough to drift past the hold radius, re-arm, and fire again —
      // an unrequested double click on whatever the visitor had just selected.
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
        }
      } else {
        s.dwell = 0;
      }
    } else {
      s.dwell = 0;
    }

    return s;
  }
}

/** How much recent position history to keep, in ms. Only has to outlast `pressLookbackMs`. */
const HISTORY_MS = 600;
/** Re-arming dwell needs a real move, not the smoothing's settling creep. */
const REARM_FACTOR = 2.5;
/** ...and no dwell may follow another this soon, whatever the cursor did. */
const DWELL_REFRACTORY_MS = 700;
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
 */
export const PRESS_DEBOUNCE_MS = 350;
/**
 * The longest a click posture can be held before it is treated as a mistake rather than an
 * intention.
 *
 * Nobody pinches for three seconds to press a button. If the system still thinks they are,
 * the reference it is judging against is wrong — so it lets go and rebuilds that reference
 * from whatever the hand is doing now. Without this the mis-read is permanent: a stuck click
 * cannot be cleared by opening the hand, because opening the hand is what it is already
 * failing to recognise.
 */
const MAX_HOLD_MS = 3000;

/**
 * Fist detection, off MediaPipe's own gesture classifier.
 *
 * Deliberately not geometry: "are the fingers curled" reconstructed from landmark positions
 * fails in exactly the situations a trained classifier handles — a hand seen edge-on, at an
 * angle, or partly self-occluded. The label already comes back with every frame; using it
 * costs nothing.
 *
 * Frame counts rather than a score threshold do the hysteresis, because the classifier's
 * confidence flickers frame to frame even when the posture is unambiguous to a human.
 */
class FistLatch {
  private on = false;
  private closed = 0;
  private opened = 0;
  count = 0;

  constructor(
    private readonly onFrames = 2,
    private readonly offFrames = 3,
    private readonly minScore = 0.5,
  ) {}

  update(label: string | null, score: number): boolean {
    const isFist = label === "Closed_Fist" && score >= this.minScore;
    if (isFist) {
      this.closed += 1;
      this.opened = 0;
    } else {
      this.opened += 1;
      this.closed = 0;
    }
    if (!this.on && this.closed >= this.onFrames) {
      this.on = true;
      this.count += 1;
    } else if (this.on && this.opened >= this.offFrames) {
      this.on = false;
    }
    return this.on;
  }

  reset(): void {
    this.on = false;
    this.closed = 0;
    this.opened = 0;
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
    if (!enabled) return;
    let raf = 0;
    let stopped = false;
    let stream: MediaStream | null = null;
    const engine = new VisionEngine();
    const video = videoRef.current;
    if (!video) return;
    const pointer = pointerRef.current;
    let lastTs = 0;

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
        setPresent((p) => (p === s.present ? p : s.present));
      };
      if (typeof window !== "undefined") {
        window.__handState = () => ({ ...pointer.state, box: undefined, hands: undefined });
      }
      raf = requestAnimationFrame(simTick);
      return () => {
        stopped = true;
        cancelAnimationFrame(raf);
      };
    }

    (async () => {
      try {
        setStatus("loading");
        if (!navigator.mediaDevices?.getUserMedia) {
          throw new Error(
            "camera API unavailable — open via http://localhost:5173 (or HTTPS); " +
              "insecure http://<LAN-IP> origins block the webcam",
          );
        }
        stream = await navigator.mediaDevices.getUserMedia({
          video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: "user" },
          audio: false,
        });
        if (stopped) return;
        video.srcObject = stream;
        await video.play();
        await engine.load();
        if (stopped) return;
        setStatus("running");

        const tick = () => {
          if (stopped) return;
          raf = requestAnimationFrame(tick);
          if (video.readyState < 2) return;
          let ts = performance.now();
          if (ts <= lastTs) ts = lastTs + 1; // MediaPipe needs strictly increasing stamps
          lastTs = ts;

          const aspect = video.videoHeight > 0 ? video.videoWidth / video.videoHeight : 16 / 9;
          const res = engine.process(video, ts);
          const s = pointer.update(res, aspect, performance.now());
          setPresent((p) => (p === s.present ? p : s.present));
        };
        raf = requestAnimationFrame(tick);
      } catch (e) {
        if (stopped) return;
        setError(e instanceof Error ? e.message : String(e));
        setStatus("error");
      }
    })();

    return () => {
      stopped = true;
      cancelAnimationFrame(raf);
      engine.close();
      stream?.getTracks().forEach((t) => t.stop());
      if (video) video.srcObject = null;
    };
  }, [enabled]);

  return { videoRef, status, error, pointer: pointerRef, present };
}
