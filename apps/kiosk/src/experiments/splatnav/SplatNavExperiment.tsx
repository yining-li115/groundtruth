import { useEffect, useRef } from "react";
// @ts-expect-error — @mkkellogg/gaussian-splats-3d ships no type declarations
import * as GaussianSplats3D from "@mkkellogg/gaussian-splats-3d";
import { dark } from "@groundtruth/tokens";
import { useHandNav } from "./useHandNav";
import { splatNav } from "./navState";
import { patchDisperse, type DisperseHandle } from "./disperse";

/**
 * Gaussian-splat MAP — the real TUM Main Campus scan rendered as actual gaussians
 * (@mkkellogg/gaussian-splats-3d, no iframe), with a GESTURE disperse and mouse navigation.
 *
 *   🖐 open palm → disperse the gaussians · ✊ fist → reassemble · D key → toggle disperse
 *   🖱 drag → orbit · scroll → zoom   (built-in OrbitControls; hand-orbit comes back later)
 *
 * FRAMING WORKFLOW (this is a tuning harness right now): the HUD shows the live camera
 * position / lookAt / up. Orbit with the mouse to the view you want, hit "📋 Copy camera", and
 * the values land on your clipboard — paste them back as the defaults (or via ?pos=&look=).
 *
 * The disperse is a GPU vertex-offset patched into the splat material — see `disperse.ts`.
 * The scan crop is UNCHANGED — the same cropped `tum-campus.ply` used at /?exp=splat3d.
 * Preview at /?exp=splatnav.
 */
const PLY_URL = "/splat/tum-campus-web.ply"; // decimated 400k/no-SH, committed for deploy

const DISPERSE_AMP = 60; // default scatter box half-size in scan world-units (tune with [ / ])
const DISPERSE_EASE = 0.16; // how fast the scatter chases its 0/1 target (higher = snappier)
const CLAMP = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

const qs = new URLSearchParams(window.location.search);
const parseVec3 = (s: string | null): [number, number, number] | null => {
  if (!s) return null;
  const p = s.split(",").map(Number);
  return p.length === 3 && p.every(Number.isFinite) ? [p[0]!, p[1]!, p[2]!] : null;
};

// live-tunable via ?amp=NN and the [ / ] keys — dial the explosion size without a rebuild
const AMP0 = (() => {
  const p = Number(qs.get("amp"));
  return Number.isFinite(p) && p > 0 ? p : DISPERSE_AMP;
})();

// The scan's true vertical axis is -Y (roofs face -Y), so -Y is the natural orbit "up" — the
// building stands upright and dragging up/down tilts eye-level↔top (not the -Z roof-map view).
// Override for experimentation with ?up=z | ?up=x.
const CAMERA_UP: [number, number, number] =
  qs.get("up") === "z" ? [0, 0, -1] : qs.get("up") === "x" ? [-1, 0, 0] : [0, -1, 0];
// baked initial view (user-tuned via the Copy-camera HUD): an oblique 3/4 aerial of the block
const CAM_POS = parseVec3(qs.get("pos")) ?? [96, -51.7, -51.3];
const CAM_LOOK = parseVec3(qs.get("look")) ?? [-1.5, -1, -4.5];

export function SplatNavExperiment() {
  const ref = useRef<HTMLDivElement>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const viewerRef = useRef<any>(null);
  const { videoRef, status, error, hud } = useHandNav();
  const stateRef = useRef<HTMLDivElement>(null);
  const camRef = useRef<HTMLPreElement>(null);

  const fmt = (v: { x: number; y: number; z: number }) =>
    `[${v.x.toFixed(1)}, ${v.y.toFixed(1)}, ${v.z.toFixed(1)}]`;

  const copyCamera = () => {
    const v = viewerRef.current;
    const p = v?.camera?.position;
    const t = v?.controls?.target;
    if (!p || !t) return;
    const text =
      `initialCameraPosition: [${p.x.toFixed(1)}, ${p.y.toFixed(1)}, ${p.z.toFixed(1)}],\n` +
      `initialCameraLookAt: [${t.x.toFixed(1)}, ${t.y.toFixed(1)}, ${t.z.toFixed(1)}],\n` +
      `cameraUp: [${CAMERA_UP.join(", ")}],\n` +
      `// or share: ?pos=${p.x.toFixed(1)},${p.y.toFixed(1)},${p.z.toFixed(1)}&look=${t.x.toFixed(1)},${t.y.toFixed(1)},${t.z.toFixed(1)}`;
    navigator.clipboard?.writeText(text);
    console.log("[splatnav] camera:\n" + text);
  };

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let disposed = false;
    let raf = 0;
    let keyCleanup: (() => void) | null = null;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const viewer: any = new GaussianSplats3D.Viewer({
      rootElement: el,
      sharedMemoryForWorkers: false, // avoid needing COOP/COEP headers on the dev server
      useBuiltInControls: true, // mouse orbit/zoom/pan — the tuning driver for now
      cameraUp: CAMERA_UP,
      initialCameraPosition: CAM_POS,
      initialCameraLookAt: CAM_LOOK,
    });
    viewerRef.current = viewer;

    viewer
      .addSplatScene(PLY_URL, { splatAlphaRemovalThreshold: 5, showLoadingUI: true })
      .then(() => {
        if (disposed) return;
        viewer.start(); // self-driven render/sort loop; it also updates OrbitControls

        // keep the camera above the horizon so it never dips under the scan (ugly underside)
        if (viewer.controls) viewer.controls.maxPolarAngle = 1.5; // ~86°

        // Patch the real splat material so the gaussians can scatter apart (disperse.ts).
        let disperse: DisperseHandle | null = null;
        try {
          disperse = patchDisperse(viewer.getSplatMesh?.(), AMP0);
        } catch (e) {
          console.warn("[splatnav] disperse patch failed (nav still works)", e);
        }

        // keyboard: [ / ] tune explosion size · D toggles disperse (for mouse-only testing)
        const onKey = (e: KeyboardEvent) => {
          if (disperse && (e.key === "[" || e.key === "]")) {
            const next = CLAMP(disperse.amp.value + (e.key === "]" ? 15 : -15), 0, 400);
            disperse.amp.value = next;
            console.log(`[splatnav] disperse amp = ${next}`);
          } else if (e.key === "d" || e.key === "D") {
            splatNav.disperseTarget = splatNav.disperseTarget > 0.5 ? 0 : 1;
          }
        };
        window.addEventListener("keydown", onKey);
        keyCleanup = () => window.removeEventListener("keydown", onKey);

        // our loop: ease the disperse uniform + refresh the readouts (camera is on OrbitControls)
        const tick = () => {
          if (disposed) return;
          raf = requestAnimationFrame(tick);

          // the splat material can finish building a frame late — retry the patch until it takes
          if (!disperse) {
            disperse = patchDisperse(viewer.getSplatMesh?.(), AMP0);
            if (disperse) console.info("[splatnav] disperse patch applied");
          }

          if (disperse) {
            const u = disperse.uniform;
            u.value += (splatNav.disperseTarget - u.value) * DISPERSE_EASE;
            if (u.value > 0.002) viewer.forceRenderNextFrame?.(); // splats move under a still camera
          }

          if (stateRef.current) {
            const pct = Math.round((disperse?.uniform.value ?? 0) * 100);
            const amp = Math.round(disperse?.amp.value ?? 0);
            stateRef.current.textContent = `${splatNav.gesture.padEnd(12)} · disperse ${pct}% · amp ${amp}`;
          }
          const cam = viewer.camera, tgt = viewer.controls?.target;
          if (cam && tgt && camRef.current) {
            camRef.current.textContent =
              `position: ${fmt(cam.position)}\nlookAt:   ${fmt(tgt)}\nup:       [${CAMERA_UP.join(", ")}]`;
          }
        };
        raf = requestAnimationFrame(tick);
      })
      .catch((e: unknown) => console.error("[splatnav] load failed", e));

    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      keyCleanup?.();
      try {
        viewer?.dispose?.();
      } catch {
        /* viewer may not be fully initialised on a fast unmount */
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div style={{ position: "fixed", inset: 0, background: dark.bg }}>
      <div ref={ref} style={{ position: "absolute", inset: 0 }} />

      {/* hidden webcam feed that drives the disperse gesture */}
      <video ref={videoRef} style={{ display: "none" }} playsInline muted />

      <div
        style={{
          position: "fixed",
          top: "1rem",
          left: "1rem",
          display: "flex",
          flexDirection: "column",
          gap: "0.5rem",
          alignItems: "flex-start",
          fontFamily: "var(--font-sans, monospace)",
          color: dark.text.primary,
          zIndex: 10,
        }}
      >
        <div
          style={{
            padding: "0.6rem 0.75rem",
            fontSize: "0.8rem",
            lineHeight: 1.6,
            background: "rgba(0,0,0,0.55)",
            borderRadius: "0.5rem",
            border: `1px solid ${dark.accent}`,
          }}
        >
          <strong>Gaussian-splat — navigate + disperse</strong>
          <br />
          🖱 drag → orbit · scroll → zoom
          <br />
          🖐 open palm / D key → disperse · ✊ fist → reassemble
          <br />
          <span style={{ opacity: 0.7 }}>[ / ] tune explosion size</span>
        </div>

        <div
          ref={stateRef}
          style={{
            padding: "0.4rem 0.6rem",
            fontFamily: "monospace",
            fontSize: "0.72rem",
            color: hud.handPresent ? dark.accent : dark.text.primary,
            background: "rgba(0,0,0,0.55)",
            borderRadius: "0.4rem",
          }}
        >
          None · disperse 0% · amp {Math.round(AMP0)}
        </div>

        {/* live camera axes — orbit to taste, then copy */}
        <pre
          ref={camRef}
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
          position: …{"\n"}lookAt: …{"\n"}up: …
        </pre>
        <button
          type="button"
          onClick={copyCamera}
          style={{
            padding: "0.4rem 0.8rem",
            fontSize: "0.78rem",
            color: dark.text.primary,
            background: dark.accent,
            border: "0",
            borderRadius: "999px",
            cursor: "pointer",
          }}
        >
          📋 Copy camera
        </button>

        <div style={{ fontSize: "0.68rem", opacity: 0.7 }}>
          camera {status}
          {status === "running" ? ` · ${Math.round(hud.fps)} fps` : ""}
          {error ? ` · ${error}` : ""}
        </div>
      </div>
    </div>
  );
}
