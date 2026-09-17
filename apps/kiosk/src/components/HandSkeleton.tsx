import { useEffect, useRef } from "react";
import { HAND_BONES, type Landmark } from "../lib/vision/mediapipe";

/**
 * Draws the tracked hand as a skeleton over the scene.
 *
 * This is feedback, not decoration: touchless control is unreadable without it. A visitor
 * waving at a wall has no idea whether the screen can see them, which hand it locked onto, or
 * why it stopped responding — the skeleton answers all three at a glance. Gesture semantics
 * deliberately live outside this renderer: the same stable owner drives pointer, UI and scene
 * sessions, so the drawing must not invent a second one-finger/two-finger vocabulary.
 *
 * Mirrored horizontally to match the visitor's own view: raise your right hand, the skeleton
 * appears on the right.
 */
const CANVAS_W = 320;
const CANVAS_H = 240;

/** Structural on purpose: the overlay can render the unified scene input without owning it. */
export interface HandSkeletonSource {
  hands: Landmark[][];
  active?: boolean;
}

export function HandSkeleton({
  source,
  className,
  style,
}: {
  source: { readonly current: HandSkeletonSource };
  className?: string;
  style?: React.CSSProperties;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    let raf = 0;

    const px = (p: Landmark) => [(1 - p.x) * canvas.width, p.y * canvas.height] as const;

    const draw = () => {
      raf = requestAnimationFrame(draw);
      const f = source.current;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      const hands = f?.hands;
      if (!hands?.length) return;

      ctx.lineCap = "round";
      ctx.lineJoin = "round";

      for (const lm of hands) {
        if (lm.length < 21) continue;
        ctx.strokeStyle = "rgb(255 255 255 / 0.65)";
        ctx.lineWidth = 2.5;
        for (const [a, b] of HAND_BONES) {
          const p = lm[a];
          const q = lm[b];
          if (!p || !q) continue;
          ctx.strokeStyle = f.active
            ? "rgb(255 255 255 / 0.9)"
            : "rgb(255 255 255 / 0.65)";
          const [x0, y0] = px(p);
          const [x1, y1] = px(q);
          ctx.beginPath();
          ctx.moveTo(x0, y0);
          ctx.lineTo(x1, y1);
          ctx.stroke();
        }

        ctx.fillStyle = "rgb(255 255 255 / 0.9)";
        for (const p of lm) {
          const [x, y] = px(p);
          ctx.beginPath();
          ctx.arc(x, y, 2.6, 0, Math.PI * 2);
          ctx.fill();
        }
      }

    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [source]);

  return (
    <canvas
      ref={canvasRef}
      width={CANVAS_W}
      height={CANVAS_H}
      className={className}
      style={style}
      aria-hidden
    />
  );
}
