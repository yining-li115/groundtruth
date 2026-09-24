import type { Landmark } from "./mediapipe";
import type { SceneEndReason } from "./flightInput";
import {
  CONTROL_FRESH_MAX_MS,
  CONTROL_TRACKING_GAP_GRACE_MS,
} from "./controlFreshness";

/** Exactly one of these may own the hand at a time. */
export type InteractionKind =
  | "NONE"
  | "CALIBRATION"
  | "POINTING"
  | "UI_PRESS"
  | "UI_SCROLL"
  | "SCENE_GRAB";

export type InteractionEnvironment = "calibration" | "showreel" | "site";
export type RouterPosture = "open" | "closed" | "unknown";

export type InteractionEndReason =
  | SceneEndReason
  | "unknown-posture"
  | "moved"
  | "invalid-target";

/** The un-clamped camera measurement used only for relative scene motion. */
export interface RouterRawHand {
  frameX: number;
  frameY: number;
  palmSpan: number;
}

/** One immutable, decoded-camera observation. */
export interface RouterSample {
  seq: number;
  at: number;
  ownerId: number | null;
  /** Decoded/inference source is within its bounded latency budget. */
  sourceFresh: boolean;
  /** The reserved owner has landmarks in this result (false during a tracking blink). */
  ownerVisible: boolean;
  /** Fully actionable now: fresh source + visible owner + valid raw hand. */
  fresh: boolean;
  freshForMs: number;
  posture: RouterPosture;
  pointer: { x: number; y: number };
  live: { x: number; y: number };
  rawHand: RouterRawHand | null;
  hands: Landmark[][];
}

interface RouterEdgeBase {
  seq: number;
  at: number;
  ownerId: number;
  aim: { x: number; y: number };
  /** Live, un-frozen pointer position captured on the event's own camera frame. */
  live: { x: number; y: number };
  rawHand: RouterRawHand | null;
  freshForMs: number;
}

export interface RouterPressEdge extends RouterEdgeBase {
  type: "press";
}

export interface RouterReleaseEdge extends RouterEdgeBase {
  type: "release";
}

export interface RouterCancelEdge extends RouterEdgeBase {
  type: "cancel";
  reason: InteractionEndReason;
}

export type RouterGestureEdge = RouterPressEdge | RouterReleaseEdge | RouterCancelEdge;

/** Result of the one hit-test performed when a fist first closes. */
export interface RouterHit<TTarget, TScrollTarget> {
  /** Locked click recipient; its identity is retained and revalidated when the hand opens. */
  clickTarget: TTarget | null;
  /** Locked scroll recipient. Null is allowed to mean the document when canScroll is true. */
  scrollTarget: TScrollTarget | null;
  canScroll: boolean;
  /** Restrict drag promotion to the axes the locked surface can actually consume. */
  scrollAxis?: "x" | "y" | "both";
  /** The point belongs to the Gaussian background rather than UI laid over it. */
  scene: boolean;
}

export interface RouterContext {
  environment: InteractionEnvironment;
  sceneReady: boolean;
}

export interface RouterConfig {
  dragStart: number;
  staleMs: number;
  uiPressTimeoutMs: number;
  operationTimeoutMs: number;
  /** Preserve same-owner UI intent through a short missing/stale observation, never a release. */
  trackingGapGraceMs: number;
}

export const DEFAULT_ROUTER_CONFIG: RouterConfig = {
  dragStart: 0.025,
  staleMs: 120,
  uiPressTimeoutMs: 8_000,
  operationTimeoutMs: 30_000,
  trackingGapGraceMs: CONTROL_TRACKING_GAP_GRACE_MS,
};

export type InteractionAction<TTarget> =
  | {
      type: "click";
      sessionId: number;
      target: TTarget;
      point: { x: number; y: number };
    }
  | {
      type: "scene-begin";
      sessionId: number;
      ownerId: number;
      seq: number;
      freshAt: number;
      freshForMs: number;
      hands: Landmark[][];
    }
  | {
      type: "scene-update";
      sessionId: number;
      ownerId: number;
      seq: number;
      freshAt: number;
      freshForMs: number;
      dx: number;
      dy: number;
      vx: number;
      vy: number;
      hands: Landmark[][];
    }
  | {
      type: "scene-end";
      sessionId: number;
      ownerId: number;
      seq: number;
      freshAt: number;
      freshForMs: number;
      reason: SceneEndReason;
    };

export interface InteractionSnapshot<TTarget, TScrollTarget> {
  kind: InteractionKind;
  armed: boolean;
  sessionId: number;
  ownerId: number | null;
  startedAt: number;
  freshAt: number;
  freshForMs: number;
  clickTarget: TTarget | null;
  scrollTarget: TScrollTarget | null;
  scrollDx: number;
  scrollDy: number;
  moved: boolean;
  endReason: InteractionEndReason | null;
}

interface ActiveSession<TTarget, TScrollTarget> {
  id: number;
  kind: "UI_PRESS" | "UI_SCROLL" | "SCENE_GRAB";
  ownerId: number;
  startedAt: number;
  freshAt: number;
  freshForMs: number;
  aim: { x: number; y: number };
  liveOrigin: { x: number; y: number };
  clickTarget: TTarget | null;
  scrollTarget: TScrollTarget | null;
  canScroll: boolean;
  scrollAxis: "x" | "y" | "both";
  moved: boolean;
  rawOrigin: RouterRawHand | null;
  prevScene: { seq: number; at: number; dx: number; dy: number } | null;
}

// Module-wide rather than per component: React StrictMode may tear an effect down and mount it
// again while the scene singleton still remembers the previous id. A reused id must never make
// a late sample from that previous writer look current.
let nextGestureSessionId = 1;

/**
 * Pure gesture-session arbiter. It never touches the DOM, scroll position, camera, or React;
 * those effects are returned as commands. This makes the safety rules replayable in Node.
 */
export class InteractionRouter<TTarget = unknown, TScrollTarget = unknown> {
  private readonly cfg: RouterConfig;
  private environment: InteractionEnvironment | null = null;
  private lastSample: RouterSample | null = null;
  private lastSeq = -1;
  /** Durable camera edges are consumed once, independently of when their sample was observed. */
  private lastHandledEdgeSeq = -1;
  private lastHandledEdgeType: RouterGestureEdge["type"] | null = null;
  private lastUsableAt = 0;
  private lastUsableOwnerId: number | null = null;
  private lastUsableFreshForMs = 0;
  /** True only after the source produced a frame but the reserved owner landmarks blinked. */
  private pointingGapActive = false;
  private blockedUntilSeq = -1;
  private active: ActiveSession<TTarget, TScrollTarget> | null = null;
  private currentKind: InteractionKind = "NONE";
  private isArmed = false;
  /** A hard identity/source boundary needs positive OPEN, not merely ambiguous neutral. */
  private requireOpenToRearm = false;
  private lastEndReason: InteractionEndReason | null = null;
  private scrollDx = 0;
  private scrollDy = 0;

  constructor(config: Partial<RouterConfig> = {}) {
    this.cfg = { ...DEFAULT_ROUTER_CONFIG, ...config };
  }

  snapshot(): InteractionSnapshot<TTarget, TScrollTarget> {
    const s = this.active;
    return {
      kind: this.currentKind,
      armed: this.isArmed,
      sessionId: s?.id ?? 0,
      ownerId: s?.ownerId ?? this.lastSample?.ownerId ?? null,
      startedAt: s?.startedAt ?? 0,
      freshAt: s?.freshAt ?? this.lastSample?.at ?? 0,
      freshForMs: s?.freshForMs ?? this.lastSample?.freshForMs ?? this.cfg.staleMs,
      clickTarget: s?.clickTarget ?? null,
      scrollTarget: s?.scrollTarget ?? null,
      scrollDx: this.scrollDx,
      scrollDy: this.scrollDy,
      moved: s?.moved ?? false,
      endReason: this.lastEndReason,
    };
  }

  /** Keep the external app mode and this one owner in lockstep. */
  syncContext(context: RouterContext, now: number): InteractionAction<TTarget>[] {
    const actions: InteractionAction<TTarget>[] = [];
    const changed = this.environment !== null && context.environment !== this.environment;
    if (changed && this.active) {
      actions.push(
        ...this.cancelInternal(
          context.environment === "calibration" ? "calibration" : "mode-changed",
          now,
        ),
      );
    }
    if (this.active?.kind === "SCENE_GRAB" && !context.sceneReady) {
      actions.push(...this.cancelInternal("scene-unavailable", now));
    }

    if (this.environment === null || changed) {
      this.environment = context.environment;
      this.isArmed = false;
      if (changed) this.requireOpenToRearm = true;
      this.blockedUntilSeq = Math.max(this.blockedUntilSeq, this.lastSeq);
    }

    if (context.environment === "calibration") {
      this.currentKind = "CALIBRATION";
      this.isArmed = false;
      this.scrollDx = 0;
      this.scrollDy = 0;
    } else if (!this.active) {
      const sampleUsable =
        !!this.lastSample?.fresh &&
        now - this.lastSample.at <= this.staleFor(this.lastSample.freshForMs);
      this.currentKind = sampleUsable ? "POINTING" : "NONE";
    }
    return actions;
  }

  /** Apply one new decoded-camera sample. Duplicate display frames are ignored. */
  observe(sample: RouterSample, context: RouterContext): InteractionAction<TTarget>[] {
    const safeAt = Number.isFinite(sample.at) ? sample.at : (this.lastSample?.at ?? 0);
    const actions = this.syncContext(context, safeAt);
    if (context.environment !== "calibration" && !this.active) {
      this.expireIdle(safeAt, context);
    }
    if (!Number.isFinite(sample.seq) || sample.seq <= this.lastSeq) return actions;

    const priorOwner = this.lastSample?.ownerId ?? null;
    this.lastSeq = sample.seq;
    this.lastSample = sample;

    if (
      !Number.isFinite(sample.at) ||
      !Number.isFinite(sample.freshForMs) ||
      !finitePoint(sample.pointer) ||
      !finitePoint(sample.live) ||
      (sample.rawHand !== null && !validRawHand(sample.rawHand))
    ) {
      if (this.active) actions.push(...this.cancelInternal("stale", safeAt, sample.seq));
      this.currentKind = "NONE";
      this.isArmed = false;
      this.requireOpenToRearm = true;
      this.blockedUntilSeq = sample.seq;
      return actions;
    }

    if (context.environment === "calibration") {
      this.currentKind = "CALIBRATION";
      return actions;
    }

    if (!sample.fresh || sample.ownerId === null) {
      const sameActiveOwner =
        this.active !== null &&
        sample.ownerId !== null &&
        sample.ownerId === this.active.ownerId;
      const uiGap =
        sameActiveOwner &&
        (this.active!.kind === "UI_PRESS" || this.active!.kind === "UI_SCROLL") &&
        sample.at - this.active!.freshAt <= this.uiContinuityFor(this.active!);
      if (uiGap) {
        // Missing/stale evidence is neither movement nor release. Keep the one immutable owner
        // and transaction, but stop continuous scroll until a usable sample returns.
        this.scrollDx = 0;
        this.scrollDy = 0;
        return actions;
      }

      if (this.active) {
        actions.push(
          ...this.cancelInternal(sample.ownerId === null ? "hand-lost" : "stale", sample.at),
        );
      }

      const sameReservedOwner =
        !this.active &&
        sample.ownerId !== null &&
        sample.ownerId === this.lastUsableOwnerId &&
        sample.at - this.lastUsableAt <= this.pointingContinuityFor();
      this.currentKind = "NONE";
      this.pointingGapActive = sameReservedOwner;
      if (!sameReservedOwner) {
        this.isArmed = false;
        this.requireOpenToRearm = true;
        this.blockedUntilSeq = sample.seq;
      }
      return actions;
    }

    this.lastUsableAt = sample.at;
    this.lastUsableOwnerId = sample.ownerId;
    this.lastUsableFreshForMs = this.staleFor(sample.freshForMs);
    this.pointingGapActive = false;

    if (this.active && sample.ownerId !== this.active.ownerId) {
      actions.push(...this.cancelInternal("owner-changed", sample.at));
      this.blockedUntilSeq = sample.seq;
    } else if (!this.active && priorOwner !== null && priorOwner !== sample.ownerId) {
      this.isArmed = false;
      this.requireOpenToRearm = true;
      this.blockedUntilSeq = sample.seq;
      this.lastEndReason = "owner-changed";
    }

    // A fist relaxed into MediaPipe's ordinary `None` label passes through a bounded UNKNOWN
    // interval while HandPointer proves a wide aperture for the natural-release gate. Keep a
    // same-owner UI transaction alive through that interval so its later durable release can
    // decide click versus scroll. Scene motion still fails closed immediately, and an unknown
    // scroll posture stops velocity rather than continuing on the last displacement.
    if (this.active) {
      this.active.freshAt = sample.at;
      this.active.freshForMs = this.staleFor(sample.freshForMs);
    }
    if (sample.posture === "unknown") {
      if (this.active?.kind === "SCENE_GRAB") {
        actions.push(...this.cancelInternal("unknown-posture", sample.at));
      } else if (this.active?.kind === "UI_SCROLL") {
        this.scrollDx = 0;
        this.scrollDy = 0;
      }
      if (this.active) return actions;
      this.currentKind = "POINTING";
      // At initial acquisition, a stable MediaPipe `None` is a valid neutral pose. After a hard
      // source/identity cancellation we deliberately keep the stricter positive-open boundary.
      if (!this.requireOpenToRearm && sample.seq > this.blockedUntilSeq) this.isArmed = true;
      return actions;
    }

    if (!this.active) {
      this.currentKind = "POINTING";
      if (sample.posture === "open" && sample.seq > this.blockedUntilSeq) {
        this.isArmed = true;
        this.requireOpenToRearm = false;
      }
      return actions;
    }

    if (sample.posture !== "closed") return actions;

    if (this.active.kind === "UI_PRESS" || this.active.kind === "UI_SCROLL") {
      const dx = sample.live.x - this.active.liveOrigin.x;
      const dy = sample.live.y - this.active.liveOrigin.y;
      // Match the scroll velocity's per-axis deadzone exactly. A radial test turns a small
      // diagonal (for example 0.02/0.02) into a drag even though neither scroll axis can move,
      // creating the worst possible middle state: the press no longer clicks and the page
      // does not scroll. Crossing either live axis is the point at which scrolling can really
      // begin, so it is also the only point at which a press may be reclassified.
      const moved = dragStarted(dx, dy, this.cfg.dragStart, this.active.scrollAxis);
      if (moved) this.active.moved = true;

      if (this.active.kind === "UI_PRESS" && moved) {
        if (!this.active.canScroll) {
          actions.push(...this.cancelInternal("moved", sample.at));
          return actions;
        }
        this.active.kind = "UI_SCROLL";
        this.currentKind = "UI_SCROLL";
      }
      if (this.active.kind === "UI_SCROLL") {
        this.scrollDx = this.active.scrollAxis === "y" ? 0 : dx;
        this.scrollDy = this.active.scrollAxis === "x" ? 0 : dy;
      }
      return actions;
    }

    const origin = this.active.rawOrigin;
    const raw = sample.rawHand;
    if (!origin || !raw || !(origin.palmSpan > 0)) {
      actions.push(...this.cancelInternal("stale", sample.at));
      return actions;
    }
    const dx = (origin.frameX - raw.frameX) / origin.palmSpan;
    const dy = (origin.frameY - raw.frameY) / origin.palmSpan;
    const prev = this.active.prevScene;
    const dt = prev ? Math.max(1e-3, (sample.at - prev.at) / 1000) : 0;
    const vx = prev && dt ? (dx - prev.dx) / dt : 0;
    const vy = prev && dt ? (dy - prev.dy) / dt : 0;
    this.active.prevScene = { seq: sample.seq, at: sample.at, dx, dy };
    actions.push({
      type: "scene-update",
      sessionId: this.active.id,
      ownerId: this.active.ownerId,
      seq: sample.seq,
      freshAt: sample.at,
      freshForMs: this.active.freshForMs,
      dx,
      dy,
      vx,
      vy,
      hands: sample.hands,
    });
    return actions;
  }

  /** Consume a durable edge from HandPointer's event queue. */
  handleEdge(
    edge: RouterGestureEdge,
    context: RouterContext,
    hit?: RouterHit<TTarget, TScrollTarget>,
    targetValid = true,
    now = edge.at,
  ): InteractionAction<TTarget>[] {
    const safeAt = Number.isFinite(now)
      ? now
      : Number.isFinite(edge.at)
        ? edge.at
        : (this.lastSample?.at ?? 0);
    const activeBeforeContext = this.active !== null;
    const actions = this.syncContext(context, safeAt);
    if (context.environment === "calibration") return actions;
    if (activeBeforeContext && this.active === null) return actions;
    if (!this.active) this.expireIdle(safeAt, context);

    if (
      !Number.isFinite(edge.seq) ||
      !Number.isFinite(edge.at) ||
      !Number.isFinite(edge.freshForMs) ||
      !Number.isFinite(edge.ownerId) ||
      !finitePoint(edge.aim) ||
      !finitePoint(edge.live) ||
      (edge.rawHand !== null && !validRawHand(edge.rawHand))
    ) {
      if (this.active && edge.ownerId === this.active.ownerId) {
        actions.push(...this.cancelInternal("stale", safeAt, edge.seq));
      }
      this.isArmed = false;
      this.requireOpenToRearm = true;
      return actions;
    }

    // A source watchdog may invalidate an already-consumed press without decoding another frame,
    // so its cancel legitimately carries the same camera seq. It must override that edge, while
    // duplicate presses/releases and duplicate cancels stay one-shot.
    if (
      edge.seq < this.lastHandledEdgeSeq ||
      (edge.seq === this.lastHandledEdgeSeq &&
        (edge.type !== "cancel" || this.lastHandledEdgeType === "cancel"))
    ) {
      return actions;
    }
    if (edge.seq > this.lastHandledEdgeSeq) this.lastHandledEdgeSeq = edge.seq;
    this.lastHandledEdgeType = edge.type;

    // Camera edges are durable so a fast gesture is not lost between display frames, but they
    // are not immortal. After a suspended/backgrounded render loop, dispatching a one-second-old
    // confirmed press would manufacture a control activation from stale intent.
    if (edge.type !== "cancel" && safeAt - edge.at > this.staleFor(edge.freshForMs)) {
      if (this.active && edge.ownerId === this.active.ownerId) {
        actions.push(...this.cancelInternal("stale", safeAt, edge.seq));
      }
      this.isArmed = false;
      this.requireOpenToRearm = true;
      this.blockedUntilSeq = Math.max(this.blockedUntilSeq, edge.seq);
      return actions;
    }

    const activeBeforeWatchdog = this.active !== null;
    // A recovery edge is evidence captured at `edge.at`; display/main-thread delay after capture
    // must not consume the tracking grace twice. Its own age was bounded above, while operation
    // timeouts continue to use wall time. Foreign/cancel edges never extend another owner.
    const continuityAt =
      this.active && edge.type !== "cancel" && edge.ownerId === this.active.ownerId
        ? edge.at
        : safeAt;
    actions.push(...this.expireActive(safeAt, continuityAt));
    if (activeBeforeWatchdog && this.active === null) return actions;

    if (edge.type === "cancel") {
      if (this.active && edge.ownerId === this.active.ownerId) {
        actions.push(...this.cancelInternal(edge.reason, edge.at, edge.seq));
      } else if (!this.active) {
        // Acquisition/source cancellation also revokes a previously armed POINTING state.
        // Otherwise a stream could freeze while open and resume directly closed, inheriting
        // authority from a neutral pose that is no longer fresh.
        this.isArmed = false;
        this.requireOpenToRearm = true;
        this.blockedUntilSeq = Math.max(this.blockedUntilSeq, edge.seq);
        this.lastEndReason = edge.reason;
        this.currentKind = "NONE";
      }
      return actions;
    }
    if (edge.type === "release") {
      // A queued edge from a previous owner may arrive after a new session began. It has no
      // authority over that session; owner changes are handled from the live sample instead.
      if (this.active && edge.ownerId !== this.active.ownerId) return actions;
      if (
        !this.lastSample ||
        !this.lastSample.fresh ||
        this.lastSample.ownerId !== edge.ownerId ||
        edge.seq <= this.blockedUntilSeq ||
        edge.rawHand === null ||
        edge.at + this.staleFor(edge.freshForMs) < this.lastSample.at
      ) {
        if (this.active) {
          const reason = this.lastSample?.ownerId !== edge.ownerId ? "owner-changed" : "stale";
          actions.push(...this.cancelInternal(reason, edge.at, edge.seq));
        }
        return actions;
      }
      actions.push(...this.releaseInternal(edge, targetValid));
      return actions;
    }

    if (
      !this.isArmed ||
      this.active ||
      edge.seq <= this.blockedUntilSeq ||
      !hit ||
      !this.lastSample ||
      !this.lastSample.fresh ||
      this.lastSample.ownerId !== edge.ownerId ||
      edge.at + this.staleFor(edge.freshForMs) < this.lastSample.at
    ) {
      return actions;
    }

    this.isArmed = false;
    const sessionId = nextGestureSessionId++;
    const common = {
      id: sessionId,
      ownerId: edge.ownerId,
      startedAt: edge.at,
      freshAt: edge.at,
      freshForMs: this.staleFor(edge.freshForMs),
      aim: edge.aim,
      liveOrigin: edge.live,
      clickTarget: hit.clickTarget,
      scrollTarget: hit.scrollTarget,
      canScroll: hit.canScroll,
      scrollAxis: hit.scrollAxis ?? "both",
      moved: false,
      rawOrigin: edge.rawHand,
      prevScene: null,
    };

    // Closing starts one pending UI transaction; opening decides whether it was a click.
    // Movement across the drag threshold permanently turns the same transaction into scroll.
    // This is the direct-manipulation grammar used by the kiosk from the start:
    //
    //   close + open without moving -> click the locked control
    //   close + move                 -> scroll, and opening never clicks
    //
    // A distant webcam often reports the relaxed hand as `None`, so HandPointer supplies a
    // separately gated natural-release edge. Loss, staleness and owner changes remain cancel
    // edges and can therefore never complete a pending click.
    if (hit.clickTarget !== null && !targetValid) {
      this.currentKind = "POINTING";
      this.lastEndReason = "invalid-target";
      this.blockedUntilSeq = Math.max(this.blockedUntilSeq, edge.seq);
      return actions;
    }

    if (hit.clickTarget !== null || hit.canScroll) {
      this.active = { ...common, kind: "UI_PRESS" };
      this.currentKind = "UI_PRESS";
      this.lastEndReason = null;
      return actions;
    }

    if (
      context.environment === "showreel" &&
      context.sceneReady &&
      hit.scene &&
      edge.rawHand &&
      edge.rawHand.palmSpan > 0
    ) {
      this.active = { ...common, kind: "SCENE_GRAB" };
      this.currentKind = "SCENE_GRAB";
      this.lastEndReason = null;
      actions.push({
        type: "scene-begin",
        sessionId,
        ownerId: edge.ownerId,
        seq: edge.seq,
        freshAt: edge.at,
        freshForMs: this.active.freshForMs,
        hands: this.lastSample.hands,
      });
      return actions;
    }

    // A closed hand over inert content has no recipient. Do not reinterpret it until it opens.
    this.currentKind = "POINTING";
    this.blockedUntilSeq = Math.max(this.blockedUntilSeq, edge.seq);
    return actions;
  }

  /** Watchdogs run from the display loop as well as camera frames. */
  tick(now: number, context: RouterContext): InteractionAction<TTarget>[] {
    const actions = this.syncContext(context, now);
    const s = this.active;
    if (!s) {
      this.expireIdle(now, context);
      return actions;
    }
    actions.push(...this.expireActive(now));
    return actions;
  }

  /** Cancel on component teardown before the mutable scene singleton outlives its writer. */
  dispose(now: number): InteractionAction<TTarget>[] {
    return this.active ? this.cancelInternal("unmount", now) : [];
  }

  private releaseInternal(
    edge: RouterReleaseEdge,
    targetValid: boolean,
  ): InteractionAction<TTarget>[] {
    const s = this.active;
    if (!s || edge.ownerId !== s.ownerId) {
      if (
        this.lastSample?.ownerId === edge.ownerId &&
        edge.seq >= this.lastSeq &&
        edge.seq > this.blockedUntilSeq &&
        this.lastSample.fresh &&
        edge.rawHand !== null
      ) {
        this.isArmed = true;
        this.requireOpenToRearm = false;
        this.blockedUntilSeq = Math.max(this.blockedUntilSeq, edge.seq);
      }
      return [];
    }

    const actions: InteractionAction<TTarget>[] = [];
    // The camera may deliver a complete press→move→release between two display frames. The
    // durable release edge carries its own live position so that skipped intermediate samples
    // cannot turn a fast scroll/cancel motion into a tap.
    const movedAtRelease = dragStarted(
      edge.live.x - s.liveOrigin.x,
      edge.live.y - s.liveOrigin.y,
      this.cfg.dragStart,
      s.scrollAxis,
    );
    if (movedAtRelease) s.moved = true;
    const invalidClickTarget =
      s.kind === "UI_PRESS" && !s.moved && s.clickTarget !== null && !targetValid;
    if (s.kind === "UI_PRESS" && !s.moved && s.clickTarget !== null && targetValid) {
      actions.push({
        type: "click",
        sessionId: s.id,
        target: s.clickTarget,
        point: s.aim,
      });
    } else if (s.kind === "SCENE_GRAB") {
      actions.push({
        type: "scene-end",
        sessionId: s.id,
        ownerId: s.ownerId,
        seq: edge.seq,
        freshAt: edge.at,
        freshForMs: s.freshForMs,
        reason: "released",
      });
    }

    this.lastEndReason = s.moved
      ? "moved"
      : invalidClickTarget
        ? "invalid-target"
        : "released";
    this.clearSession();
    this.currentKind = "POINTING";
    this.isArmed = true; // a release is positive, same-owner OPEN evidence
    this.requireOpenToRearm = false;
    this.blockedUntilSeq = Math.max(this.blockedUntilSeq, edge.seq);
    return actions;
  }

  private cancelInternal(
    reason: InteractionEndReason,
    at: number,
    seq = this.lastSample?.seq ?? this.lastSeq,
  ): InteractionAction<TTarget>[] {
    const s = this.active;
    if (!s) return [];
    const actions: InteractionAction<TTarget>[] = [];
    if (s.kind === "SCENE_GRAB") {
      actions.push({
        type: "scene-end",
        sessionId: s.id,
        ownerId: s.ownerId,
        seq,
        freshAt: at,
        freshForMs: s.freshForMs,
        reason: sceneReason(reason),
      });
    }
    this.lastEndReason = reason;
    this.clearSession();
    this.currentKind = this.environment === "calibration" ? "CALIBRATION" : "POINTING";
    this.isArmed = false;
    this.requireOpenToRearm = true;
    this.blockedUntilSeq = Math.max(this.blockedUntilSeq, seq);
    return actions;
  }

  private clearSession(): void {
    this.active = null;
    this.scrollDx = 0;
    this.scrollDy = 0;
  }

  private staleFor(measuredMs: number): number {
    const measured = Number.isFinite(measuredMs) ? measuredMs : this.cfg.staleMs;
    return Math.min(CONTROL_FRESH_MAX_MS, Math.max(this.cfg.staleMs, measured));
  }

  private uiContinuityFor(session: ActiveSession<TTarget, TScrollTarget>): number {
    // Freshness is measured from camera capture; this grace starts only after that live lease.
    // Adding rather than maxing is essential when inference itself consumed most of the lease.
    return session.freshForMs + this.cfg.trackingGapGraceMs;
  }

  private pointingContinuityFor(): number {
    return Math.max(this.lastUsableFreshForMs || this.cfg.staleMs, this.cfg.trackingGapGraceMs);
  }

  private expireIdle(now: number, context: RouterContext): void {
    if (
      this.active ||
      this.lastUsableAt <= 0 ||
      now - this.lastUsableAt <=
        (this.pointingGapActive
          ? this.pointingContinuityFor()
          : this.lastUsableFreshForMs || this.cfg.staleMs)
    ) {
      return;
    }
    this.isArmed = false;
    this.requireOpenToRearm = true;
    this.blockedUntilSeq = Math.max(
      this.blockedUntilSeq,
      this.lastSample?.seq ?? this.lastSeq,
    );
    if (context.environment !== "calibration") this.currentKind = "NONE";
  }

  private expireActive(
    now: number,
    continuityAt = now,
  ): InteractionAction<TTarget>[] {
    const session = this.active;
    if (!session) return [];
    // Grace preserves ownership, not continuous effects. Once the ordinary live lease expires,
    // a decoder stall must stop page motion immediately while keeping the grab recoverable.
    if (session.kind === "UI_SCROLL" && now - session.freshAt > session.freshForMs) {
      this.scrollDx = 0;
      this.scrollDy = 0;
    }
    const continuityMs =
      session.kind === "UI_PRESS" || session.kind === "UI_SCROLL"
        ? this.uiContinuityFor(session)
        : session.freshForMs;
    if (continuityAt - session.freshAt > continuityMs) {
      return this.cancelInternal("stale", now);
    }
    const limit =
      session.kind === "UI_PRESS" ? this.cfg.uiPressTimeoutMs : this.cfg.operationTimeoutMs;
    return now - session.startedAt > limit ? this.cancelInternal("timeout", now) : [];
  }
}

function sceneReason(reason: InteractionEndReason): SceneEndReason {
  if (reason === "unknown-posture" || reason === "moved" || reason === "invalid-target") {
    return "cancelled";
  }
  return reason;
}

function finitePoint(point: { x: number; y: number }): boolean {
  return Number.isFinite(point.x) && Number.isFinite(point.y);
}

function dragStarted(
  dx: number,
  dy: number,
  threshold: number,
  axis: "x" | "y" | "both" = "both",
): boolean {
  if (axis === "x") return Math.abs(dx) > threshold;
  if (axis === "y") return Math.abs(dy) > threshold;
  return Math.abs(dx) > threshold || Math.abs(dy) > threshold;
}

function validRawHand(hand: RouterRawHand): boolean {
  return (
    Number.isFinite(hand.frameX) &&
    Number.isFinite(hand.frameY) &&
    Number.isFinite(hand.palmSpan) &&
    hand.palmSpan > 0
  );
}
