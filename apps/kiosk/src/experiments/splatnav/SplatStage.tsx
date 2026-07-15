import { useEffect, useRef } from "react";
// @ts-expect-error — @mkkellogg/gaussian-splats-3d ships no type declarations
import * as GaussianSplats3D from "@mkkellogg/gaussian-splats-3d";
import { dark } from "@groundtruth/tokens";
import { splatNav } from "./navState";
import { patchDisperse, type DisperseHandle } from "./disperse";

/**
 * Embeddable Gaussian-splat stage — fills its (positioned) parent, no chrome. Renders the real
 * TUM campus gaussians, auto-orbits, and lets a hand SPIN it (via splatNav.yaw, written by the
 * host's useHandNav). The `dispersed` prop drives the scatter: the host keeps it scattered while
 * idle and snaps it back together while someone is interacting.
 *
 * Camera: a horizontal orbit at fixed elevation around the campus, decomposed from the user-tuned
 * view ([96, -51.7, -51.3] → [-1.5, -1, -4.5], up -Y). Hand steers the azimuth (no up/down — the
 * old "navigation" tilt is dropped); auto-orbit advances it only while no hand is present.
 */
const PLY_URL = "/splat/tum-campus.ply";
const CAMERA_UP: [number, number, number] = [0, -1, 0];
const TARGET = { x: -1.5, y: -1, z: -4.5 };
const R_H = 108; // horizontal orbit radius (XZ plane)
const H_UP = 50.7; // camera height above the target along -Y
const THETA0 = -0.446; // initial azimuth — reproduces the baked framing
const SPIN = 0.1; // rad/sec idle auto-orbit (pauses while a hand is steering)
const ELEV_GAIN = 55; // world-units of camera height per unit of hand-driven pitch (up/down)
const ORBIT_EASE = 0.12; // low-pass the camera angle toward the (noisy) hand target → no jitter
const AIM_EASE = 0.08; // glide the campus between off-centre-right (idle) and centre (interacting)
const EASE_GATHER = 0.28; // snappy reassemble when someone greets the wall
const EASE_SCATTER = 0.1; // gentler drift back apart when they leave
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
  // read the latest aimShift from the loop without re-creating the viewer
  const aimRef = useRef(aimShift);
  aimRef.current = aimShift;

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let disposed = false;
    let raf = 0;
    let last = performance.now();
    // hand-orbit shares splatNav (host's useHandNav writes yaw/pitch); seed the baked framing
    splatNav.yaw = THETA0;
    splatNav.pitch = 0;
    // smoothed (rendered) angles — eased toward splatNav each frame to kill hand-tracking jitter
    let smYaw = THETA0;
    let smPitch = 0;
    let smAim = aimShift; // smoothed camera-aim pan (right → centre glide)

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const viewer: any = new GaussianSplats3D.Viewer({
      rootElement: el,
      sharedMemoryForWorkers: false,
      useBuiltInControls: false, // we drive the camera (auto-orbit + hand spin)
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
          /* stage still fine without disperse */
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
            const target = splatNav.disperseTarget; // host (auto) or gesture (manual) sets this
            const ease = target < disperse.uniform.value ? EASE_GATHER : EASE_SCATTER;
            disperse.uniform.value += (target - disperse.uniform.value) * ease;
          }

          // hand orbits the campus (useHandNav → splatNav.yaw left/right, splatNav.pitch up/down);
          // auto-orbit advances the azimuth only while no hand is present, so they hand off cleanly.
          if (autoRotate && !splatNav.handPresent) splatNav.yaw += SPIN * dt;
          // ease the rendered angle toward the (jittery) hand target — this low-pass is what
          // removes the shake; the raw splatNav.yaw/pitch can be noisy frame to frame.
          smYaw += (splatNav.yaw - smYaw) * ORBIT_EASE;
          smPitch += (splatNav.pitch - smPitch) * ORBIT_EASE;
          const px = TARGET.x + R_H * Math.cos(smYaw);
          const pz = TARGET.z + R_H * Math.sin(smYaw);
          cam.position.set(px, TARGET.y - (H_UP + smPitch * ELEV_GAIN), pz);
          cam.up.set(CAMERA_UP[0], CAMERA_UP[1], CAMERA_UP[2]);

          // pan the aim horizontally so the campus sits off-centre-right (idle) or centre
          // (interacting); glide between them. right vector (up = -Y) = (fwd.z, 0, -fwd.x).
          smAim += (aimRef.current - smAim) * AIM_EASE;
          const fx = TARGET.x - px;
          const fz = TARGET.z - pz;
          const rl = Math.hypot(fz, fx) || 1;
          const ax = TARGET.x - (fz / rl) * smAim;
          const az = TARGET.z - (-fx / rl) * smAim;
          cam.lookAt(ax, TARGET.y, az);

          viewer.forceRenderNextFrame?.(); // camera and/or splats move nearly every frame
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
    </div>
  );
}
