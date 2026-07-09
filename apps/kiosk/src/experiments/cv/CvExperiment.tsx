import { Suspense, lazy, useRef } from "react";
import { useHandHeadControl } from "../../lib/vision/useHandHeadControl";
import { camReadout } from "./SplatCloud";
import "./cv.css";

// The point cloud is the baked TUM-campus splat (photoreal). Lazy — three.js is heavy.
const SplatCloud = lazy(() =>
  import("./SplatCloud").then((m) => ({ default: m.SplatCloud })),
);

/**
 * CV interaction experiment — one hand controls everything (touchless):
 *   - Open palm → disperse · Closed fist → reassemble
 *   - Move the hand → orbit the cloud (joystick: off-centre = spin, centre = stop)
 * Preview at /?exp=cv. Destined for the idle showreel.
 */
export function CvExperiment() {
  // 1 = assembled, 0 = dispersed. Gestures ease this; the scene eases toward it again.
  const progress = useRef(1);
  const { videoRef, status, error, hud } = useHandHeadControl(progress);

  // Framing aid: orbit with the mouse to the view you want, click to copy the camera.
  const copyCamera = () => {
    const p = camReadout.pos, t = camReadout.target;
    const text =
      `position: [${p.map((v) => v.toFixed(1)).join(", ")}], ` +
      `up: [${camReadout.up.join(", ")}], lookAt: [${t.map((v) => v.toFixed(1)).join(", ")}]`;
    navigator.clipboard?.writeText(text);
    console.log("[cv] camera:\n" + text);
  };

  return (
    // Dark theme: the photoreal scan reads far better on a dark ground.
    <div className="cv-root" data-theme="dark">
      <Suspense fallback={null}>
        <SplatCloud progressRef={progress} orbit />
      </Suspense>

      {/* Camera preview + debug HUD (dev only — will not ship in the showreel). */}
      <div className="cv-hud">
        <video ref={videoRef} className="cv-hud__video" playsInline muted />
        <div className="cv-hud__readout">
          <div className={`cv-hud__status cv-hud__status--${status}`}>
            {status === "loading" && "loading models…"}
            {status === "running" && "running"}
            {status === "error" && `error: ${error ?? "unknown"}`}
            {status === "idle" && "idle"}
          </div>
          <div>hand: {hud.hand ? `${hud.hand.label} (${hud.hand.score.toFixed(2)})` : "—"}</div>
          <div>progress→ {hud.progressTarget.toFixed(2)}</div>
          <div>{hud.fps.toFixed(0)} fps</div>
          <button type="button" className="cv-hud__copy" onClick={copyCamera}>
            📋 copy camera
          </button>
        </div>
      </div>

      <div className="cv-help">☝️ point &amp; move finger = rotate · ✋ open palm = disperse · ✊ fist = reassemble</div>
    </div>
  );
}
