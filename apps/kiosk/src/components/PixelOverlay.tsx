import { useEffect, useRef, type CSSProperties } from "react";
import { registerPixelCells } from "../lib/pixelTransition";
import "./pixelOverlay.css";

// 17×9 ≈ square cells on a landscape kiosk display (matches the Codrops demo-4 grid).
const ROWS = 9;
const COLS = 17;

/** The persistent pixel-transition cover. Mounted once at the app root; sits above everything. */
export function PixelOverlay() {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!ref.current) return;
    const cells = Array.from(ref.current.querySelectorAll<HTMLElement>(":scope > div"));
    registerPixelCells(cells, ROWS, COLS);
    return () => registerPixelCells([], ROWS, COLS);
  }, []);

  return (
    <div
      ref={ref}
      className="pixel-overlay"
      style={{ "--columns": COLS, "--rows": ROWS } as CSSProperties}
      aria-hidden="true"
    >
      {Array.from({ length: ROWS * COLS }).map((_, i) => (
        <div key={i} />
      ))}
    </div>
  );
}
