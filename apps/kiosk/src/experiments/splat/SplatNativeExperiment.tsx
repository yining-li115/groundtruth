import { useEffect, useRef } from "react";
// @ts-expect-error — @mkkellogg/gaussian-splats-3d ships no type declarations
import * as GaussianSplats3D from "@mkkellogg/gaussian-splats-3d";

/**
 * Native Gaussian-splat render (our own three.js, no iframe) of the TUM Main Campus scan.
 * Loads the cropped/upright 3DGS .ply and renders the REAL gaussians via
 * @mkkellogg/gaussian-splats-3d's built-in Viewer (orbit + zoom + pan). Preview at
 * /?exp=splat3d.
 *
 * FRAMING WORKFLOW: drag/scroll to the exact view you want, then click "📋 Copy camera"
 * (bottom-left) — it copies the camera position + lookAt to your clipboard and logs them.
 * Paste them back and they become the default here (no more guessing angles).
 */
const PLY_URL = "/splat/tum-campus.ply";

export function SplatNativeExperiment() {
  const ref = useRef<HTMLDivElement>(null);
  const hudRef = useRef<HTMLPreElement>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const viewerRef = useRef<any>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let disposed = false;
    let raf = 0;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const viewer: any = new GaussianSplats3D.Viewer({
      rootElement: el,
      sharedMemoryForWorkers: false, // avoid needing COOP/COEP headers on the dev server
      // Cropped to just the TUM Hauptgebäude, rotated upright. The scan's roofs face -Y, so
      // we look from the -Y side. Clean near-top-down (north = -Z up), so it reads like the
      // roofmap instead of a keystoned low-oblique. Complex centred near (0.5, -1, -4.5).
      cameraUp: [0, 0, -1],
      initialCameraPosition: [-1.5, -105, 3],
      initialCameraLookAt: [-1.5, -1, -4.5],
    });
    viewerRef.current = viewer;

    const fmt = (v: { x: number; y: number; z: number }) =>
      `[${v.x.toFixed(1)}, ${v.y.toFixed(1)}, ${v.z.toFixed(1)}]`;

    viewer
      .addSplatScene(PLY_URL, { splatAlphaRemovalThreshold: 5, showLoadingUI: true })
      .then(() => {
        if (disposed) return;
        viewer.start();
        // live camera readout so you can dial in the framing yourself
        const tick = () => {
          if (disposed) return;
          raf = requestAnimationFrame(tick);
          const cam = viewer.camera;
          const tgt = viewer.controls?.target;
          if (cam && tgt && hudRef.current) {
            hudRef.current.textContent = `position: ${fmt(cam.position)}\nlookAt:   ${fmt(tgt)}`;
          }
        };
        raf = requestAnimationFrame(tick);
      })
      .catch((e: unknown) => console.error("[splat3d] load failed", e));

    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      try {
        viewer?.dispose?.();
      } catch {
        /* viewer may not be fully initialised on fast unmount */
      }
    };
  }, []);

  const copyCamera = () => {
    const v = viewerRef.current;
    if (!v?.camera || !v?.controls) return;
    const p = v.camera.position, t = v.controls.target;
    const text =
      `initialCameraPosition: [${p.x.toFixed(1)}, ${p.y.toFixed(1)}, ${p.z.toFixed(1)}],\n` +
      `initialCameraLookAt: [${t.x.toFixed(1)}, ${t.y.toFixed(1)}, ${t.z.toFixed(1)}],`;
    navigator.clipboard?.writeText(text);
    console.log("[splat3d] camera:\n" + text);
  };

  return (
    <div style={{ position: "fixed", inset: 0, background: "#000" }}>
      <div ref={ref} style={{ position: "absolute", inset: 0 }} />
      <div
        style={{
          position: "fixed",
          bottom: "1rem",
          left: "1rem",
          display: "flex",
          flexDirection: "column",
          gap: "0.5rem",
          alignItems: "flex-start",
          fontFamily: "var(--font-sans, monospace)",
          zIndex: 10,
        }}
      >
        <pre
          ref={hudRef}
          style={{
            margin: 0,
            padding: "0.5rem 0.6rem",
            fontSize: "0.72rem",
            lineHeight: 1.5,
            color: "#cfe0ff",
            background: "rgba(0,0,0,0.55)",
            borderRadius: "0.4rem",
            border: "1px solid rgba(255,255,255,0.15)",
          }}
        >
          position: …{"\n"}lookAt: …
        </pre>
        <button
          type="button"
          onClick={copyCamera}
          style={{
            padding: "0.4rem 0.8rem",
            fontSize: "0.78rem",
            color: "#fff",
            background: "rgba(58,58,240,0.85)",
            border: "0",
            borderRadius: "999px",
            cursor: "pointer",
          }}
        >
          📋 Copy camera
        </button>
      </div>
    </div>
  );
}
