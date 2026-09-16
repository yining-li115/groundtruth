import { useEffect, useRef } from "react";
import type { HandPointer } from "../lib/vision/handPointer";
import { JOINT } from "../lib/vision/mediapipe";
import "./camPreview.css";

/**
 * The camera, as the pointer sees it — `?cam=1` (also on with `?visionDebug=1`).
 *
 * The one picture the HUD could not give. Every complaint from the wall about reach is a
 * question about GEOMETRY — where is the hand in the frame, where is the box, where does the
 * screen's edge fall in the picture — and text cannot answer it. "I can't reach the bottom
 * right" and "a centimetre moves the cursor half a screen" are both answered instantly by
 * looking at this: either the hand is leaving the picture, or the face the box is scaled from
 * is not the visitor's face at all (a poster, a photo on the wall behind, a colleague further
 * back), and the box has been built to a stranger's size in a stranger's place.
 *
 * Drawn mirrored, like a mirror, so a hand moved to the right moves to the right.
 *   white box     the interaction box — the screen, in the picture
 *   blue box      the face the scale comes from (dashed while coasting on memory)
 *   white dot     the wrist — the point the cursor is driven from
 *   dashed edge   the frame margin a box edge is never put beyond
 */
export const CAM_PREVIEW =
  typeof window !== "undefined" &&
  (() => {
    const p = new URLSearchParams(location.search);
    return p.get("cam") === "1" || p.get("visionDebug") === "1";
  })();

export function CamPreview({
  video,
  pointer,
}: {
  video: React.RefObject<HTMLVideoElement | null>;
  pointer: { current: HandPointer };
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    if (!CAM_PREVIEW) return;
    let raf = 0;
    const draw = () => {
      raf = requestAnimationFrame(draw);
      const canvas = canvasRef.current;
      const v = video.current;
      const ctx = canvas?.getContext("2d");
      if (!canvas || !ctx) return;
      const s = pointer.current.state;
      const { width: w, height: h } = canvas;
      ctx.save();
      ctx.clearRect(0, 0, w, h);
      // Mirror the whole drawing, so every coordinate below is raw frame space.
      ctx.translate(w, 0);
      ctx.scale(-1, 1);
      if (v && v.readyState >= 2) ctx.drawImage(v, 0, 0, w, h);
      else {
        ctx.fillStyle = "rgba(0,0,0,0.6)";
        ctx.fillRect(0, 0, w, h);
      }

      // the interaction box — the screen, in the picture
      const b = s.box;
      if (b) {
        ctx.strokeStyle = "rgba(255,255,255,0.95)";
        ctx.lineWidth = 2;
        ctx.strokeRect(b.x0 * w, b.y0 * h, b.w * w, b.h * h);
      }
      // the face the scale comes from
      const f = s.face;
      if (f) {
        ctx.strokeStyle = "rgba(122,122,255,0.95)";
        ctx.lineWidth = 2;
        ctx.setLineDash(s.faceHeld ? [4, 4] : []);
        ctx.strokeRect((f.cx - f.w / 2) * w, (f.cy - f.h / 2) * h, f.w * w, f.h * h);
        ctx.setLineDash([]);
      }
      // every tracked hand's wrist, the leading one filled
      s.hands.forEach((lm, i) => {
        const p = lm[JOINT.wrist];
        if (!p) return;
        ctx.beginPath();
        ctx.arc(p.x * w, p.y * h, 5, 0, Math.PI * 2);
        ctx.fillStyle = i === 0 ? "rgba(255,255,255,0.95)" : "rgba(255,255,255,0.4)";
        ctx.fill();
      });
      ctx.restore();

      // the readout, un-mirrored
      ctx.fillStyle = "rgba(0,0,0,0.55)";
      ctx.fillRect(0, h - 34, w, 34);
      ctx.fillStyle = "#fff";
      ctx.font = "11px system-ui, sans-serif";
      const fw = f ? `${(f.w * s.frame.w).toFixed(0)}px` : "—";
      const bw = b ? `${(b.w * s.frame.w).toFixed(0)}×${(b.h * s.frame.h).toFixed(0)}px` : "—";
      ctx.fillText(
        `face ${fw}${s.faceHeld ? " (held)" : ""}  box ${bw}${b?.shifted ? " shifted" : ""}${
          b?.clamped ? " CLAMPED" : ""
        }  ${s.conf.reason}`,
        6,
        h - 20,
      );
      ctx.fillText(
        `wrist ${s.hands[0]?.[JOINT.wrist] ? `${(s.hands[0][JOINT.wrist]!.x * 100).toFixed(0)}%,${(s.hands[0][JOINT.wrist]!.y * 100).toFixed(0)}%` : "—"}  palm ${
          Number.isFinite(s.palmPx) ? s.palmPx.toFixed(0) : "—"
        }px  ${s.frame.w}×${s.frame.h} @${s.fps.toFixed(0)}`,
        6,
        h - 7,
      );
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [video, pointer]);

  if (!CAM_PREVIEW) return null;
  return <canvas ref={canvasRef} className="gt-cam-preview" width={480} height={270} aria-hidden />;
}
