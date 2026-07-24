import { useEffect, useRef, useState } from "react";
import { VisionEngine } from "../../lib/vision/mediapipe";
import { splatNav, PITCH_MIN, PITCH_MAX } from "./navState";

/**
 * Touchless NAVIGATION + DISPERSE of the Gaussian-splat map from a webcam — ONE HAND:
 *   - Move the index FINGERTIP  → orbit the view (relative drag: move to turn, stop to stop)
 *   - Open palm                 → disperse the gaussians (scatter apart)
 *   - Closed fist               → reassemble the gaussians
 *   - No hand                   → the camera slowly auto-orbits (idle attract)
 *
 * Same gesture vocabulary as the point-cloud showreel (`lib/vision/useHandHeadControl`), now
 * driving the REAL 3DGS render. It writes *intent* into the `splatNav` singleton; the camera
 * loop in `SplatNavExperiment` reads it. Framework-agnostic engine (`VisionEngine`) is shared.
 *
 * ASSET HOSTING: the MediaPipe WASM + models still come from CDNs (see `mediapipe.ts`); they
 * must be self-hosted before this leaves the experiment stage (kiosk runs offline).
 */

export type NavStatus = "idle" | "loading" | "running" | "error";

// ---- tuning knobs ----
const GESTURE_MIN_SCORE = 0.5;
const MIRROR_X = false; // hand right → view turns right (flip if it feels reversed)
const MIRROR_Y = true; // hand up → view tilts up (flip if it feels reversed)
const DRAG_GAIN = 4.0; // radians of orbit per 1.0 of fingertip travel across the frame
const FINGER_SMOOTH = 0.5; // EMA on the fingertip position — tames MediaPipe's per-frame noise
const MOVE_DEADZONE = 0.004; // ignore sub-pixel jitter per frame
const JUMP_REJECT = 0.15; // ignore huge single-frame jumps (pose change / tracking glitch)

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
const applied = (d: number) => (Math.abs(d) > MOVE_DEADZONE ? d : 0);

export interface NavHud {
  gesture: string;
  handPresent: boolean;
  fps: number;
}

export function useHandNav(enabled = true) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [status, setStatus] = useState<NavStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const [hud, setHud] = useState<NavHud>({ gesture: "None", handPresent: false, fps: 0 });

  useEffect(() => {
    if (!enabled) return;
    let raf = 0;
    let stopped = false;
    let stream: MediaStream | null = null;
    const engine = new VisionEngine();
    const video = videoRef.current;
    if (!video) return;

    let prevX = NaN; // last SMOOTHED fingertip position (mirrored [0,1]); NaN = no hand last frame
    let prevY = NaN;
    let emaX = NaN; // EMA-smoothed fingertip, to pre-filter tracking noise before differencing
    let emaY = NaN;
    let lastTs = 0;
    let lastFrame = performance.now();
    let ema = 0; // smoothed fps

    (async () => {
      try {
        setStatus("loading");
        // navigator.mediaDevices only exists in SECURE contexts (https or localhost).
        // Opening the kiosk via a LAN IP (http://192.168.x.x:5173) hides the camera API
        // entirely — surface that as a readable error instead of a TypeError.
        if (!navigator.mediaDevices?.getUserMedia) {
          throw new Error(
            "camera API unavailable — open via http://localhost:5173 (or HTTPS); " +
              "insecure http://<LAN-IP> origins block the webcam",
          );
        }
        stream = await navigator.mediaDevices.getUserMedia({
          video: { width: 640, height: 480, facingMode: "user" },
          audio: false,
        });
        if (stopped) return;
        video.srcObject = stream;
        await video.play();
        await engine.load();
        if (stopped) return;
        setStatus("running");

        const tick = () => {
          if (stopped) return;
          raf = requestAnimationFrame(tick);
          if (video.readyState < 2) return; // not enough data yet

          // Strictly-increasing timestamp for MediaPipe's VIDEO mode.
          let ts = performance.now();
          if (ts <= lastTs) ts = lastTs + 1;
          lastTs = ts;

          const res = engine.process(video, ts);

          const now = performance.now();
          const dtSec = clamp((now - lastFrame) / 1000, 0.001, 0.05); // clamp tab-blur spikes
          lastFrame = now;

          // --- gesture → disperse intent (only in manual mode; STICKY until the other gesture) ---
          let gesture = "None";
          if (res.hand && res.hand.score >= GESTURE_MIN_SCORE) {
            gesture = res.hand.label;
            if (splatNav.gestureControls) {
              if (res.hand.label === "Open_Palm") splatNav.disperseTarget = 1; // scatter
              else if (res.hand.label === "Closed_Fist") splatNav.disperseTarget = 0; // reassemble
            }
          } else if (res.hand) {
            gesture = res.hand.label; // hand tracked but no confident gesture
          }
          splatNav.gesture = gesture;

          // --- fingertip movement → orbit drag (relative; stop moving = stop turning) ---
          if (res.hand) {
            const rawX = MIRROR_X ? 1 - res.hand.cx : res.hand.cx;
            const rawY = MIRROR_Y ? 1 - res.hand.cy : res.hand.cy;
            // pre-smooth the fingertip (EMA) before differencing, so noise doesn't become shake
            emaX = Number.isNaN(emaX) ? rawX : emaX + (rawX - emaX) * FINGER_SMOOTH;
            emaY = Number.isNaN(emaY) ? rawY : emaY + (rawY - emaY) * FINGER_SMOOTH;
            const hx = emaX;
            const hy = emaY;
            if (!Number.isNaN(prevX)) {
              const dx = hx - prevX;
              const dy = hy - prevY;
              if (Math.abs(dx) < JUMP_REJECT && Math.abs(dy) < JUMP_REJECT) {
                splatNav.yaw += applied(dx) * DRAG_GAIN;
                splatNav.pitch = clamp(
                  splatNav.pitch + applied(dy) * DRAG_GAIN,
                  PITCH_MIN,
                  PITCH_MAX,
                );
              }
            }
            splatNav.handPresent = true;
            prevX = hx;
            prevY = hy;
          } else {
            prevX = prevY = NaN; // hand gone → next re-entry won't jump
            emaX = emaY = NaN;
            splatNav.handPresent = false;
          }

          ema = ema ? ema * 0.9 + (1 / dtSec) * 0.1 : 1 / dtSec;
          setHud({ gesture, handPresent: !!res.hand, fps: ema });
        };
        raf = requestAnimationFrame(tick);
      } catch (e) {
        if (stopped) return;
        setError(e instanceof Error ? e.message : String(e));
        setStatus("error");
      }
    })();

    return () => {
      stopped = true;
      cancelAnimationFrame(raf);
      engine.close();
      stream?.getTracks().forEach((t) => t.stop());
      if (video) video.srcObject = null;
      splatNav.handPresent = false;
    };
  }, [enabled]);

  return { videoRef, status, error, hud };
}
