import { useCallback, useEffect, useRef, useState } from "react";
import { LegoAvatar } from "../../components/lego/LegoAvatar";
import "./lego.css";

/**
 * ?exp=lego — standalone preview of the LegoAvatar component on a real photo. Thin wrapper:
 * the effect itself lives in components/lego/LegoAvatar.tsx. Scroll or drag the slider to
 * resize bricks; move the cursor over the face to melt the bricks back into the photo.
 *
 * Knobs: ?sub=<n> brick count; ?src=<url> swap the photo.
 */

const SUB_MIN = 6;
const SUB_MAX = 80;
const params = new URLSearchParams(window.location.search);

export function LegoExperiment() {
  const src = params.get("src") || "/lego/face.jpg";
  const initial = Number(params.get("sub")) || 24;
  // subRef is the live value the shader reads each frame; `sub` state is only for the label.
  const subRef = useRef(initial);
  const [sub, setSub] = useState(initial);
  const apply = useCallback((v: number) => {
    const c = Math.max(SUB_MIN, Math.min(SUB_MAX, Math.round(v)));
    subRef.current = c; // drives the shader directly (no React/Canvas round-trip)
    setSub(c); // updates the label
  }, []);

  useEffect(() => {
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      apply(subRef.current + (e.deltaY < 0 ? 1 : -1));
    };
    window.addEventListener("wheel", onWheel, { passive: false });
    return () => window.removeEventListener("wheel", onWheel);
  }, [apply]);

  return (
    <div className="lego-root">
      <div className="lego-stage">
        <LegoAvatar src={src} subRef={subRef} interactive />
      </div>

      <div className="lego-panel">
        <label className="lego-label">
          Bricks: {sub}×{sub}
          <input
            type="range"
            min={SUB_MIN}
            max={SUB_MAX}
            step={1}
            value={sub}
            onChange={(e) => apply(Number(e.target.value))}
          />
        </label>
        <span className="lego-hint">move the cursor over the face — bricks melt back to the photo</span>
      </div>
    </div>
  );
}
