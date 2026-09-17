import { useEffect, useRef } from "react";
import { hasFreshOwner, useHandPointer } from "../lib/vision/handPointer";
import {
  beginSceneGrab,
  cancelSceneGrab,
  endSceneGrab,
  flightInput,
  sceneExploreAxes,
  setSceneMode,
  updateSceneGrab,
} from "../lib/vision/flightInput";
import {
  InteractionRouter,
  type InteractionAction,
  type InteractionEndReason,
  type RouterContext,
  type RouterGestureEdge,
  type RouterHit,
} from "../lib/vision/interactionRouter";
import { setCursorPosition } from "../lib/cursorPosition";
import { dragScrollVelocity, scrollableAt, scrollTarget } from "../lib/scroll";
import { RUNTIME_CLICK_GESTURE } from "../lib/vision/gestureRuntime";
import { activeProfile, applyProfile } from "../lib/vision/profileStore";
import { useKioskStore } from "../state/store";
import {
  VISION_TRACE,
  describeElement,
  interactionTrace,
  noteAction,
  noteReject,
} from "../lib/vision/trace";
import { visionLog } from "../lib/vision/visionLog";
import { heroOrbit } from "../lib/heroInput";
import { VisionDebug } from "./VisionDebug";
import { CamPreview } from "./CamPreview";
import "./handControl.css";

declare global {
  interface Window {
    /** DEV-only browser-test access to the exact scene-input singleton this component uses. */
    __flightTest?: { flightInput: typeof flightInput };
  }
}

/**
 * The kiosk's only input. Mounted once, for the whole app.
 *
 * This replaces the phone entirely: no QR to scan, no relay deciding who holds a token, no
 * queue. A visitor walks up, raises a hand, and the screen is theirs — and when they walk
 * away it belongs to nobody again. Everything the phone used to send (move, tap, scroll,
 * back) is produced here from the camera instead, and delivered into the same places the
 * phone's messages went, so the content sections did not have to learn anything new.
 *
 * The gesture grammar is visionOS's, as far as one webcam can carry it:
 *
 *   move a hand           →  move the cursor          (indirect pointing, hand anywhere)
 *   pinch / make a fist, then open → click a control  (one complete close/open cycle)
 *   keep it closed + move → scroll                    (grab the page and move it)
 *   rest on something     →  click, after a moment    (Dwell Control, Apple's own fallback)
 *
 * UI ACTIVATION FIRES ON A REAL RELEASE. Until the hand opens, the same close can still become
 * a scroll by moving beyond the drag threshold; once it does, opening can never click. The
 * pointer accepts both an explicit Open_Palm and a sustained relaxed `None` hand, so release
 * no longer depends on the classifier producing one textbook pose.
 *
 * A lost hand never completes a scroll or scene grab. It also cannot repeat an already accepted
 * control activation: the router stays disarmed until a new, positive open epoch.
 */

/** How far the fingers must close, on the 0..1 scale toward the threshold, to count as a real
 *  attempt rather than a hand relaxing. */
const NEAR_MISS_DEPTH = 0.55;
/** Two near-misses inside this window mean the pinch is not going to work for this visitor. */
const NEAR_MISS_WINDOW_MS = 30_000;
const PARAMS = typeof window === "undefined" ? null : new URLSearchParams(location.search);
/**
 * No hand for this long returns the kiosk to its idle showreel.
 *
 * A visitor who has walked away must not leave their half-read page standing there for the next
 * one to inherit — but this is also the timer that decides how long somebody may drop their arm
 * to rest, or step out of shot to let a colleague look, without losing where they were. The
 * right number is a property of the corridor, so it is answerable at the wall: `?idle=20`.
 */
const IDLE_RETURN_MS = (() => {
  const v = Number(PARAMS?.get("idle"));
  return Number.isFinite(v) && v > 0 ? v * 1000 : 45_000;
})();
/** Elements a hover effect should be applied to, whether or not they opted in. */
const HOVERABLE = '[data-hover], button, a, [role="button"], input, label';

export function HandControl() {
  const { videoRef, status, error, pointer } = useHandPointer(true);
  const cursorRef = useRef<HTMLDivElement>(null);
  const dwellRef = useRef<SVGCircleElement>(null);
  /** Smoothed "how closed are the fingers" — see the ring in the loop. */
  const closing = useRef(0);
  /** Near-misses: fingers closed a long way, nothing latched. See NEAR_MISS below. */
  const nearMiss = useRef<{ armed: boolean; at: number[] }>({ armed: false, at: [] });
  const hovered = useRef<Element | null>(null);
  const diagRef = useRef<HTMLDivElement>(null);
  const routerRef = useRef<InteractionRouter<Element, HTMLElement> | null>(null);
  if (!routerRef.current) routerRef.current = new InteractionRouter<Element, HTMLElement>();

  // Publish the camera's health. With the phone gone there is no second way in, so a screen
  // whose camera failed must be able to say so instead of standing there inviting gestures
  // it cannot see.
  useEffect(() => {
    useKioskStore.getState().setHandStatus(status);
  }, [status]);

  useEffect(() => {
    // `applyProfile` may have run before this pointer existed (for example after a React/HMR
    // remount). Replay the complete live mapping and runtime defaults at the ownership boundary.
    applyProfile(activeProfile(), false);
    if (RUNTIME_CLICK_GESTURE === "fist" && useKioskStore.getState().pinchTrouble) {
      useKioskStore.getState().setPinchTrouble(false);
    }
  }, [pointer]);

  useEffect(() => {
    let raf = 0;
    const router = routerRef.current!;
    // The browser harness must observe and seed this exact imported singleton. Dynamically
    // importing the source path from a Vite page can create a second module instance after HMR
    // (`flightInput.ts` versus `flightInput.ts?t=...`), producing convincing false failures.
    // Keep the seam unavailable in production and when no deliberate synthetic hand is present.
    const flightTestHook =
      import.meta.env.DEV && window.__handSim ? { flightInput } : null;
    if (flightTestHook) window.__flightTest = flightTestHook;
    let lastPresent = performance.now();
    let lastFrame = performance.now();
    let exploreSessionId: number | null = null;
    let exploreOwnerId: number | null = null;
    let nextExploreSessionId = Math.max(1, flightInput.sessionId + 1);

    /** End only the presence-driven Explore session owned by this mounted input loop. */
    const stopExplore = (reason: Parameters<typeof cancelSceneGrab>[0]) => {
      if (exploreSessionId !== null) {
        cancelSceneGrab(reason, {
          sessionId: exploreSessionId,
          ownerId: exploreOwnerId,
        });
      }
      exploreSessionId = null;
      exploreOwnerId = null;
    };
    const click = (el: Element, x: number, y: number) => {
      // AUDIT ONLY. A click that is dispatched onto nothing, or onto a plain div with no
      // interactive ancestor, is a complete success by every measure inside the vision
      // pipeline and a total failure from in front of the screen — the last place the chain
      // can break, and the only one the pointer cannot see.
      if (VISION_TRACE) {
        // The verdict travels WITH the event. A click dispatched onto a non-interactive div is
        // recorded either way; scoring it as a success would let the end-to-end figure count
        // gestures the visitor experienced as nothing happening.
        let verdict: "hit" | "inert" | "nothing";
        if (!el.closest(HOVERABLE)) {
          verdict = "inert";
          noteReject("CLICK_ON_INERT_TARGET", describeElement(el));
        } else {
          verdict = "hit";
          interactionTrace.counts.clicks += 1;
          noteAction(`click → ${describeElement(el.closest(HOVERABLE))}`);
        }
        visionLog.event("click", `${verdict} ${describeElement(el)}`);
      }
      // A dispatched event rather than `el.click()`, because `click()` is a method on
      // HTMLElement and an SVG element is not one. Guarding on `instanceof HTMLElement` meant
      // every icon button drawn as SVG had a dead centre — the arrows on the publications
      // detail were a 23px square of nothing in the middle of a 64px target, while still
      // lighting up on hover, so it read as the tracking failing rather than the button. The
      // event bubbles to whatever handler owns the control, exactly as a real click does.
      el.dispatchEvent(
        new MouseEvent("click", {
          bubbles: true,
          cancelable: true,
          view: window,
          clientX: x,
          clientY: y,
        }),
      );
      const node = cursorRef.current;
      if (node) {
        node.classList.remove("gt-hand--tap");
        void node.offsetWidth; // restart the animation
        node.classList.add("gt-hand--tap");
      }
    };

    const targetValid = (
      target: Element | null,
      point?: { x: number; y: number },
    ): boolean => {
      if (!target?.isConnected) return false;
      if (target.getAttribute("aria-disabled") === "true") return false;
      if (target.closest("[hidden], [inert], [aria-hidden='true']")) return false;
      if (
        (target instanceof HTMLButtonElement || target instanceof HTMLInputElement) &&
        target.disabled
      ) {
        return false;
      }
      const style = getComputedStyle(target);
      const visible =
        style.display !== "none" &&
        style.visibility !== "hidden" &&
        style.pointerEvents !== "none" &&
        target.getClientRects().length > 0;
      if (!visible) return false;
      if (point) {
        const top = document.elementFromPoint(
          point.x * window.innerWidth,
          point.y * window.innerHeight,
        );
        // The aimed control must still be the top layer at confirmation time. Children of the
        // target are valid because a span or SVG inside a button is still that same control.
        if (!top || (top !== target && !target.contains(top))) return false;
      }
      return true;
    };

    const mapCancelReason = (reason: string): InteractionEndReason => {
      switch (reason) {
        case "hand-lost":
        case "track-ended":
          return "hand-lost";
        case "source-stale":
        case "page-hidden":
          return "stale";
        case "owner-changed":
          return "owner-changed";
        case "hold-timeout":
          return "timeout";
        case "mapping-changed":
          return "cancelled";
        default:
          return "cancelled";
      }
    };

    const applyActions = (actions: InteractionAction<Element>[]) => {
      for (const action of actions) {
        if (action.type === "click") {
          click(
            action.target,
            action.point.x * window.innerWidth,
            action.point.y * window.innerHeight,
          );
        } else if (action.type === "scene-begin") {
          beginSceneGrab(action);
        } else if (action.type === "scene-update") {
          updateSceneGrab(action);
        } else if (action.reason === "released") {
          endSceneGrab("released", action);
        } else {
          cancelSceneGrab(action.reason, action);
        }
      }
    };

    const loop = () => {
      raf = requestAnimationFrame(loop);
      const s = pointer.current.state;
      // Scrolling is a speed now, so it has to be integrated over real time — otherwise the
      // page travels at whatever rate this machine happens to render.
      const nowMs = performance.now();
      const dt = Math.min(0.1, (nowMs - lastFrame) / 1000);
      lastFrame = nowMs;
      const handActive = s.present && hasFreshOwner(s, nowMs);
      if (VISION_TRACE) {
        interactionTrace.velocity = s.velocity;
        interactionTrace.gestureMs = s.gestureMs;
      }
      const w = window.innerWidth;
      const h = window.innerHeight;
      const px = s.x * w;
      const py = s.y * h;
      let routed = router.snapshot();
      const store = useKioskStore.getState();
      // Calibration shows its own camera-space evidence and deliberately rejects UI gestures.
      // Hiding the normal cursor there avoids presenting a pointer that cannot activate the
      // buttons beneath it.
      const cursorVisible = handActive && store.calibrated;

      // --- the cursor itself ---
      const node = cursorRef.current;
      if (node) {
        node.style.transform = `translate3d(${px}px, ${py}px, 0)`;
        node.dataset.present = String(cursorVisible);
        node.dataset.pinched = String(s.pinched);
        node.dataset.dragging = String(routed.kind === "UI_SCROLL");
        node.style.opacity = cursorVisible ? String(0.3 + s.conf.value * 0.7) : "0";
      }
      if (dwellRef.current) {
        const C = 2 * Math.PI * 21;
        const target = document.elementFromPoint(px, py);
        const onHot = !!target?.closest(HOVERABLE);

        /**
         * The ring shows three different things, in order of how much they matter.
         *
         * ARMING is the new one and the reason the other two were not enough. Below the pinch
         * threshold the screen said NOTHING: a visitor closing their fingers at two metres,
         * where a webcam can barely resolve two fingertips, got no acknowledgement whatsoever
         * — and a pinch that read 0.9 instead of 0.7 is, from the outside, indistinguishable
         * from a dead camera. Measured with a simulated hand on a far camera: five pinches in
         * twelve produced a click, and the other seven produced no pixel of feedback. So the
         * ring now starts filling as the fingers CLOSE, in proportion to how near the
         * threshold they are, before anything has been decided. It does not make the gesture
         * work; it makes the failure legible, which is what tells someone to close harder or
         * make a fist instead.
         *
         * Smoothed and dead-zoned, because the raw strength is a noisy sensor reading and a
         * ring that shimmers on an open hand is worse than no ring.
         */
        const pinchFeedback = RUNTIME_CLICK_GESTURE !== "fist";
        const raw = pinchFeedback ? pointer.current.pinchStrength() : 0;
        closing.current += ((raw < 0.12 ? 0 : raw) - closing.current) * 0.25;
        const arming = s.pressProgress === 0 && !s.pinched ? closing.current : 0;
        // PRESS: the posture is being held toward the moment it counts. Without it a hold that
        // was a shade too short is indistinguishable from a dead camera.
        // DWELL: the same, for the resting fallback, when it is enabled at all.
        const progress =
          s.pressProgress > 0 ? s.pressProgress : Math.max(onHot ? s.dwell : 0, arming);

        /**
         * NEAR_MISS: fingers that closed most of the way and never crossed the threshold.
         *
         * Two of those inside half a minute is not bad luck, it is this camera at this
         * distance failing to read this visitor's pinch — and the only useful thing the screen
         * can do about it is stop asking for a pinch. The fist is read from the whole hand's
         * shape rather than from two fingertips, and it survives the same conditions
         * (12/12 against 2/12 in the harness), so that is what the hint switches to.
         */
        const m = nearMiss.current;
        if (pinchFeedback && closing.current > NEAR_MISS_DEPTH && !s.pinched) m.armed = true;
        else if (pinchFeedback && m.armed && closing.current < 0.12) {
          m.armed = false;
          m.at.push(nowMs);
          m.at = m.at.filter((t) => nowMs - t < NEAR_MISS_WINDOW_MS);
          const store2 = useKioskStore.getState();
          if (m.at.length >= 2 && !store2.pinchTrouble) store2.setPinchTrouble(true);
        } else if (!pinchFeedback) {
          m.armed = false;
          m.at.length = 0;
        }
        if (pinchFeedback && s.pinched) {
          // It read. Whatever it was doing wrong, it is not doing it now.
          m.armed = false;
          m.at.length = 0;
          if (useKioskStore.getState().pinchTrouble) {
            useKioskStore.getState().setPinchTrouble(false);
          }
        }
        dwellRef.current.style.strokeDasharray = `${progress * C} ${C}`;
        if (node) {
          node.dataset.dwelling = String(progress > 0.001);
          node.dataset.arming = String(arming > 0.001);
        }
      }
      setCursorPosition(px, py);
      if (heroOrbit.active) {
        if (handActive) {
          heroOrbit.aim(s.x, s.y);
          heroOrbit.touched = true;
        } else {
          heroOrbit.touched = false;
        }
      }

      // --- presence drives the whole kiosk's mode ---
      if (handActive !== store.handPresent) store.setHandPresent(handActive);
      if (handActive) lastPresent = performance.now();
      else if (store.entered && performance.now() - lastPresent > IDLE_RETURN_MS) {
        // Nobody has been here for a while: go back to being a showreel, on the home view,
        // so the next visitor doesn't inherit the last one's half-read page.
        store.setEntered(false);
        store.setView("home");
      }

      // --- hover, since a kiosk has no real pointer and gets no :hover ---
      if (handActive && store.calibrated) {
        const under = document.elementFromPoint(px, py);
        const hot = under?.closest(HOVERABLE) ?? null;
        const mark = (el: Element) => {
          el.classList.add("gt-hover");
          // Sections that styled their own hover state keep using it.
          if (el.hasAttribute("data-hover")) el.classList.add("is-hover");
        };
        if (VISION_TRACE) {
          interactionTrace.hover = describeElement(hot ?? under);
          interactionTrace.hoverInteractive = !!hot;
        }
        if (hot !== hovered.current) {
          hovered.current?.classList.remove("is-hover", "gt-hover");
          if (hot) mark(hot);
          hovered.current = hot;
        } else if (hot && !hot.classList.contains("gt-hover")) {
          // RE-ASSERT, every frame, if the class went missing. React owns `className` on the
          // elements it renders and rewrites it wholesale on any re-render — so a button that
          // re-rendered while the hand was resting on it silently lost its hover marking and
          // never got it back, because from here nothing had changed. Measured on the home
          // board: sixty of seventy-five probed points showed no hover at all, purely because
          // pointing at a row re-rendered that row.
          mark(hot);
        }
      } else if (hovered.current) {
        hovered.current.classList.remove("is-hover", "gt-hover");
        hovered.current = null;
      }

      // --- one exclusive gesture session: calibration, UI, or Gaussian scene -------------
      const context: RouterContext = {
        environment: !store.calibrated ? "calibration" : store.entered ? "site" : "showreel",
        sceneReady: flightInput.ready,
      };
      const actions: InteractionAction<Element>[] = [];

      const raw = s.rawHand;
      const ownerHands =
        s.owner.selectedIndex >= 0 && s.hands[s.owner.selectedIndex]
          ? [s.hands[s.owner.selectedIndex]!]
          : [];
      // Establish the newest safety boundary before committing any durable edge queued since the
      // previous display frame. A release followed by owner/source loss in the same rAF batch must
      // be cancelled, not turned into a click merely because the release happened to be dequeued
      // first. InteractionRouter accepts older one-shot edges after this observation by sequence.
      actions.push(
        ...router.observe(
          {
            seq: s.sample.seq,
            // Router/scene watchdogs measure total observation age from capture. Using
            // completion time here would grant slow inference a second full freshness window.
            at: s.sample.receivedAtMs,
            ownerId: s.owner.id,
            sourceFresh: s.sample.sourceFresh,
            ownerVisible: s.owner.visible,
            fresh: hasFreshOwner(s, nowMs),
            freshForMs: s.sample.freshForMs,
            // The opening silhouette may shift the mapped wrist. Observe a durable release frame
            // as neutral before its edge commits, so sample-first safety ordering cannot turn that
            // shape change into scroll; the edge carries the last genuinely held live position.
            posture: s.released ? "unknown" : s.posture,
            pointer: { x: s.x, y: s.y },
            live: { x: s.liveX, y: s.liveY },
            rawHand: raw
              ? { frameX: raw.frameX, frameY: raw.frameY, palmSpan: raw.palmSpan }
              : null,
            // Visual feedback follows the same stable owner as the gesture. Showing every
            // detection here would make a bystander's hand look capable of taking control.
            hands: ownerHands,
          },
          context,
        ),
      );

      // Edges are queued by the camera loop. Polling the old one-frame `pressed/released`
      // booleans could miss an entire tap when camera FPS exceeded display FPS.
      for (const event of pointer.current.drainEvents()) {
        const rawHand = event.rawHand
          ? {
              frameX: event.rawHand.frameX,
              frameY: event.rawHand.frameY,
              palmSpan: event.rawHand.palmSpan,
            }
          : null;
        const common = {
          seq: event.seq,
          at: event.at,
          ownerId: event.ownerId,
          aim: event.aim,
          live: event.live,
          rawHand,
          freshForMs: event.freshForMs,
        };
        const edge: RouterGestureEdge =
          event.type === "cancel"
            ? { ...common, type: "cancel", reason: mapCancelReason(event.reason) }
            : { ...common, type: event.type };

        let hit: RouterHit<Element, HTMLElement> | undefined;
        if (
          edge.type === "press" &&
          Number.isFinite(edge.aim.x) &&
          Number.isFinite(edge.aim.y)
        ) {
          const hitX = edge.aim.x * w;
          const hitY = edge.aim.y * h;
          const under = document.elementFromPoint(hitX, hitY);
          const clickTarget = under?.closest(HOVERABLE) ?? null;
          const scrollEl = scrollableAt(hitX, hitY);
          const root = document.documentElement;
          const pageCanScroll =
            root.scrollHeight > window.innerHeight + 8 ||
            root.scrollWidth > window.innerWidth + 8;
          const canScroll = context.environment === "site" && (!!scrollEl || pageCanScroll);
          hit = {
            clickTarget,
            scrollTarget: scrollEl,
            canScroll,
            // Production Showreel is presence-driven Explore. A fist on the background is a
            // pause, not a second clutch grammar competing with the open-hand joystick.
            scene: false,
          };
          if (VISION_TRACE) {
            interactionTrace.canScroll = canScroll;
            interactionTrace.dragFrac = 0;
            interactionTrace.dragPx = 0;
            noteAction(
              `press via ${event.via} at ${hitX.toFixed(0)},${hitY.toFixed(0)}`,
            );
            visionLog.event("press", event.via);
          }
        } else if (VISION_TRACE) {
          visionLog.event(
            event.type === "cancel" ? "release" : event.type,
            event.type === "cancel" ? event.reason : "opened",
          );
        }

        const lockedClickTarget =
          edge.type === "release" ? router.snapshot().clickTarget : null;
        const edgeTargetValid =
          edge.type === "press"
            ? hit?.clickTarget === null ||
              hit?.clickTarget === undefined ||
              targetValid(hit.clickTarget, edge.aim)
            : edge.type === "release"
              ? lockedClickTarget === null || targetValid(lockedClickTarget, edge.aim)
              : true;
        actions.push(
          ...router.handleEdge(
            edge,
            context,
            hit,
            edgeTargetValid,
            nowMs,
          ),
        );
      }

      actions.push(...router.tick(nowMs, context));
      applyActions(actions);

      routed = router.snapshot();

      // --- Showreel takeover ---------------------------------------------------------------
      // Presence freezes the news/tour in CampusFlight. Camera authority remains stricter:
      // one fresh, stable owner; an explicitly open hand; no UI underneath; and an armed
      // router epoch. This keeps "raise a hand to explore" immediate without allowing a
      // button press, a half-closed hand or stale coordinates to move the Gaussian camera.
      if (
        exploreSessionId !== null &&
        (!flightInput.active || flightInput.sessionId !== exploreSessionId)
      ) {
        exploreSessionId = null;
        exploreOwnerId = null;
      }

      const liveUnder = handActive ? document.elementFromPoint(px, py) : null;
      const overSceneUi = !!liveUnder?.closest(
        `${HOVERABLE}, [data-no-fly], [data-scene-ui]`,
      );
      const canExplore =
        context.environment === "showreel" &&
        context.sceneReady &&
        handActive &&
        s.owner.id !== null &&
        s.posture === "open" &&
        !s.pinched &&
        s.pressProgress === 0 &&
        routed.kind === "POINTING" &&
        routed.armed &&
        !overSceneUi;

      if (canExplore) {
        if (exploreSessionId !== null && exploreOwnerId !== s.owner.id) {
          stopExplore("owner-changed");
        }
        if (exploreSessionId === null && !flightInput.active) {
          setSceneMode("explore");
          const sessionId = Math.max(nextExploreSessionId, flightInput.sessionId + 1);
          nextExploreSessionId = sessionId + 1;
          if (
            beginSceneGrab({
              sessionId,
              ownerId: s.owner.id!,
              seq: s.sample.seq,
              freshAt: s.sample.receivedAtMs,
              freshForMs: s.sample.freshForMs,
              hands: ownerHands,
            })
          ) {
            exploreSessionId = sessionId;
            exploreOwnerId = s.owner.id;
          }
        }
        const activeExploreOwner = exploreOwnerId;
        if (
          exploreSessionId !== null &&
          activeExploreOwner !== null &&
          activeExploreOwner === s.owner.id
        ) {
          const axes = sceneExploreAxes(s.liveX, s.liveY);
          updateSceneGrab({
            sessionId: exploreSessionId,
            ownerId: activeExploreOwner,
            seq: s.sample.seq,
            freshAt: s.sample.receivedAtMs,
            freshForMs: s.sample.freshForMs,
            dx: axes.dx,
            dy: axes.dy,
            vx: 0,
            vy: 0,
            hands: ownerHands,
          });
        }
      } else if (exploreSessionId !== null) {
        const reason =
          context.environment !== "showreel"
            ? "mode-changed"
            : !context.sceneReady
              ? "scene-unavailable"
              : !s.present || s.owner.id === null
                ? "hand-lost"
                : !handActive
                  ? "stale"
                  : exploreOwnerId !== s.owner.id
                    ? "owner-changed"
                    : "cancelled";
        stopExplore(reason);
      }

      if (routed.kind === "UI_SCROLL") {
        // Lean, don't drag: displacement from the locked origin sets a continuous speed.
        const vx = dragScrollVelocity(routed.scrollDx);
        const vy = dragScrollVelocity(routed.scrollDy);
        if (vx !== 0 || vy !== 0) scrollTarget(routed.scrollTarget, vx * dt, vy * dt);
      }
      if (VISION_TRACE) {
        interactionTrace.dragFrac = Math.hypot(routed.scrollDx, routed.scrollDy);
        interactionTrace.dragPx = interactionTrace.dragFrac * Math.hypot(w, h);
      }

      // --- the chain, stated out loud (dev only) ---
      // Each link here was guessed at once and guessed wrong. A hand can be tracked while the
      // tour keeps playing, and from the outside those are indistinguishable from a pointer
      // that simply does not work — so the state that decides it is on screen rather than in
      // someone's head.
      if (import.meta.env.DEV && diagRef.current) {
        const th = pointer.current.pinchThresholds;
        diagRef.current.textContent =
          `hand ${handActive ? "✓" : "✗"} · ${s.conf.reason} · ${s.fps.toFixed(0)}fps` +
          ` · ${s.pinched ? `PINCH(${s.pressVia})` : "open"}` +
          // The numbers that decide it. A stuck click was invisible without them: the state
          // said PINCH and nothing said why, or what an open hand would have to do to escape.
          ` · ratio ${Number.isFinite(s.ratio) ? s.ratio.toFixed(2) : "—"}` +
          ` str ${(pointer.current.pinchStrength() * 100).toFixed(0)}%` +
          ` (on<${th.on.toFixed(2)} off>${th.off.toFixed(2)})` +
          ` · entered ${store.entered ? "✓" : "✗"}` +
          ` · route ${routed.kind}` +
          ` · scene ${flightInput.active ? flightInput.mode : "off"}` +
          ` Δ ${flightInput.dx.toFixed(2)},${flightInput.dy.toFixed(2)}`;
      }

      // Dwell is a complete click on its own. It crosses from the camera clock to the display
      // clock through a queue, just like press/release: a one-camera-frame boolean is otherwise
      // observed eight times by a 120Hz display fed by a 15fps camera.
      for (const event of pointer.current.drainDwellEvents()) {
        const eventFresh =
          nowMs >= event.at &&
          nowMs - event.at <= event.freshForMs &&
          event.ownerId === s.owner.id &&
          hasFreshOwner(s, nowMs);
        if (
          !eventFresh ||
          context.environment !== "site" ||
          routed.kind !== "POINTING" ||
          !routed.armed
        ) {
          continue;
        }
        const dwellX = event.aim.x * w;
        const dwellY = event.aim.y * h;
        const target = document.elementFromPoint(dwellX, dwellY);
        const hot = target?.closest(HOVERABLE) ?? null;
        if (hot && targetValid(hot)) {
          if (VISION_TRACE) interactionTrace.counts.dwellClicks += 1;
          click(hot, dwellX, dwellY);
        }
      }
    };

    raf = requestAnimationFrame(loop);
    return () => {
      cancelAnimationFrame(raf);
      applyActions(router.dispose(performance.now()));
      stopExplore("unmount");
      if (flightTestHook && window.__flightTest === flightTestHook) {
        delete window.__flightTest;
      }
      hovered.current?.classList.remove("is-hover", "gt-hover");
      hovered.current = null;
    };
  }, [pointer]);

  return (
    <>
      {/* Hidden, but must be in the document: the camera stream needs a live element. */}
      <video ref={videoRef} className="gt-hand-cam" playsInline muted aria-hidden />

      <div ref={cursorRef} className="gt-hand" data-present="false" aria-hidden>
        <svg viewBox="0 0 48 48" className="gt-hand__svg">
          <circle className="gt-hand__dot" cx="24" cy="24" r="5" />
          <circle className="gt-hand__ring" cx="24" cy="24" r="21" />
          <circle ref={dwellRef} className="gt-hand__dwell" cx="24" cy="24" r="21" />
        </svg>
      </div>

      {import.meta.env.DEV ? <div ref={diagRef} className="gt-hand-diag" /> : null}

      {/* The fault-isolation HUD. Renders nothing at all without `?visionDebug=1`, and works
          in a production build too — the wall is where the measurements have to be taken. */}
      <VisionDebug video={videoRef} pointer={pointer} />
      {/* The camera as the pointer sees it — `?cam=1`. Renders nothing otherwise. */}
      <CamPreview video={videoRef} pointer={pointer} />

      {status === "error" || (status === "loading" && error) ? (
        <div className="gt-hand-error" role="status">
          {status === "error" ? "Camera unavailable" : "Camera reconnecting"} — {error ?? "unknown"}
        </div>
      ) : null}
    </>
  );
}
