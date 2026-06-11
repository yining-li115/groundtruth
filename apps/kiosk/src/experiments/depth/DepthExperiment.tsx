import { useEffect, useRef } from "react";
import { Engine } from "./Engine";
import "./depth.css";

/**
 * Atmospheric depth gallery EXPERIMENT (?exp=depth) — vendored port of Codrops'
 * houmahani/codrops-depth-gallery (MIT). Wheel/scroll moves the camera THROUGH a stack of
 * image planes in 3D depth; each plane's "mood" blends a GLSL background (color blobs + grain),
 * with velocity-reactive motion. Step 1 = core (Gallery + Background + Scroll); the particle
 * Trail and Labels are a follow-up. NOT wired into the home.
 */
export function DepthExperiment() {
  const stageRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    if (!canvasRef.current || !stageRef.current) return;
    const engine = new Engine(canvasRef.current, { overlayRoot: stageRef.current });
    engine.init().catch((error: unknown) => console.error("Depth engine init failed", error));
    return () => engine.dispose();
  }, []);

  return (
    <div className="depth-stage depth-stage--fixed" ref={stageRef}>
      <canvas className="depth-canvas" ref={canvasRef} />
    </div>
  );
}
