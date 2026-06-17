import { useEffect, useRef } from "react";
import { socket } from "../lib/socket";
import {
  SENSITIVITY,
  CURSOR_ACCEL,
  CURSOR_MAX_GAIN,
  CURSOR_FOLLOW,
  SCROLL_SENSITIVITY,
  SCROLL_ACCEL,
  SCROLL_MAX_GAIN,
} from "../config";
import { useKioskStore } from "../state/store";
import { heroOrbit } from "../lib/heroInput";
import { scrollByPx } from "../lib/scroll";
import { setCursorPosition } from "../lib/cursorPosition";
import { navigate } from "../lib/navigate";

const clamp = (v: number, min: number, max: number) => Math.min(Math.max(v, min), max);
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
  const hovered = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const onMove = ({ dx, dy }: { dx: number; dy: number }) => {
      // Pointer ballistics (architecture §4 / design-system §6): a slow finger keeps the
      // base gain for precise aiming; a fast flick accelerates so one swipe can cross the
      // whole big screen. `screenScale` lifts the gain on a large kiosk display so the
      // same swipe travels proportionally further than it would on a dev laptop.
      const mag = Math.hypot(dx, dy);
      const screenScale = clamp(window.innerWidth / 1920, 1, 2.4);
      const gain = Math.min(
        CURSOR_MAX_GAIN * screenScale,
        SENSITIVITY * screenScale * (1 + mag * CURSOR_ACCEL),
      );
      target.current.x = clamp(target.current.x + dx * gain, 0, window.innerWidth);
      target.current.y = clamp(target.current.y + dy * gain, 0, window.innerHeight);
      // On the pinned home hero, moving the cursor also orbits the cloud (drag-to-look),
      // while the cursor stays usable for the MENU button.
      if (useKioskStore.getState().heroOrbitActive) {
        heroOrbit.touched = true;
      }
    };
    const onScroll = ({ dy }: { dy: number }) => {
      // Natural (phone-native) scrolling: two fingers UP moves content up → page scrolls
      // DOWN. `dy` is the raw finger delta (down = positive), so negate it. Routed through
      // Lenis so the page eases with it instead of fighting the smooth-scroll loop.
      // Ballistics: a fast two-finger flick accelerates to cross long pinned sections.
      const gain = Math.min(
        SCROLL_MAX_GAIN,
        SCROLL_SENSITIVITY * (1 + Math.abs(dy) * SCROLL_ACCEL),
      );
      scrollByPx(-dy * gain);
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
      // Controller "back" returns the website shell to the home screen (with the transition).
      navigate("home");
    };

    socket.on("kiosk:cursor.move", onMove);
    socket.on("kiosk:cursor.scroll", onScroll);
    socket.on("kiosk:cursor.tap", onTap);
    socket.on("kiosk:cursor.back", onBack);

    let raf = 0;
    const loop = () => {
      pos.current.x += (target.current.x - pos.current.x) * CURSOR_FOLLOW;
      pos.current.y += (target.current.y - pos.current.y) * CURSOR_FOLLOW;
      // Publish for cursor-following effects (LiquidEther hero fluid).
      setCursorPosition(pos.current.x, pos.current.y);
      const node = ringRef.current;
      if (node) {
        node.style.transform = `translate3d(${pos.current.x - SIZE / 2}px, ${pos.current.y - SIZE / 2}px, 0)`;
      }
      // On the pinned home hero, the point cloud orbits to follow the cursor.
      if (useKioskStore.getState().heroOrbitActive) {
        heroOrbit.aim(pos.current.x / window.innerWidth, pos.current.y / window.innerHeight);
      }
      // Drive hover effects from the phone cursor (no native :hover on the kiosk): toggle
      // `.is-hover` on the [data-hover] element under the cursor (e.g. Spotlight cards).
      const under = document.elementFromPoint(pos.current.x, pos.current.y);
      const hot = (under?.closest("[data-hover]") as HTMLElement | null) ?? null;
      if (hot !== hovered.current) {
        hovered.current?.classList.remove("is-hover");
        hot?.classList.add("is-hover");
        hovered.current = hot;
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
      hovered.current?.classList.remove("is-hover");
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
