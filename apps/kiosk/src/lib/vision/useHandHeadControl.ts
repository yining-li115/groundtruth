import { useEffect, useRef, useState } from "react";
import { heroOrbit } from "../heroInput";
import { VisionEngine, type VisionResult } from "./mediapipe";

/**
 * Touchless control of the point cloud from a webcam — ONE HAND does everything:
 *   - Move the index FINGERTIP → orbit the cloud (drag: move to turn, stop to stop; no centring)
 *   - Open palm  → particles disperse    (progress → 0)
 *   - Closed fist → particles reassemble  (progress → 1)
 *
 * The hand replaces the earlier head-tracking orbit (the head was too stiff). The hook opens
 * the camera, runs MediaPipe each frame, and drives `progressRef` (dispersal) + `heroOrbit`
 * (orbit) — both already read by the point cloud, so its code is untouched. Live at /?exp=cv.
 */

export type VisionStatus = "idle" | "loading" | "running" | "error";

export interface HudState extends VisionResult {
  progressTarget: number;
  fps: number;
}

// ---- tuning knobs ----
const PROGRESS_EASE = 0.12; // how fast dispersal chases its target
const GESTURE_MIN_SCORE = 0.5;
const MIRROR_X = false; // horizontal drag direction (flip if left/right feels reversed)
const MIRROR_Y = true; // vertical drag direction (flip if up/down feels reversed)

// Finger → orbit, as a DRAG (relative): the cloud rotates by how much the fingertip MOVES,
// and stops when the finger stops — no need to return to any centre. Lift the hand out of
// frame and swipe again to keep turning (like flicking a globe). Yaw spins freely (full
// 360); pitch is clamped so the model never tumbles over.
const IDLE_RESET_MS = 5000; // no hand this long → the cloud reassembles to its default
const DRAG_GAIN = 5.0; // radians per 1.0 of fingertip travel across the frame
const MOVE_DEADZONE = 0.004; // ignore sub-pixel jitter per frame
const JUMP_REJECT = 0.15; // ignore huge single-frame jumps (pose change / tracking glitch)
const PITCH_LIMIT = 1.3; // clamp pitch (radians) so the building doesn't tumble over

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
const applied = (d: number) => (Math.abs(d) > MOVE_DEADZONE ? d : 0);

export function useHandHeadControl(
  progressRef: { current: number },
  enabled = true,
  controlOrbit = true, // when false, the hand still disperses but never orbits (inspect mode)
) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [status, setStatus] = useState<VisionStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const [hud, setHud] = useState<HudState>({
    hand: null,
    face: null,
    progressTarget: progressRef.current,
    fps: 0,
  });

  useEffect(() => {
    if (!enabled) return;
    let raf = 0;
    let stopped = false;
    let stream: MediaStream | null = null;
    const engine = new VisionEngine();
    const video = videoRef.current;
    if (!video) return;

    // dispersal target held between gestures (1 = assembled, 0 = dispersed)
    let target = progressRef.current;
    // orbit accumulates straight into the shared heroOrbit (single source of truth, so an
    // idle auto-spin and hand drag can hand off without a jump)
    let prevX = NaN; // last fingertip position (mirrored [0,1]); NaN = no hand last frame
    let prevY = NaN;
    let lastHandMs = performance.now(); // for the idle-reset timer
    let lastTs = 0;
    let lastFrame = performance.now();
    let ema = 0; // smoothed fps

    (async () => {
      try {
        setStatus("loading");
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

          // idle reset: after IDLE_RESET_MS with no hand, reassemble to the default shape
          if (res.hand) lastHandMs = now;
          else if (now - lastHandMs > IDLE_RESET_MS) target = 1;

          // --- hand pose → dispersal (sticky: holds last until the other gesture) ---
          if (res.hand && res.hand.score >= GESTURE_MIN_SCORE) {
            if (res.hand.label === "Open_Palm") target = 0;
            else if (res.hand.label === "Closed_Fist") target = 1;
          }
          progressRef.current += (target - progressRef.current) * PROGRESS_EASE;

          // --- fingertip movement → drag orbit (relative; stop moving = stop turning) ---
          if (controlOrbit && res.hand) {
            const hx = MIRROR_X ? 1 - res.hand.cx : res.hand.cx;
            const hy = MIRROR_Y ? 1 - res.hand.cy : res.hand.cy;
            if (!Number.isNaN(prevX)) {
              const dx = hx - prevX;
              const dy = hy - prevY;
              // reject pose-change / tracking jumps; otherwise rotate by the travel
              if (Math.abs(dx) < JUMP_REJECT && Math.abs(dy) < JUMP_REJECT) {
                heroOrbit.yaw += applied(dx) * DRAG_GAIN;
                heroOrbit.pitch = clamp(
                  heroOrbit.pitch + applied(dy) * DRAG_GAIN,
                  -PITCH_LIMIT,
                  PITCH_LIMIT,
                );
              }
            }
            heroOrbit.touched = true; // a hand is present this frame
            prevX = hx;
            prevY = hy;
          } else {
            prevX = prevY = NaN; // hand gone → next re-entry won't jump
            heroOrbit.touched = false; // no hand → callers may resume idle auto-spin
          }

          // fps (smoothed) for the HUD
          ema = ema ? ema * 0.9 + (1 / dtSec) * 0.1 : 1 / dtSec;
          setHud({ hand: res.hand, face: res.face, progressTarget: target, fps: ema });
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
    };
  }, [enabled, progressRef, controlOrbit]);

  return { videoRef, status, error, hud };
}
