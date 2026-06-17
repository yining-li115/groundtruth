import type { PointerEvent } from "react";
import { socket } from "../lib/socket";

/**
 * Press-and-hold scroll buttons (↑ / ↓). Unlike two-finger scroll — whose speed rides on
 * finger velocity and arrives over a jittery wireless link in bursts — holding a button
 * tells the kiosk to scroll at a steady, locally-driven velocity, so it stays smooth
 * regardless of network jitter (architecture §4). The kiosk owns the actual motion; the
 * phone only streams "holding / released".
 *
 * Pointer events cover mouse + touch in one path; we capture the pointer on press so the
 * matching release fires on the same button even if the finger drifts off it.
 */
export function ScrollButtons({ onActivity }: { onActivity?: () => void }) {
  const hold = (dir: "up" | "down", active: boolean) => {
    socket.emit("ctrl:input.scrollHold", { dir, active });
    if (active) onActivity?.();
  };

  const press = (dir: "up" | "down") => (e: PointerEvent<HTMLButtonElement>) => {
    e.preventDefault();
    e.currentTarget.setPointerCapture?.(e.pointerId);
    hold(dir, true);
  };
  // One release path: fires on pointerup AND cancel (capture is lost either way), so the
  // kiosk can't get stuck scrolling if the touch ends off-button.
  const release = (dir: "up" | "down") => () => hold(dir, false);

  return (
    <div className="gt-scrollpad">
      <button
        type="button"
        className="gt-scrollbtn"
        aria-label="Scroll up"
        onPointerDown={press("up")}
        onLostPointerCapture={release("up")}
      >
        ↑
      </button>
      <button
        type="button"
        className="gt-scrollbtn"
        aria-label="Scroll down"
        onPointerDown={press("down")}
        onLostPointerCapture={release("down")}
      >
        ↓
      </button>
    </div>
  );
}
