/**
 * The failure taxonomy, and the one place the whole input chain reports into.
 *
 * WHY THIS EXISTS. Every way the touchless click fails produces the same thing on the wall:
 * nothing happens. A hand the camera never found, a pinch two hundredths of a ratio short, a
 * pinch held fifty milliseconds under the debounce, a release that arrived because the arm
 * dropped out of shot, a hand that drifted far enough to be re-read as a scroll, a click that
 * landed cleanly on a div with no handler — six unrelated faults in six different files, one
 * indistinguishable symptom. Tuning against that symptom is guessing, which is what this audit
 * is meant to stop.
 *
 * So each stage says out loud why it did not produce a click, in a fixed vocabulary, and the
 * reason is stamped with the layer it came from. The layers matter as much as the reasons:
 * a pinch can fail at ACQUISITION (no hand), at RECOGNITION (hand seen, posture not read) or
 * at INTERACTION (posture read, click not delivered), and the fix for each is a different
 * kind of thing — optics, a feature or a threshold, and UI respectively.
 *
 * Nothing here runs unless `?visionDebug=1` or `?visionLog=1` is on the URL. Production keeps
 * exactly the behaviour it had.
 */

const PARAMS = typeof window === "undefined" ? null : new URLSearchParams(location.search);

/** `?visionDebug=1` — the on-screen HUD. */
export const VISION_DEBUG = PARAMS?.get("visionDebug") === "1";
/** `?visionLog=1` (implied by a guided run) — record frames for offline analysis. */
export const VISION_LOG = PARAMS?.get("visionLog") === "1" || !!PARAMS?.get("run");
/** Either one: collect the trace at all. Off by default, so production is untouched. */
export const VISION_TRACE = VISION_DEBUG || VISION_LOG;

/**
 * Why no click came out, in the vocabulary the report is written in.
 *
 * The comment on each is the EXACT code site that decides it — a taxonomy nobody can point at
 * in the source is a taxonomy that drifts away from what the program does.
 */
export type RejectReason =
  /** ACQUISITION — no landmarks in this frame at all. `handPointer.update`, `res.hands[0]` null. */
  | "HAND_NOT_FOUND"
  /** ACQUISITION — a hand, but no scale to map it with: no face AND no usable palm width.
   *  `calibration.interactionBox` and `fallbackBox` both returned null. */
  | "NO_INTERACTION_BOX"
  /** ACQUISITION — the hand is present but spans too few sensor pixels for finger geometry to
   *  mean anything. `calibration.confidence` → "too-far" / "hand-too-small". OPTICS, not code. */
  | "HAND_TOO_SMALL"
  /** RECOGNITION — inside the settle lockout after a tracking gap, so no new pinch may latch
   *  however closed the fingers are. `PinchDetector.settleMs` (265ms of decoded-sample time). */
  | "LANDMARK_UNSTABLE"
  /** RECOGNITION — fingers read as more open than PINCH_ON. The single most common one, and
   *  the one the feature audit is about. `PinchDetector.update`, `ratio < this.onAt` false. */
  | "PINCH_SCORE_ABOVE_THRESHOLD"
  /** RECOGNITION — the posture latched but opened again before PRESS_DEBOUNCE_MS (350ms), so
   *  the rest of the system never heard about it. `handPointer.update`, `s.pressProgress`. */
  | "PINCH_TOO_SHORT"
  /** RECOGNITION — held past MAX_HOLD_MS (3s) and force-released as a mis-read.
   *  `handPointer.update`, `this.suppressed = true`. */
  | "PINCH_HELD_TOO_LONG"
  /** RECOGNITION — a held continuous gesture ended because the HAND VANISHED, not because it
   *  opened. It must cancel scroll/scene motion, never count as release. */
  | "PINCH_RELEASE_NOT_FOUND"
  /** INTERACTION — the hand travelled past DRAG_START while held, so the gesture was re-read
   *  as a scroll. `HandControl`, `moved > DRAG_START`. Not fatal on its own — see below. */
  | "RECLASSIFIED_AS_DRAG"
  /** INTERACTION — ...and that re-reading actually ate the click, because there was something
   *  scrollable under it. `HandControl`, `dragging && canScroll` at release. */
  | "POINTER_MOTION_SUPPRESSED_CLICK"
  /** INTERACTION — `document.elementFromPoint` found nothing at the aim. */
  | "NO_CLICK_TARGET"
  /** INTERACTION — a click WAS dispatched, onto an element with no interactive ancestor. The
   *  event went nowhere; from the visitor's side identical to not being seen. */
  | "CLICK_ON_INERT_TARGET"
  /** INTERACTION — a click was suppressed for any other reason. Catch-all, should stay rare. */
  | "CLICK_SUPPRESSED";

export type Layer = "acquisition" | "recognition" | "interaction";

/** Which layer owns each reason — the Phase-5 separation, as data rather than as prose. */
export const REJECT_LAYER: Record<RejectReason, Layer> = {
  HAND_NOT_FOUND: "acquisition",
  NO_INTERACTION_BOX: "acquisition",
  HAND_TOO_SMALL: "acquisition",
  LANDMARK_UNSTABLE: "recognition",
  PINCH_SCORE_ABOVE_THRESHOLD: "recognition",
  PINCH_TOO_SHORT: "recognition",
  PINCH_HELD_TOO_LONG: "recognition",
  PINCH_RELEASE_NOT_FOUND: "recognition",
  RECLASSIFIED_AS_DRAG: "interaction",
  POINTER_MOTION_SUPPRESSED_CLICK: "interaction",
  NO_CLICK_TARGET: "interaction",
  CLICK_ON_INERT_TARGET: "interaction",
  CLICK_SUPPRESSED: "interaction",
};

/** What the gesture state machine is doing, named so a HUD line reads like the code. */
export type GesturePhase =
  /** open hand, nothing pending */
  | "IDLE"
  /** the fingers are closing but the raw detector has not latched */
  | "CLOSING"
  /** raw posture latched, serving the 350ms press debounce */
  | "ARMING"
  /** the press is live — this is what the interaction layer sees as `pinched` */
  | "HELD"
  /** ...and the hand has moved far enough that it is a drag, not a tap */
  | "DRAGGING"
  /** force-released (MAX_HOLD) and waiting for the hand to genuinely open */
  | "SUPPRESSED";

export interface RejectRecord {
  reason: RejectReason;
  layer: Layer;
  /** performance.now() */
  at: number;
  /** free-form: the number that decided it */
  detail: string;
}

/**
 * Interaction-layer facts, which live in `HandControl`'s loop rather than in the pointer, and
 * which the HUD and the recorder both need. Mutated in place; never read by production code.
 */
export interface InteractionTrace {
  /** the last thing that actually happened, for the HUD's "last action" line */
  lastAction: string;
  lastActionAt: number;
  /** the last refusal, whatever layer it came from */
  lastReject: RejectRecord | null;
  /** a short ring of them, so a HUD can show the pattern rather than one frame's worth */
  recent: RejectRecord[];
  /** how far the hand has travelled since the press landed, in screen fractions */
  dragPx: number;
  dragFrac: number;
  /** whether anything under the grab could have scrolled — decides if a drag eats the click */
  canScroll: boolean;
  /** what the cursor is over, as a readable selector */
  hover: string;
  /** ...and whether it is something a click would reach */
  hoverInteractive: boolean;
  /** how long the current click posture has been held, ms */
  gestureMs: number;
  /** cursor speed in screen fractions per second */
  velocity: number;
  /** running totals, for the layer-by-layer recall figures */
  counts: {
    clicks: number;
    drags: number;
    dwellClicks: number;
  };
}

export const interactionTrace: InteractionTrace = {
  lastAction: "—",
  lastActionAt: 0,
  lastReject: null,
  recent: [],
  dragPx: 0,
  dragFrac: 0,
  canScroll: false,
  hover: "—",
  hoverInteractive: false,
  gestureMs: 0,
  velocity: 0,
  counts: { clicks: 0, drags: 0, dwellClicks: 0 },
};

const RING = 24;

/** Record a refusal. No-op unless the audit is switched on. */
export function noteReject(reason: RejectReason, detail = "", at = now()): void {
  if (!VISION_TRACE) return;
  const rec: RejectRecord = { reason, layer: REJECT_LAYER[reason], at, detail };
  interactionTrace.lastReject = rec;
  interactionTrace.recent.push(rec);
  if (interactionTrace.recent.length > RING) interactionTrace.recent.shift();
  listeners.forEach((f) => f(rec));
}

/** Record something that DID happen — the other half of a rejection. */
export function noteAction(action: string, at = now()): void {
  if (!VISION_TRACE) return;
  interactionTrace.lastAction = action;
  interactionTrace.lastActionAt = at;
}

type RejectListener = (r: RejectRecord) => void;
const listeners = new Set<RejectListener>();

/** The recorder subscribes here so a rejection lands in the log on the frame it happened. */
export function onReject(fn: RejectListener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function now(): number {
  return typeof performance === "undefined" ? 0 : performance.now();
}

/** A short, readable description of a DOM element — for "what was the cursor over". */
export function describeElement(el: Element | null): string {
  if (!el) return "—";
  const tag = el.tagName.toLowerCase();
  const id = el.id ? `#${el.id}` : "";
  const cls = typeof el.className === "string" && el.className
    ? `.${el.className.trim().split(/\s+/).slice(0, 2).join(".")}`
    : "";
  const text = (el.textContent ?? "").trim().slice(0, 24);
  return `${tag}${id}${cls}${text ? ` "${text}"` : ""}`;
}
