import { useEffect, useRef } from "react";
// @ts-expect-error — @mkkellogg/gaussian-splats-3d ships no type declarations
import * as GaussianSplats3D from "@mkkellogg/gaussian-splats-3d";
import * as THREE from "three";
import { light } from "@groundtruth/tokens";
import { heroOrbit } from "../../lib/heroInput";
import {
  patchDisperseDirectional,
  type DirectionalDisperseHandle,
} from "../splatnav/disperse";

/**
 * Home-hero Gaussian-splat stage — the real TUM campus gaussians in place of the old
 * procedural point cloud, with the SAME hero behaviour: scrolling down blows the splats
 * to screen-right (progressRef 1 → 0), a one-finger drag / the cursor orbits it
 * (heroOrbit), and it idle-sways until touched. Renders on an alpha canvas so the light
 * page background shows through (no dark stage — the home stays light-themed).
 *
 * Camera framing reuses the showreel's user-tuned orbit (SplatStage): horizontal orbit
 * around the campus at fixed elevation, up = -Y (the scan is inverted), aim panned right
 * so the campus clears the motto overlaid on the left.
 */

const PLY_URL = "/splat/tum-campus-web.ply"; // decimated 400k/no-SH, committed for deploy

const CAMERA_UP: [number, number, number] = [0, -1, 0];
const TARGET = { x: -1.5, y: -1, z: -4.5 };
const R_H = 108; // horizontal orbit radius (XZ plane)
const H_UP = 50.7; // camera height above the target along -Y
const THETA0 = -0.446; // initial azimuth — the baked showreel framing
const AIM_RIGHT = 46; // pan the aim so the campus sits off-centre-right (clears the motto)
const ELEV_GAIN = 55; // world-units of camera height per unit of orbit pitch

// Hero feel — same numbers as the old point-cloud hero (showcase/Scene).
const PROGRESS_EASE = 0.08; // uDisperse eases toward the scroll target
const ORBIT_EASE = 0.1; // yaw/pitch ease toward heroOrbit
const SWAY_AMP = 0.12; // idle "you can drag me" sway (radians), fades once touched
const SWAY_SPEED = 0.15;
// Scatter box (screen-axis half-sizes) — sized to overfill the viewport: at ~119 units of
// camera distance and fov 50 the visible half-height is ~55 and half-width ~110, so
// 170×95 covers the whole frame with spill. DRIFT shifts the box right = the old hero's
// "blown to the right" read. BOOST fights the light-bg washout; FADE thins the dust.
const SCATTER_AMP: [number, number, number] = [170, 95, 100];
const SCATTER_DRIFT = 60;
const SCATTER_FADE = 0.45;
const ALPHA_BOOST = 1.35;

const CLAMP = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

const posAt = (theta: number): [number, number, number] => [
  TARGET.x + R_H * Math.cos(theta),
  TARGET.y - H_UP,
  TARGET.z + R_H * Math.sin(theta),
];

export function HeroSplat({ progressRef }: { progressRef: { current: number } }) {
  const ref = useRef<HTMLDivElement>(null);
  // dev-mouse drag orbit (the kiosk cursor drives heroOrbit; a real mouse drags here)
  const drag = useRef({ active: false, yaw: 0, pitch: 0 });

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let disposed = false;
    let raf = 0;
    let start = performance.now();

    // Own renderer, OPAQUE and cleared to the page background (exactly what the old R3F
    // hero did with <color attach="background">). A transparent canvas washes the splats
    // out — the browser composites it as premultiplied alpha, which brightens every soft
    // gaussian edge; blending against the light bg inside the renderer stays correct.
    const renderer = new THREE.WebGLRenderer({
      antialias: false,
      precision: "highp",
      powerPreference: "high-performance",
    });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5)); // same cap as the old hero
    renderer.setClearColor(new THREE.Color(light.bg), 1);
    renderer.setSize(el.offsetWidth || 1, el.offsetHeight || 1);
    renderer.domElement.style.position = "absolute";
    renderer.domElement.style.inset = "0";
    el.appendChild(renderer.domElement);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const viewer: any = new GaussianSplats3D.Viewer({
      rootElement: el,
      renderer,
      sharedMemoryForWorkers: false,
      useBuiltInControls: false, // we drive the camera (orbit-follow + sway)
      cameraUp: CAMERA_UP,
      initialCameraPosition: posAt(THETA0),
      initialCameraLookAt: [TARGET.x, TARGET.y, TARGET.z],
    });

    // External renderer → the viewer's resize observer is off; keep size + aspect ours.
    const resize = new ResizeObserver(() => {
      const w = el.offsetWidth || 1;
      const h = el.offsetHeight || 1;
      renderer.setSize(w, h);
      const cam = viewer.camera;
      if (cam) {
        cam.aspect = w / h;
        cam.updateProjectionMatrix();
      }
      viewer.forceRenderNextFrame?.();
    });
    resize.observe(el);

    // smoothed (rendered) state — eased each frame like the old hero's rot ref
    let smYaw = 0;
    let smPitch = 0;
    let swayAmp = SWAY_AMP;
    const fwd = new THREE.Vector3();
    const right = new THREE.Vector3();
    const up = new THREE.Vector3();

    viewer
      .addSplatScene(PLY_URL, { splatAlphaRemovalThreshold: 5, showLoadingUI: false })
      .then(() => {
        if (disposed) return;
        viewer.start();
        let disperse: DirectionalDisperseHandle | null = null;
        const tryPatch = () =>
          patchDisperseDirectional(
            viewer.getSplatMesh?.(),
            SCATTER_AMP,
            SCATTER_DRIFT,
            SCATTER_FADE,
            ALPHA_BOOST,
          );
        try {
          disperse = tryPatch();
        } catch {
          /* hero still renders without disperse */
        }

        const tick = (now: number) => {
          if (disposed) return;
          raf = requestAnimationFrame(tick);
          const cam = viewer.camera;
          if (!cam) return;
          if (!disperse) disperse = tryPatch();

          // scroll → disperse (progress 1 = assembled at top, 0 = fully blown right)
          if (disperse) {
            const target = 1 - CLAMP(progressRef.current ?? 0, 0, 1);
            disperse.uniform.value += (target - disperse.uniform.value) * PROGRESS_EASE;
          }

          // orbit-follow: ease toward the phone-driven heroOrbit (+ dev-mouse drag);
          // idle sway is the "you can drag me" hint, fading once the visitor takes over.
          smYaw += (heroOrbit.yaw + drag.current.yaw - smYaw) * ORBIT_EASE;
          smPitch += (heroOrbit.pitch + drag.current.pitch - smPitch) * ORBIT_EASE;
          swayAmp += ((heroOrbit.touched || drag.current.active ? 0 : SWAY_AMP) - swayAmp) * 0.05;
          const sway = Math.sin(((now - start) / 1000) * SWAY_SPEED) * swayAmp;

          // model-yaw +θ == camera-azimuth -θ (so the campus turns the way the cloud did)
          const theta = THETA0 - (sway + smYaw);
          const px = TARGET.x + R_H * Math.cos(theta);
          const pz = TARGET.z + R_H * Math.sin(theta);
          const py = TARGET.y - (H_UP + CLAMP(smPitch, -0.6, 0.6) * ELEV_GAIN);
          cam.position.set(px, py, pz);
          cam.up.set(CAMERA_UP[0], CAMERA_UP[1], CAMERA_UP[2]);

          // aim panned right so the campus sits off-centre; right vector (up = -Y) in XZ
          const fx = TARGET.x - px;
          const fz = TARGET.z - pz;
          const rl = Math.hypot(fx, fz) || 1;
          const ax = TARGET.x - (fz / rl) * AIM_RIGHT;
          const az = TARGET.z - (-fx / rl) * AIM_RIGHT;
          cam.lookAt(ax, TARGET.y, az);

          // keep the scatter box glued to the live view while the camera orbits: centred on
          // the aim point (= screen centre), axes = the camera's screen basis
          if (disperse) {
            fwd.set(ax - px, TARGET.y - py, az - pz).normalize();
            right.crossVectors(fwd, cam.up).normalize();
            up.crossVectors(right, fwd).normalize();
            disperse.center.value.set(ax, TARGET.y, az);
            disperse.dirRight.value.copy(right);
            disperse.dirUp.value.copy(up);
            disperse.dirFwd.value.copy(fwd);
          }

          viewer.forceRenderNextFrame?.(); // camera and/or splats move nearly every frame
        };
        start = performance.now();
        raf = requestAnimationFrame(tick);
      })
      .catch((e: unknown) => console.error("[herosplat] load failed", e));

    // dev-mouse drag → same orbit the kiosk cursor drives (wheel untouched, page scrolls)
    const onDown = (e: PointerEvent) => {
      if (e.button !== 0) return;
      drag.current.active = true;
      el.setPointerCapture(e.pointerId);
    };
    const onMove = (e: PointerEvent) => {
      if (!drag.current.active) return;
      drag.current.yaw += e.movementX * 0.004;
      drag.current.pitch = CLAMP(drag.current.pitch + e.movementY * 0.003, -0.6, 0.6);
    };
    const onUp = () => {
      drag.current.active = false;
    };
    el.addEventListener("pointerdown", onDown);
    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointerup", onUp);
    el.addEventListener("pointercancel", onUp);

    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      resize.disconnect();
      el.removeEventListener("pointerdown", onDown);
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerup", onUp);
      el.removeEventListener("pointercancel", onUp);
      try {
        viewer?.dispose?.();
      } catch {
        /* not fully initialised on fast unmount */
      }
      renderer.dispose();
      renderer.domElement.remove();
    };
  }, [progressRef]);

  return <div ref={ref} className="absolute inset-0" />;
}
