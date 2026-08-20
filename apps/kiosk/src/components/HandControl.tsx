import { useEffect, useRef } from "react";
import { useHandPointer } from "../lib/vision/handPointer";
import { flightInput, steer, stopFlight } from "../lib/vision/flightInput";
import { setCursorPosition } from "../lib/cursorPosition";
import { dragScrollVelocity, scrollableAt, scrollTarget } from "../lib/scroll";
import { useKioskStore } from "../state/store";
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
/** No hand for this long returns the kiosk to its idle showreel. */
const IDLE_RETURN_MS = 45_000;
/** Elements a hover effect should be applied to, whether or not they opted in. */
const HOVERABLE = '[data-hover], button, a, [role="button"], input, label';

/**
 * Overrides, for standing in front of the real screen and changing the answer without a
 * rebuild: `?click=fist` (or `pinch`, or `either`), `?dwell=900` (0 turns dwell off).
 *
 * Which posture to trust is a hardware question, not a taste one — it depends on the camera
 * and how far away the visitor stands — so it has to be answerable at the wall.
 */
const PARAMS = typeof window === "undefined" ? null : new URLSearchParams(location.search);
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
        // The ring shows whichever of the two is happening: a press filling toward the moment
        // it counts, or (when enabled) a dwell filling toward the same thing. The press one
        // matters most — it is the only feedback that a gesture is being received at all, and
        // without it a hold that was a shade too short is indistinguishable from a dead camera.
        const progress = s.pressProgress > 0 ? s.pressProgress : onHot ? s.dwell : 0;
        dwellRef.current.style.strokeDasharray = `${progress * C} ${C}`;
        if (node) node.dataset.dwelling = String(progress > 0.001);
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
        if (hot !== hovered.current) {
          hovered.current?.classList.remove("is-hover", "gt-hover");
          if (hot) {
            hot.classList.add("gt-hover");
            // Sections that styled their own hover state keep using it.
            if (hot.hasAttribute("data-hover")) hot.classList.add("is-hover");
          }
          hovered.current = hot;
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
      } else if (s.pinched && pressAt && dragFrom) {
        // Drag detection runs everywhere, not only inside the site. It is what lets a press be
        // taken back: move away before letting go and it is not a tap. Gating this on being in
        // the site meant a press on the showreel could never be cancelled — grab Enter, change
        // your mind, move half a screen away, release, and you were in anyway.
        const moved = Math.hypot(s.liveX - dragFrom.x, s.liveY - dragFrom.y);
        if (!dragging && moved > DRAG_START) dragging = true;
        if (dragging && store.entered) {
          // Lean, don't drag: how far the hand has moved from where it grabbed sets a SPEED,
          // and the surface keeps going while it stays there. See `dragScrollVelocity`.
          const vy = dragScrollVelocity(s.liveY - dragFrom.y);
          const vx = dragScrollVelocity(s.liveX - dragFrom.x);
          if (vx !== 0 || vy !== 0) scrollTarget(scrollEl, vx * dt, vy * dt);
        }
      } else if (s.released) {
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
        if (target?.closest(HOVERABLE)) click(px, py);
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

      {status === "error" ? (
        <div className="gt-hand-error" role="status">
          Camera unavailable — {error ?? "unknown"}
        </div>
      ) : null}
    </>
  );
}
