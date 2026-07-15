import { useEffect, useRef } from "react";
// @ts-expect-error — @mkkellogg/gaussian-splats-3d ships no type declarations
import * as GaussianSplats3D from "@mkkellogg/gaussian-splats-3d";
import { dark } from "@groundtruth/tokens";
import { useHandNav } from "./useHandNav";
import { splatNav } from "./navState";
import { patchDisperse, type DisperseHandle } from "./disperse";

/**
 * Embeddable Gaussian-splat stage — fills its (positioned) parent, no tuning chrome. Renders the
 * real TUM campus gaussians, slowly auto-orbits when idle, and disperses on the open-palm gesture
 * (✊ reassembles). This is the SplatNavExperiment's engine minus the framing HUD, for the
 * combined showreel backdrop. Preview via /?exp=showreel2.
 *
 * We drive the camera ourselves (built-in controls off) as a horizontal orbit around the campus
 * at a fixed elevation. The orbit params are the user-tuned view ([96, -51.7, -51.3] looking at
 * [-1.5, -1, -4.5], up -Y) decomposed into radius / height / azimuth so the auto-spin passes
 * through exactly that framing.
 */
const PLY_URL = "/splat/tum-campus.ply";
const CAMERA_UP: [number, number, number] = [0, -1, 0];
const TARGET = { x: -1.5, y: -1, z: -4.5 };
const R_H = 108; // horizontal orbit radius (XZ plane)
const H_UP = 50.7; // camera height above the target along -Y
const THETA0 = -0.446; // initial azimuth — reproduces the baked framing
const SPIN = 0.1; // rad/sec idle auto-orbit (pauses while a hand is steering)
const ELEV_GAIN = 55; // world-units of camera height per unit of hand-driven pitch
const DISPERSE_EASE = 0.16;
const CLAMP = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

const posAt = (theta: number): [number, number, number] => [
  TARGET.x + R_H * Math.cos(theta),
  TARGET.y - H_UP,
  TARGET.z + R_H * Math.sin(theta),
];

export function SplatStage({
  amp = 60,
  autoRotate = true,
  aimShift = 0,
}: {
  amp?: number;
  autoRotate?: boolean;
  /** world-units to pan the camera aim so the campus sits off-centre on a full-screen canvas
   *  (positive → campus shifts right). Keeps the canvas full-bleed so disperse fills the screen. */
  aimShift?: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const { videoRef } = useHandNav();

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let disposed = false;
    let raf = 0;
    let last = performance.now();
    // the hand-orbit shares splatNav (useHandNav writes yaw/pitch); seed it to the baked framing
    splatNav.yaw = THETA0;
    splatNav.pitch = 0;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const viewer: any = new GaussianSplats3D.Viewer({
      rootElement: el,
      sharedMemoryForWorkers: false,
      useBuiltInControls: false, // we drive the camera (auto-orbit + gesture disperse)
      cameraUp: CAMERA_UP,
      initialCameraPosition: posAt(THETA0),
      initialCameraLookAt: [TARGET.x, TARGET.y, TARGET.z],
    });

    viewer
      .addSplatScene(PLY_URL, { splatAlphaRemovalThreshold: 5, showLoadingUI: false })
      .then(() => {
        if (disposed) return;
        viewer.start();
        let disperse: DisperseHandle | null = null;
        try {
          disperse = patchDisperse(viewer.getSplatMesh?.(), amp);
        } catch {
          /* nav still fine without disperse */
        }

        const tick = () => {
          if (disposed) return;
          raf = requestAnimationFrame(tick);
          const cam = viewer.camera;
          if (!cam) return;
          const now = performance.now();
          const dt = CLAMP((now - last) / 1000, 0.001, 0.05);
          last = now;

          if (!disperse) disperse = patchDisperse(viewer.getSplatMesh?.(), amp);
          if (disperse) {
            disperse.uniform.value +=
              (splatNav.disperseTarget - disperse.uniform.value) * DISPERSE_EASE;
          }

          // hand steers the orbit (useHandNav → splatNav.yaw/pitch); auto-orbit advances the
          // azimuth only while no hand is present, so the two hand off seamlessly.
          if (autoRotate && !splatNav.handPresent) splatNav.yaw += SPIN * dt;
          const theta = splatNav.yaw;
          const px = TARGET.x + R_H * Math.cos(theta);
          const py = TARGET.y - (H_UP + splatNav.pitch * ELEV_GAIN);
          const pz = TARGET.z + R_H * Math.sin(theta);
          cam.position.set(px, py, pz);
          cam.up.set(CAMERA_UP[0], CAMERA_UP[1], CAMERA_UP[2]);

          // pan the aim horizontally so the campus sits off-centre-right on a full-screen canvas.
          // right vector (up = -Y) = (fwd.z, 0, -fwd.x); aiming LEFT of the target shifts it right.
          let ax = TARGET.x;
          let az = TARGET.z;
          if (aimShift) {
            const fx = TARGET.x - px;
            const fz = TARGET.z - pz;
            const rl = Math.hypot(fz, fx) || 1;
            ax = TARGET.x - (fz / rl) * aimShift;
            az = TARGET.z - (-fx / rl) * aimShift;
          }
          cam.lookAt(ax, TARGET.y, az);

          // camera moves every frame while spinning; force a render so the sort keeps up
          if (autoRotate || (disperse && disperse.uniform.value > 0.002)) {
            viewer.forceRenderNextFrame?.();
          }
        };
        raf = requestAnimationFrame(tick);
      })
      .catch((e: unknown) => console.error("[splatstage] load failed", e));

    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      try {
        viewer?.dispose?.();
      } catch {
        /* not fully initialised on fast unmount */
      }
    };
  }, [amp, autoRotate]);

  return (
    <div className="absolute inset-0" style={{ background: dark.bg }}>
      <div ref={ref} className="absolute inset-0" />
      {/* hidden webcam feed that drives the disperse gesture */}
      <video ref={videoRef} style={{ display: "none" }} playsInline muted />
    </div>
  );
}
