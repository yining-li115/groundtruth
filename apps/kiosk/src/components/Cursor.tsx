import { useEffect, useRef } from "react";
import { socket } from "../lib/socket";
import { SENSITIVITY } from "../config";

const clamp = (v: number, min: number, max: number) => Math.min(Math.max(v, min), max);
/** Inertia: actual position eases toward target each frame (design-system §6). */
const FOLLOW = 0.2;
const SIZE = 28;

/**
 * The on-screen pointer the kiosk renders. It is the authority for cursor position
 * (architecture §4): the controller streams only relative deltas; we integrate them
 * with smoothing so the cursor never snaps and network jitter is hidden. The kiosk may
 * keep heavy motion on regardless of reduced-motion (CLAUDE.md rule 5).
 */
export function Cursor() {
  const ringRef = useRef<HTMLDivElement>(null);
  const rippleRef = useRef<HTMLDivElement>(null);
  const target = useRef({ x: window.innerWidth / 2, y: window.innerHeight / 2 });
  const pos = useRef({ x: target.current.x, y: target.current.y });

  useEffect(() => {
    const onMove = ({ dx, dy }: { dx: number; dy: number }) => {
      target.current.x = clamp(target.current.x + dx * SENSITIVITY, 0, window.innerWidth);
      target.current.y = clamp(target.current.y + dy * SENSITIVITY, 0, window.innerHeight);
    };
    const onScroll = ({ dy }: { dy: number }) => {
      window.scrollBy({ top: dy * SENSITIVITY, behavior: "auto" });
    };
    const onTap = () => {
      // Cursor has pointer-events:none, so this hits the UI underneath.
      const el = document.elementFromPoint(pos.current.x, pos.current.y);
      if (el instanceof HTMLElement) el.click();
      const ripple = rippleRef.current;
      if (ripple) {
        ripple.style.animation = "none";
        void ripple.offsetWidth; // restart the animation
        ripple.style.animation = "gt-cursor-tap 0.4s ease-out";
      }
    };
    const onBack = () => {
      // Section navigation arrives in Phase 2; nothing to go back to yet.
    };

    socket.on("kiosk:cursor.move", onMove);
    socket.on("kiosk:cursor.scroll", onScroll);
    socket.on("kiosk:cursor.tap", onTap);
    socket.on("kiosk:cursor.back", onBack);

    let raf = 0;
    const loop = () => {
      pos.current.x += (target.current.x - pos.current.x) * FOLLOW;
      pos.current.y += (target.current.y - pos.current.y) * FOLLOW;
      const node = ringRef.current;
      if (node) {
        node.style.transform = `translate3d(${pos.current.x - SIZE / 2}px, ${pos.current.y - SIZE / 2}px, 0)`;
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);

    return () => {
      socket.off("kiosk:cursor.move", onMove);
      socket.off("kiosk:cursor.scroll", onScroll);
      socket.off("kiosk:cursor.tap", onTap);
      socket.off("kiosk:cursor.back", onBack);
      cancelAnimationFrame(raf);
    };
  }, []);

  return (
    <div
      ref={ringRef}
      aria-hidden
      className="gt-cursor"
      style={{ width: SIZE, height: SIZE }}
    >
      <div ref={rippleRef} className="gt-cursor__ripple" />
    </div>
  );
}
