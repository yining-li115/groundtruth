import { useEffect, useRef } from "react";
import { HAND_BONES, JOINT, type Landmark } from "../lib/vision/mediapipe";
import type { HandFlight } from "../lib/vision/useHandFlight";

/**
 * Draws the tracked hand as a skeleton over the scene.
 *
 * This is feedback, not decoration: touchless control is unreadable without it. A visitor
 * waving at a wall has no idea whether the screen can see them, which hand it locked onto, or
 * why it stopped responding — the skeleton answers all three at a glance. The pinch pair
 * (thumb + index) is drawn emphasised and joined, since that is the pair actually driving the
 * dolly.
 *
 * Mirrored horizontally to match the visitor's own view: raise your right hand, the skeleton
 * appears on the right.
 */
const CANVAS_W = 320;
const CANVAS_H = 240;
/** landmark index → which finger it belongs to (thumb 0 … pinky 4); -1 for the palm */
const FINGER_OF: Record<number, number> = {
  1: 0, 2: 0, 3: 0, 4: 0,
  5: 1, 6: 1, 7: 1, 8: 1,
  9: 2, 10: 2, 11: 2, 12: 2,
  13: 3, 14: 3, 15: 3, 16: 3,
  17: 4, 18: 4, 19: 4, 20: 4,
};

export function HandSkeleton({
  flight,
  className,
  style,
}: {
  flight: React.RefObject<HandFlight>;
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
      const f = flight.current;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      const hands = f?.hands;
      if (!hands?.length) return;

      ctx.lineCap = "round";
      ctx.lineJoin = "round";

      // Fingers that are OUT are drawn bright, curled ones dim — the gesture picks the mode,
      // so a visitor has to be able to see which fingers the tracker thinks are raised.
      const fingers = f.fingers ?? [];
      const litFor = (i: number) =>
        fingers.length === 5 ? (fingers[FINGER_OF[i] ?? -1] ?? true) : true;

      for (const lm of hands) {
        if (lm.length < 21) continue;
        ctx.strokeStyle = "rgb(255 255 255 / 0.65)";
        ctx.lineWidth = 2.5;
        for (const [a, b] of HAND_BONES) {
          const p = lm[a];
          const q = lm[b];
          if (!p || !q) continue;
          ctx.strokeStyle =
            hands.length === 1 && !litFor(b)
              ? "rgb(255 255 255 / 0.2)"
              : "rgb(255 255 255 / 0.75)";
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

      // The span between the two wrists, emphasised — this is the measurement the dolly
      // reads, so showing it is how a visitor learns that pulling apart moves them in.
      if (hands.length >= 2) {
        const a = hands[0]![JOINT.wrist];
        const b = hands[1]![JOINT.wrist];
        if (a && b) {
          const [ax, ay] = px(a);
          const [bx, by] = px(b);
          const hot = Math.abs(f.dolly) > 0.05;
          ctx.strokeStyle = hot ? "rgb(58 58 240 / 0.95)" : "rgb(255 255 255 / 0.3)";
          ctx.lineWidth = hot ? 3.5 : 2;
          ctx.setLineDash([6, 6]);
          ctx.beginPath();
          ctx.moveTo(ax, ay);
          ctx.lineTo(bx, by);
          ctx.stroke();
          ctx.setLineDash([]);
        }
      }
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [flight]);

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
