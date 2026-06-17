import { useEffect, useRef } from "react";
import { socket } from "../lib/socket";

/** Below this finger travel (px) + under TAP_MAX_MS, a touch counts as a tap/click. */
const TAP_MAX_MOVE = 10;
const TAP_MAX_MS = 250;

/**
 * The phone is a RELATIVE pointing device, like a laptop trackpad (architecture §4):
 * we send the finger's delta, not an absolute position, so a small phone can drive the
 * whole big screen and the cursor never jumps. One finger = move (+ tap on release),
 * two fingers = scroll. Move/scroll deltas are coalesced per animation frame to cap the
 * message rate; the relay also rate-limits (§9).
 *
 * Mouse + wheel are also wired up so the surface can be driven from a desktop browser
 * (drag = move, click = tap, wheel = scroll) — handy for same-machine testing without
 * a phone or device emulation. Touch handlers preventDefault, which suppresses the
 * synthetic mouse events mobile browsers would otherwise fire, so the two don't clash.
 */
export function TrackpadSurface({ onActivity }: { onActivity?: () => void }) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    let last: { x: number; y: number } | null = null;
    let twoFingerY: number | null = null;
    let dragging = false; // mouse button held (desktop)
    let startTime = 0;
    let moved = 0;
    let dxSum = 0;
    let dySum = 0;
    let scrollSum = 0;
    let raf = 0;

    const flush = () => {
      raf = 0;
      if (dxSum !== 0 || dySum !== 0) {
        socket.emit("ctrl:input.move", { dx: dxSum, dy: dySum });
        dxSum = 0;
        dySum = 0;
        onActivity?.();
      }
      if (scrollSum !== 0) {
        socket.emit("ctrl:input.scroll", { dy: scrollSum });
        scrollSum = 0;
        onActivity?.();
      }
    };
    const schedule = () => {
      if (!raf) raf = requestAnimationFrame(flush);
    };

    const onStart = (e: TouchEvent) => {
      e.preventDefault();
      startTime = performance.now();
      moved = 0;
      if (e.touches.length >= 2) {
        const a = e.touches[0];
        const b = e.touches[1];
        twoFingerY = a && b ? (a.clientY + b.clientY) / 2 : null;
        last = null;
      } else {
        const t = e.touches[0];
        last = t ? { x: t.clientX, y: t.clientY } : null;
        twoFingerY = null;
      }
    };

    const onMove = (e: TouchEvent) => {
      e.preventDefault();
      if (e.touches.length >= 2) {
        const a = e.touches[0];
        const b = e.touches[1];
        if (a && b) {
          const y = (a.clientY + b.clientY) / 2;
          if (twoFingerY !== null) {
            scrollSum += y - twoFingerY;
            schedule();
          }
          twoFingerY = y;
        }
        last = null;
        return;
      }
      const t = e.touches[0];
      if (t && last) {
        const dx = t.clientX - last.x;
        const dy = t.clientY - last.y;
        dxSum += dx;
        dySum += dy;
        moved += Math.hypot(dx, dy);
        schedule();
      }
      if (t) last = { x: t.clientX, y: t.clientY };
    };

    const onEnd = (e: TouchEvent) => {
      e.preventDefault();
      const duration = performance.now() - startTime;
      if (
        twoFingerY === null &&
        e.touches.length === 0 &&
        moved < TAP_MAX_MOVE &&
        duration < TAP_MAX_MS
      ) {
        socket.emit("ctrl:input.tap", {});
        onActivity?.();
      }
      if (e.touches.length === 0) {
        last = null;
        twoFingerY = null;
      }
    };

    // ---- mouse (desktop testing) ----
    const onMouseDown = (e: MouseEvent) => {
      e.preventDefault();
      dragging = true;
      startTime = performance.now();
      moved = 0;
      last = { x: e.clientX, y: e.clientY };
    };
    const onMouseMove = (e: MouseEvent) => {
      if (!dragging || !last) return;
      const dx = e.clientX - last.x;
      const dy = e.clientY - last.y;
      dxSum += dx;
      dySum += dy;
      moved += Math.hypot(dx, dy);
      last = { x: e.clientX, y: e.clientY };
      schedule();
    };
    const onMouseUp = (e: MouseEvent) => {
      if (!dragging) return;
      e.preventDefault();
      dragging = false;
      last = null;
      const duration = performance.now() - startTime;
      if (moved < TAP_MAX_MOVE && duration < TAP_MAX_MS) {
        socket.emit("ctrl:input.tap", {});
        onActivity?.();
      }
    };
    const onMouseLeave = () => {
      // Cancel an in-progress drag without firing a tap.
      dragging = false;
      last = null;
    };
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      scrollSum += e.deltaY;
      schedule();
    };

    el.addEventListener("touchstart", onStart, { passive: false });
    el.addEventListener("touchmove", onMove, { passive: false });
    el.addEventListener("touchend", onEnd, { passive: false });
    el.addEventListener("touchcancel", onEnd, { passive: false });
    el.addEventListener("mousedown", onMouseDown);
    el.addEventListener("mousemove", onMouseMove);
    el.addEventListener("mouseup", onMouseUp);
    el.addEventListener("mouseleave", onMouseLeave);
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      el.removeEventListener("touchstart", onStart);
      el.removeEventListener("touchmove", onMove);
      el.removeEventListener("touchend", onEnd);
      el.removeEventListener("touchcancel", onEnd);
      el.removeEventListener("mousedown", onMouseDown);
      el.removeEventListener("mousemove", onMouseMove);
      el.removeEventListener("mouseup", onMouseUp);
      el.removeEventListener("mouseleave", onMouseLeave);
      el.removeEventListener("wheel", onWheel);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [onActivity]);

  return (
    <div ref={ref} className="gt-trackpad" style={{ touchAction: "none" }}>
      <span className="gt-trackpad__hint">
        Drag to move · tap to click · hold ↑↓ (or two fingers) to scroll
      </span>
    </div>
  );
}
