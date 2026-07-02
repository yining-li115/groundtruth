import { useEffect, useRef, useState } from "react";
import { LegoAvatar } from "./LegoAvatar";
import "./legoLab.css";

/**
 * LegoAvatarLab — a dev/test overlay to try the LEGO avatar effect on YOUR OWN photo before
 * real portraits exist. Upload an image → see it LEGO-fied (cursor melts it back to the
 * photo) → tune brick size → download the rendered PNG to keep. Opened from a test button on
 * the Team page; remove that button once real avatars land.
 *
 * "Save" = download the rendered canvas as PNG (no backend yet); drop it into
 * content/media/people/ later and reference it from people.json.
 */

const SUB_MIN = 6;
const SUB_MAX = 80;
const DEFAULT_SRC = "/lego/face.jpg";

export function LegoAvatarLab({ onClose }: { onClose: () => void }) {
  const [src, setSrc] = useState(DEFAULT_SRC);
  const [fileName, setFileName] = useState<string | null>(null);
  const subRef = useRef(28); // live value read by the shader each frame
  const [sub, setSub] = useState(28); // label only
  const stageRef = useRef<HTMLDivElement>(null);
  const objectUrl = useRef<string | null>(null);

  const apply = (v: number) => {
    const c = Math.max(SUB_MIN, Math.min(SUB_MAX, Math.round(v)));
    subRef.current = c;
    setSub(c);
  };

  // Wheel over the stage adjusts brick size (native range inputs ignore the wheel).
  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      apply(subRef.current + (e.deltaY < 0 ? 1 : -1));
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  // Esc closes; revoke any object URL on unmount.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      if (objectUrl.current) URL.revokeObjectURL(objectUrl.current);
    };
  }, [onClose]);

  const onUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (objectUrl.current) URL.revokeObjectURL(objectUrl.current);
    const url = URL.createObjectURL(file);
    objectUrl.current = url;
    setSrc(url);
    setFileName(file.name);
  };

  const onDownload = () => {
    // preserveBuffer keeps the WebGL drawing buffer readable for toDataURL.
    const canvas = stageRef.current?.querySelector("canvas");
    if (!canvas) return;
    const a = document.createElement("a");
    a.download = `lego-${(fileName || "avatar").replace(/\.[^.]+$/, "")}.png`;
    a.href = canvas.toDataURL("image/png");
    a.click();
  };

  return (
    <div className="lab-overlay" onClick={onClose}>
      <div className="lab-panel" onClick={(e) => e.stopPropagation()}>
        <header className="lab-head">
          <h2 className="lab-title">LEGO avatar — test</h2>
          <button type="button" className="lab-close" aria-label="Close" onClick={onClose}>
            ✕
          </button>
        </header>

        <div className="lab-stage" ref={stageRef}>
          <LegoAvatar src={src} subRef={subRef} interactive preserveBuffer />
        </div>

        <div className="lab-controls">
          <label className="lab-btn lab-btn--solid">
            Upload photo
            <input type="file" accept="image/*" onChange={onUpload} hidden />
          </label>
          <label className="lab-bricks">
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
          <button type="button" className="lab-btn lab-btn--outline" onClick={onDownload}>
            Save PNG
          </button>
        </div>

        <p className="lab-hint">
          {fileName ? `Showing: ${fileName}` : "Using the placeholder photo — upload your own."}{" "}
          · move the cursor over the face to melt the bricks · scroll to resize bricks
        </p>
      </div>
    </div>
  );
}
