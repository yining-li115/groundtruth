import { useEffect, useRef } from "react";
import { useHandPointer } from "../lib/vision/handPointer";
import { flightInput, steer, stopFlight } from "../lib/vision/flightInput";
import { setCursorPosition } from "../lib/cursorPosition";
import { dragScrollVelocity, scrollableAt, scrollTarget } from "../lib/scroll";
import { useKioskStore } from "../state/store";
import {
  VISION_TRACE,
  describeElement,
  interactionTrace,
  noteAction,
  noteReject,
} from "../lib/vision/trace";
import { visionLog } from "../lib/vision/visionLog";
import { VisionDebug } from "./VisionDebug";
import "./handControl.css";

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
 *   pinch / make a fist   →  click                    ("pinch is the new click")
 *   pinch and drag        →  scroll                   (grab the page and move it)
 *   rest on something     →  click, after a moment    (Dwell Control, Apple's own fallback)
 *
 * TAP FIRES ON RELEASE, NOT ON PRESS — the same rule as touch and as visionOS. A press
 * cannot know yet whether it is the start of a tap or the start of a drag, and guessing
 * "tap" means every attempt to scroll also activates whatever was underneath. Waiting until
 * the fingers open resolves it: no movement means it was a tap.
 *
 * A release caused by LOSING the hand is not a tap. Someone lowering their arm or walking
 * off must not leave a click behind them on the way out.
 */

/**
 * How far the hand must travel while held before it counts as a drag, in screen fractions.
 *
 * Measured against where the hand WAS when the press landed, never against the frozen aim —
 * see `liveX` on the pointer state. Generous, because this is a whole arm held in the air:
 * a threshold tuned for a fingertip on glass turns every tap into a drag and silently eats
 * the click.
 *
 * DELIBERATELY BELOW the scroll deadzone. The two were equal, which left no room between
 * them: a small, hesitant lean — someone trying to scroll and not committing — was too small
 * to be a drag and too small to scroll, so it arrived as a CLICK on whatever was underneath.
 * Measured on the research page: lean 0.04, release, and the topic changed. Whatever a
 * visitor is doing when they lean on a held hand, they are not asking to activate something,
 * so the gesture stops counting as a tap well before it starts counting as a scroll.
 */
const DRAG_START = 0.025;
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

/**
 * Overrides, for standing in front of the real screen and changing the answer without a
 * rebuild: `?click=fist` (or `pinch`, or `either`), `?dwell=900` (0 turns dwell off).
 *
 * Which posture to trust is a hardware question, not a taste one — it depends on the camera
 * and how far away the visitor stands — so it has to be answerable at the wall.
 */
const CLICK_GESTURE = (() => {
  const v = PARAMS?.get("click");
  return v === "pinch" || v === "fist" || v === "either" ? v : undefined;
})();
const DWELL_MS = (() => {
  const v = Number(PARAMS?.get("dwell"));
  return Number.isFinite(v) && PARAMS?.get("dwell") !== null ? v : undefined;
})();

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

  // Publish the camera's health. With the phone gone there is no second way in, so a screen
  // whose camera failed must be able to say so instead of standing there inviting gestures
  // it cannot see.
  useEffect(() => {
    useKioskStore.getState().setHandStatus(status);
  }, [status]);

  useEffect(() => {
    if (CLICK_GESTURE) pointer.current.configure({ clickGesture: CLICK_GESTURE });
    if (DWELL_MS !== undefined) pointer.current.configure({ dwellMs: DWELL_MS });
  }, [pointer]);

  useEffect(() => {
    let raf = 0;
    /** where the press landed, in screen fractions — the aim a tap will be delivered at */
    let pressAt: { x: number; y: number } | null = null;
    /** where the hand was when the press landed — the origin a drag is measured from */
    let dragFrom: { x: number; y: number } | null = null;
    /** what this drag scrolls: the scrollable element it started over, or the page */
    let scrollEl: HTMLElement | null = null;
    let dragging = false;
    /** whether this grab had anything to scroll — see the note where it is set */
    let canScroll = false;
    let lastPresent = performance.now();
    let lastFrame = performance.now();
    const click = (x: number, y: number) => {
      // The cursor is pointer-events:none, so this reaches the UI beneath it.
      const el = document.elementFromPoint(x, y);
      // AUDIT ONLY. A click that is dispatched onto nothing, or onto a plain div with no
      // interactive ancestor, is a complete success by every measure inside the vision
      // pipeline and a total failure from in front of the screen — the last place the chain
      // can break, and the only one the pointer cannot see.
      if (VISION_TRACE) {
        // The verdict travels WITH the event. A click dispatched onto a non-interactive div is
        // recorded either way; scoring it as a success would let the end-to-end figure count
        // gestures the visitor experienced as nothing happening.
        let verdict: "hit" | "inert" | "nothing";
        if (!el) {
          verdict = "nothing";
          noteReject("NO_CLICK_TARGET", `${x.toFixed(0)},${y.toFixed(0)}`);
        } else if (!el.closest(HOVERABLE)) {
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
      el?.dispatchEvent(
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

    const loop = () => {
      raf = requestAnimationFrame(loop);
      const s = pointer.current.state;
      // Scrolling is a speed now, so it has to be integrated over real time — otherwise the
      // page travels at whatever rate this machine happens to render.
      const nowMs = performance.now();
      const dt = Math.min(0.1, (nowMs - lastFrame) / 1000);
      lastFrame = nowMs;
      if (VISION_TRACE) {
        interactionTrace.velocity = s.velocity;
        interactionTrace.gestureMs = s.gestureMs;
      }
      const w = window.innerWidth;
      const h = window.innerHeight;
      const px = s.x * w;
      const py = s.y * h;

      // --- the cursor itself ---
      const node = cursorRef.current;
      if (node) {
        node.style.transform = `translate3d(${px}px, ${py}px, 0)`;
        node.dataset.present = String(s.present);
        node.dataset.pinched = String(s.pinched);
        node.dataset.dragging = String(dragging);
        node.style.opacity = s.present ? String(0.3 + s.conf.value * 0.7) : "0";
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
        const raw = pointer.current.pinchStrength();
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
        if (closing.current > NEAR_MISS_DEPTH && !s.pinched) m.armed = true;
        else if (m.armed && closing.current < 0.12) {
          m.armed = false;
          m.at.push(nowMs);
          m.at = m.at.filter((t) => nowMs - t < NEAR_MISS_WINDOW_MS);
          const store2 = useKioskStore.getState();
          if (m.at.length >= 2 && !store2.pinchTrouble) store2.setPinchTrouble(true);
        }
        if (s.pinched) {
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

      // --- presence drives the whole kiosk's mode ---
      const store = useKioskStore.getState();
      if (s.present !== store.handPresent) store.setHandPresent(s.present);
      if (s.present) lastPresent = performance.now();
      else if (store.entered && performance.now() - lastPresent > IDLE_RETURN_MS) {
        // Nobody has been here for a while: go back to being a showreel, on the home view,
        // so the next visitor doesn't inherit the last one's half-read page.
        store.setEntered(false);
        store.setView("home");
      }

      // --- hover, since a kiosk has no real pointer and gets no :hover ---
      if (s.present) {
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

      // --- press / drag / release ---
      if (s.pressed) {
        // Two different positions on purpose: the aim a tap will be delivered at, and where
        // the hand actually was, which is what a drag is measured from.
        pressAt = { x: s.x, y: s.y };
        dragFrom = { x: s.liveX, y: s.liveY };
        // Decided once, where the grab landed, so a drag cannot hand itself to a different
        // container halfway through.
        scrollEl = scrollableAt(px, py);
        // Could this gesture have been a scroll at all? If neither an element under the grab
        // nor the page itself can move, then drifting during a pinch cannot have been an
        // attempt to scroll — so it must not be allowed to swallow the click. On the home page
        // (which does not scroll) a 20px wobble produced no click, no scroll and no feedback.
        canScroll =
          !!scrollEl || document.documentElement.scrollHeight > window.innerHeight + 8;
        dragging = false;
        if (VISION_TRACE) {
          interactionTrace.canScroll = canScroll;
          interactionTrace.dragFrac = 0;
          interactionTrace.dragPx = 0;
          noteAction(`press via ${s.pressVia ?? "?"} at ${(s.x * w).toFixed(0)},${(s.y * h).toFixed(0)}`);
          visionLog.event("press", s.pressVia ?? "?");
        }
      } else if (s.pinched && pressAt && dragFrom) {
        // Drag detection runs everywhere, not only inside the site. It is what lets a press be
        // taken back: move away before letting go and it is not a tap. Gating this on being in
        // the site meant a press on the showreel could never be cancelled — grab Enter, change
        // your mind, move half a screen away, release, and you were in anyway.
        const moved = Math.hypot(s.liveX - dragFrom.x, s.liveY - dragFrom.y);
        if (VISION_TRACE) {
          interactionTrace.dragFrac = moved;
          interactionTrace.dragPx = moved * Math.hypot(w, h);
        }
        if (!dragging && moved > DRAG_START) {
          dragging = true;
          if (VISION_TRACE) {
            interactionTrace.counts.drags += 1;
            // Crossing the threshold is not yet a lost click — `canScroll` decides that on
            // release. Logged separately so "the hand wobbled" and "the wobble cost the
            // click" never end up as the same number.
            noteReject("RECLASSIFIED_AS_DRAG", `moved ${moved.toFixed(3)} > ${DRAG_START}`);
            visionLog.event("drag", moved.toFixed(3));
          }
        }
        if (dragging && store.entered) {
          // Lean, don't drag: how far the hand has moved from where it grabbed sets a SPEED,
          // and the surface keeps going while it stays there. See `dragScrollVelocity`.
          const vy = dragScrollVelocity(s.liveY - dragFrom.y);
          const vx = dragScrollVelocity(s.liveX - dragFrom.x);
          if (vx !== 0 || vy !== 0) scrollTarget(scrollEl, vx * dt, vy * dt);
        }
      } else if (s.released) {
        if (VISION_TRACE) {
          visionLog.event("release", s.releasedByLoss ? "by loss" : "opened");
          if (pressAt && dragging && canScroll) {
            noteReject(
              "POINTER_MOTION_SUPPRESSED_CLICK",
              `drag ${interactionTrace.dragFrac.toFixed(3)} over a scrollable surface`,
            );
          } else if (pressAt && s.releasedByLoss) {
            noteReject("CLICK_SUPPRESSED", "released by hand loss");
          }
        }
        // A release caused by losing the hand is not a tap — see the note at the top.
        if (pressAt && !(dragging && canScroll) && !s.releasedByLoss) {
          click(pressAt.x * w, pressAt.y * h);
        }
        pressAt = null;
        dragFrom = null;
        scrollEl = null;
        dragging = false;
      }

      // --- flying the showreel ---
      if (!store.entered && s.present) {
        // The tour hands over the moment a hand is seen. `present` is what freezes it, so it
        // is set even while the camera is holding still — the visitor is in charge from the
        // first frame, and a tour that carried on playing under someone's hand would read as
        // the screen ignoring them.
        flightInput.handCount = s.hands.length;
        flightInput.hands = s.hands;
        // Aiming at a control is not flying, and neither is clicking.
        const under = document.elementFromPoint(px, py);
        const onUi = !!under?.closest(`${HOVERABLE}, [data-no-fly]`);
        steer(s.x, s.y, { holdStill: onUi || s.pinched });
      } else if (flightInput.present) {
        // Nobody there: full stop, so the flight eases back to its composed tour instead of
        // coasting on the last intent it was given.
        stopFlight();
        pressAt = null;
        dragFrom = null;
        dragging = false;
      }

      // --- the chain, stated out loud (dev only) ---
      // Each link here was guessed at once and guessed wrong. A hand can be tracked while the
      // tour keeps playing, and from the outside those are indistinguishable from a pointer
      // that simply does not work — so the state that decides it is on screen rather than in
      // someone's head.
      if (import.meta.env.DEV && diagRef.current) {
        const th = pointer.current.pinchThresholds;
        diagRef.current.textContent =
          `hand ${s.present ? "✓" : "✗"} · ${s.conf.reason} · ${s.fps.toFixed(0)}fps` +
          ` · ${s.pinched ? `PINCH(${s.pressVia})` : "open"}` +
          // The numbers that decide it. A stuck click was invisible without them: the state
          // said PINCH and nothing said why, or what an open hand would have to do to escape.
          ` · ratio ${Number.isFinite(s.ratio) ? s.ratio.toFixed(2) : "—"}` +
          ` str ${(pointer.current.pinchStrength() * 100).toFixed(0)}%` +
          ` (on<${th.on.toFixed(2)} off>${th.off.toFixed(2)})` +
          ` · entered ${store.entered ? "✓" : "✗"}` +
          ` · flight ${flightInput.present ? "ON" : "off"}` +
          ` yaw ${flightInput.yaw} dolly ${flightInput.dolly}`;
      }

      // --- dwell is a complete click on its own ---
      if (s.dwellFired) {
        const target = document.elementFromPoint(px, py);
        if (target?.closest(HOVERABLE)) {
          if (VISION_TRACE) interactionTrace.counts.dwellClicks += 1;
          click(px, py);
        }
      }
    };

    raf = requestAnimationFrame(loop);
    return () => {
      cancelAnimationFrame(raf);
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

      {status === "error" ? (
        <div className="gt-hand-error" role="status">
          Camera unavailable — {error ?? "unknown"}
        </div>
      ) : null}
    </>
  );
}
