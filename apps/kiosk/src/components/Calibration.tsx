import { useCallback, useEffect, useRef, useState } from "react";
import { activePointer } from "../lib/vision/handPointer";
import { mapToBox, palmCenter, type BoxConfig } from "../lib/vision/calibration";
import { fitReach, shrinkBox, MIN_SAMPLES, type ReachSample } from "../lib/vision/reachFit";
import {
  PROFILE_VERSION,
  fitJitter,
  fitPinch,
  type CalibrationProfile,
} from "../lib/vision/profile";
import { applyProfile, restoreProfile } from "../lib/vision/profileStore";
import { visionLog } from "../lib/vision/visionLog";
import { useKioskStore } from "../state/store";
import "./calibration.css";

/**
 * Measuring the room, once, so nothing downstream has to guess it.
 *
 * WHY THIS EXISTS. Every constant in the gesture pipeline was fitted honestly and every one of
 * them was fitted against one camera, at one distance, on one pair of hands. That is a
 * reasonable default and a bad law, and the failure it produces is specific: inside a metre the
 * hand-tuned interaction box maps the bottom edge of the SCREEN onto the bottom edge of the
 * camera FRAME, so reaching for anything down there — the Home corner, say — puts the palm half
 * out of shot and tracking simply stops. The corner is not hard to hit. It is unreachable, and
 * nothing says so. (`reachFit.ts` has the numbers.)
 *
 * WHAT IT MEASURES, and what each one replaces:
 *
 *   1. reach   → the interaction box, in face widths, fitted to where this camera can actually
 *                see a hand rather than to where an arm can go
 *   2. stillness → the 1€ filter's cutoff and the dwell radius, chosen by replaying the real
 *                filter over this camera's real noise
 *   3. pinch   → this person's own open and closed clouds, and thresholds landed in the gap
 *                between them — or the finding that there IS no gap, in which case the click
 *                switches to a fist and says so
 *   4. reach test → proof. The four corners are visited with the calibrated pointer; a corner
 *                that cannot be held is not a calibration, and the box shrinks and tries again.
 *
 * WHEN IT RUNS. Once per camera, not once per visitor. What it measures is mostly a fact about
 * the installation — this lens, this mounting, this angle — and the per-visitor part (distance,
 * hand size) is already handled by the face-width ruler the whole box is expressed in. Asking
 * every passer-by to calibrate would destroy the thing the project is built on: nothing to
 * install, nothing to scan, raise a hand and the screen is yours. So the first time this
 * machine opens the page it measures; every time after that it reads what it measured.
 * `?calibrate=1` forces it, `?calibrate=0` skips it.
 */

type Phase =
  | "resolving" // finding the camera and any stored profile — renders nothing
  | "seek" // waiting for a face and a hand
  | "sweep" // record the reachable region
  | "still" // record the noise floor
  | "open" // record the open-hand cloud
  | "close" // record the closing cloud
  | "reach" // verify the corners with the calibrated pointer
  | "done";

const SWEEP_MS = 7000;
const STILL_MS = 2500;
const OPEN_MS = 2000;
const CLOSE_MS = 7000;
const REACH_MS = 12000;
/** How far from a corner target the cursor counts as having arrived, in screen fractions. */
const REACH_RADIUS = 0.09;
/** Corner targets, inset from the very edge — the last few percent belong to nothing. */
const CORNERS = [
  { id: "tl", x: 0.05, y: 0.06 },
  { id: "tr", x: 0.95, y: 0.06 },
  { id: "bl", x: 0.05, y: 0.94 },
  { id: "br", x: 0.95, y: 0.94 },
];
/** How much to give up when a corner cannot be held, and how many times to try. */
const SHRINK = 0.88;
const MAX_RETRIES = 2;

const PARAMS = typeof window === "undefined" ? null : new URLSearchParams(location.search);
const FORCE = PARAMS?.get("calibrate") === "1";
const DISABLED = PARAMS?.get("calibrate") === "0";

/** Identify the camera actually in use, so the profile is stored against it and not against
 *  "whatever camera this browser lists first". */
function cameraIdentity(): { deviceId: string; label: string } {
  const el = visionLog.video;
  const stream = el?.srcObject instanceof MediaStream ? el.srcObject : null;
  const track = stream?.getVideoTracks()[0];
  const settings = track?.getSettings();
  return { deviceId: settings?.deviceId ?? "", label: track?.label ?? "" };
}

export function Calibration({ onDone }: { onDone: () => void }) {
  const [phase, setPhase] = useState<Phase>("resolving");
  const [progress, setProgress] = useState(0);
  const [note, setNote] = useState<string>("");
  const [reached, setReached] = useState<string[]>([]);
  const [result, setResult] = useState<CalibrationProfile | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  // Everything the recording collects. Refs, not state: this fills at the camera's frame rate
  // and re-rendering the tree sixty times a second would be its own performance problem.
  const rec = useRef({
    sweep: [] as ReachSample[],
    still: [] as Array<{ x: number; y: number; t: number }>,
    open: [] as number[],
    close: [] as number[],
    fps: 30,
    frame: { w: 0, h: 0 },
    palmPx: 0,
    lastFrameCount: -1,
    box: null as BoxConfig | null,
    clippedBy: { left: false, right: false, top: false, bottom: false },
    retries: 0,
  });

  const finish = useCallback(
    (profile: CalibrationProfile | null) => {
      if (profile) applyProfile(profile);
      setResult(profile);
      setPhase("done");
      // A beat to read the summary, then hand the screen over.
      window.setTimeout(onDone, profile ? 2600 : 400);
    },
    [onDone],
  );

  // ---- resolve: is there already a profile for this camera? -------------------------------
  useEffect(() => {
    if (DISABLED) {
      // `?calibrate=0` turns off the SCREEN, not the calibration: an automated check that skips
      // the setup step should still run against the numbers this machine measured, or it is
      // testing a configuration nobody uses.
      const { deviceId, label } = cameraIdentity();
      restoreProfile(deviceId, label);
      onDone();
      return;
    }
    let cancelled = false;
    // The camera has to be up before it can be identified, and `useHandPointer` starts it a
    // moment after mount. Poll briefly rather than racing it.
    const started = performance.now();
    const tick = () => {
      if (cancelled) return;
      const { deviceId, label } = cameraIdentity();
      const status = useKioskStore.getState().handStatus;
      if (deviceId || label) {
        if (!FORCE && restoreProfile(deviceId, label)) {
          onDone(); // measured before, on this camera — say nothing, show nothing
          return;
        }
        setPhase("seek");
        return;
      }
      // No camera at all is not a reason to hold the screen hostage: the wall should fall back
      // to playing its showreel, which is a perfectly respectable thing for it to be doing.
      if (status === "error" || performance.now() - started > 12000) {
        onDone();
        return;
      }
      window.setTimeout(tick, 200);
    };
    tick();
    return () => {
      cancelled = true;
    };
  }, [onDone]);

  // ---- the recording loop -----------------------------------------------------------------
  useEffect(() => {
    if (phase === "resolving" || phase === "done") return;
    let raf = 0;
    let phaseStart = performance.now();
    let current: Phase = phase;

    const advance = (next: Phase) => {
      current = next;
      phaseStart = performance.now();
      setProgress(0);
      setPhase(next);
    };

    const loop = () => {
      raf = requestAnimationFrame(loop);
      const pointer = activePointer();
      if (!pointer) return;
      const s = pointer.state;
      const now = performance.now();
      const r = rec.current;

      // One sample per VISION frame, not per render frame. The pointer updates at the camera's
      // rate and this loop runs at the display's; counting the same frame twice would weight
      // whatever the hand happened to be doing while the browser was fast.
      const fresh = s.counts.frames !== r.lastFrameCount;
      r.lastFrameCount = s.counts.frames;
      if (s.fps > 1) r.fps = s.fps;
      if (s.frame.w > 0) r.frame = { w: s.frame.w, h: s.frame.h };
      if (Number.isFinite(s.palmPx)) r.palmPx = s.palmPx;

      const palm = palmCenter(s.hands[0]);
      const face = s.face;
      const tracked = !!palm && !!face && face.w > 0;

      switch (current) {
        case "seek": {
          // Both, and steadily: a sweep recorded against a face the detector is still finding
          // is a sweep measured against a moving ruler.
          if (tracked && s.present) advance("sweep");
          break;
        }

        case "sweep": {
          if (fresh && tracked && palm && face) {
            r.sweep.push({
              u: (palm.x - face.cx) / face.w,
              v: (palm.y - face.cy) / face.w,
              x: palm.x,
              y: palm.y,
              faceW: face.w,
            });
          }
          const t = (now - phaseStart) / SWEEP_MS;
          setProgress(Math.min(1, t));
          if (t >= 1) {
            const aspect = r.frame.h > 0 ? r.frame.w / r.frame.h : 16 / 9;
            const fit = fitReach(r.sweep, aspect);
            if (!fit) {
              setNote(
                r.sweep.length < MIN_SAMPLES
                  ? "The hand was not tracked for long enough — try again, a little closer."
                  : "That sweep was too small to measure. Try again, reaching further.",
              );
              r.sweep = [];
              advance("seek");
              break;
            }
            r.box = fit.box;
            r.clippedBy = fit.clippedBy;
            // Apply it immediately and WITHOUT saving: everything after this — the noise floor,
            // the corner test — has to be measured through the mapping that will actually ship,
            // not through the default it is replacing.
            applyProfile(provisional(r.box, fit.clippedBy, r), false);
            setNote("");
            advance("still");
          }
          break;
        }

        case "still": {
          if (fresh && palm && s.box) {
            // The RAW mapping, deliberately: `liveX/liveY` have already been through the 1€
            // filter, and measuring the noise after filtering it is measuring the filter.
            const m = mapToBox(s.box, palm);
            r.still.push({ x: m.u, y: m.v, t: now });
          }
          const t = (now - phaseStart) / STILL_MS;
          setProgress(Math.min(1, t));
          if (t >= 1) advance("open");
          break;
        }

        case "open": {
          if (fresh && Number.isFinite(s.ratio)) r.open.push(s.ratio);
          const t = (now - phaseStart) / OPEN_MS;
          setProgress(Math.min(1, t));
          if (t >= 1) advance("close");
          break;
        }

        case "close": {
          if (fresh && Number.isFinite(s.ratio)) r.close.push(s.ratio);
          const t = (now - phaseStart) / CLOSE_MS;
          setProgress(Math.min(1, t));
          if (t >= 1) {
            const built = build(r);
            applyProfile(built, false);
            setResult(built);
            advance("reach");
          }
          break;
        }

        case "reach": {
          setReached((prev) => {
            const hit = CORNERS.filter(
              (c) => Math.hypot(s.x - c.x, s.y - c.y) < REACH_RADIUS,
            ).map((c) => c.id);
            const next = hit.filter((id) => !prev.includes(id));
            return next.length ? [...prev, ...next] : prev;
          });
          const t = (now - phaseStart) / REACH_MS;
          setProgress(Math.min(1, t));
          break;
        }

        default:
          break;
      }

      drawPreview(canvasRef.current, r, s.box, current);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [phase]);

  // ---- the corner test's verdict, kept out of the frame loop -------------------------------
  useEffect(() => {
    if (phase !== "reach") return;
    const r = rec.current;
    if (reached.length === CORNERS.length) {
      finish(build(r));
      return;
    }
    if (progress < 1) return;
    // A corner nobody could hold is not a calibration. Give up some reach and try again — the
    // centre was measured and is fine, it is the extent that was too generous.
    if (r.retries < MAX_RETRIES && r.box) {
      r.retries += 1;
      r.box = shrinkBox(r.box, SHRINK);
      applyProfile(build(r), false);
      setReached([]);
      setNote(`Tightening the reach (attempt ${r.retries + 1} of ${MAX_RETRIES + 1})…`);
      setPhase("seek");
      window.setTimeout(() => setPhase("reach"), 60);
      return;
    }
    // Out of retries. Keep what was measured — it is still far better than the default that
    // put the bottom of the screen outside the picture — and say which corners never answered.
    setNote("");
    finish(build(r));
  }, [phase, reached, progress, finish]);

  if (phase === "resolving") return null;

  const copy = COPY[phase];
  return (
    <div className="cal" role="dialog" aria-label="Set up hand control">
      <div className="cal-frame">
        <canvas ref={canvasRef} className="cal-canvas" width={480} height={270} />
      </div>

      <div className="cal-body">
        <span className="cal-step">{copy.step}</span>
        <h1 className="cal-title">{copy.title}</h1>
        <p className="cal-hint">{note || copy.hint}</p>

        {phase !== "done" && phase !== "reach" && (
          <div className="cal-bar">
            <div className="cal-bar__fill" style={{ transform: `scaleX(${progress})` }} />
          </div>
        )}

        {phase === "done" && result && <Summary profile={result} />}
      </div>

      {phase === "reach" &&
        CORNERS.map((c) => (
          <div
            key={c.id}
            className={`cal-corner ${reached.includes(c.id) ? "is-on" : ""}`}
            style={{ left: `${c.x * 100}%`, top: `${c.y * 100}%` }}
          />
        ))}

      {phase !== "done" && (
        // Centre of the screen, because it is the one place every mapping can reach — including
        // a badly wrong one, which is exactly the situation somebody would be skipping from.
        <button type="button" data-hover className="cal-skip" onClick={() => finish(null)}>
          Skip — use the default settings
        </button>
      )}
    </div>
  );
}

/** A profile from whatever has been measured so far. Everything unmeasured keeps its default. */
function build(r: {
  sweep: ReachSample[];
  still: Array<{ x: number; y: number; t: number }>;
  open: number[];
  close: number[];
  fps: number;
  frame: { w: number; h: number };
  palmPx: number;
  box: BoxConfig | null;
  clippedBy: CalibrationProfile["clippedBy"];
}): CalibrationProfile {
  const pointer = activePointer();
  const beta = pointer?.config.oneEuro.beta ?? 10;
  const pinch = fitPinch(r.open, r.close);
  const jitter = fitJitter(r.still, beta);
  const { deviceId, label } = cameraIdentity();
  return {
    version: PROFILE_VERSION,
    measuredAt: Date.now(),
    camera: { deviceId, label, frameW: r.frame.w, frameH: r.frame.h, fps: r.fps },
    box: r.box ?? { widthFaces: 4.5, heightFaces: 3.0, dropFaces: 2.6, shiftFaces: 0 },
    clippedBy: r.clippedBy,
    pinch,
    jitter,
    palmPx: r.palmPx,
    // The measurement decides the grammar. A pinch whose two clouds overlap on THIS camera is
    // not a gesture this installation can read, and offering it anyway is how a wall spends a
    // week ignoring every third visitor.
    clickGesture: pinch.usable ? "either" : "fist",
  };
}

function provisional(
  box: BoxConfig,
  clippedBy: CalibrationProfile["clippedBy"],
  r: { fps: number; frame: { w: number; h: number }; palmPx: number },
): CalibrationProfile {
  const { deviceId, label } = cameraIdentity();
  return {
    version: PROFILE_VERSION,
    measuredAt: Date.now(),
    camera: { deviceId, label, frameW: r.frame.w, frameH: r.frame.h, fps: r.fps },
    box,
    clippedBy,
    pinch: { on: 0.74, off: 0.88, open: NaN, closed: NaN, separation: 0, usable: false },
    jitter: { raw: NaN, filtered: NaN, minCutoff: 0.4, dwellRadius: 0.035 },
    palmPx: r.palmPx,
    clickGesture: "either",
  };
}

function Summary({ profile }: { profile: CalibrationProfile }) {
  const clipped = Object.entries(profile.clippedBy)
    .filter(([, v]) => v)
    .map(([k]) => k);
  return (
    <dl className="cal-summary">
      <div>
        <dt>Reach</dt>
        <dd>
          {profile.box.widthFaces.toFixed(1)} × {profile.box.heightFaces.toFixed(1)} face widths
          {clipped.length > 0 && (
            <span className="cal-summary__note"> · camera limited {clipped.join(", ")}</span>
          )}
        </dd>
      </div>
      <div>
        <dt>Click</dt>
        <dd>
          {profile.pinch.usable
            ? `pinch below ${profile.pinch.on.toFixed(2)} (or a fist)`
            : "fist — this camera cannot separate your pinch"}
        </dd>
      </div>
      <div>
        <dt>Steadiness</dt>
        <dd>
          {Number.isFinite(profile.jitter.filtered)
            ? `${(profile.jitter.filtered * 100).toFixed(2)}% drift · cutoff ${profile.jitter.minCutoff}`
            : "not measured"}
        </dd>
      </div>
      <div>
        <dt>Camera</dt>
        <dd>
          {profile.camera.frameW}×{profile.camera.frameH} · {profile.camera.fps.toFixed(0)} fps
        </dd>
      </div>
    </dl>
  );
}

const COPY: Record<Phase, { step: string; title: string; hint: string }> = {
  resolving: { step: "", title: "", hint: "" },
  seek: {
    step: "Setup",
    title: "Stand where you would stand",
    hint: "Raise one hand so the camera can see both you and it.",
  },
  sweep: {
    step: "1 of 4",
    title: "Draw the biggest circle you can",
    hint: "Keep your hand up and sweep it around — as far out, up and down as is comfortable.",
  },
  still: {
    step: "2 of 4",
    title: "Now hold it still",
    hint: "Just for a moment. This measures how much the picture shakes when you do not.",
  },
  open: {
    step: "3 of 4",
    title: "Hold your hand open",
    hint: "Fingers spread, facing the camera.",
  },
  close: {
    step: "3 of 4",
    title: "Pinch, and open again — a few times",
    hint: "Slowly. Touch your thumb and finger together, then open the hand right up.",
  },
  reach: {
    step: "4 of 4",
    title: "Touch all four corners",
    hint: "Move the cursor into each dot. This is the part that proves the screen is all yours.",
  },
  done: { step: "", title: "Ready", hint: "" },
};

/**
 * The live picture of what is being measured: the camera frame, the face the scale comes from,
 * the sweep so far, and the box that has been fitted to it.
 *
 * Not decoration. Calibration is otherwise a black box that asks for arm-waving and then claims
 * success, and the two ways it goes wrong — a sweep that never reached, a box the frame edge cut
 * short — are both immediately obvious here and invisible in a progress bar.
 */
function drawPreview(
  canvas: HTMLCanvasElement | null,
  r: { sweep: ReachSample[] },
  box: { x0: number; y0: number; x1: number; y1: number } | null,
  phase: Phase,
): void {
  const ctx = canvas?.getContext("2d");
  if (!canvas || !ctx) return;
  const { width: w, height: h } = canvas;
  ctx.clearRect(0, 0, w, h);

  // frame
  ctx.strokeStyle = "rgba(255,255,255,0.25)";
  ctx.lineWidth = 1;
  ctx.strokeRect(0.5, 0.5, w - 1, h - 1);

  // the sweep, mirrored so it reads as the visitor's own movement rather than the camera's view
  if (r.sweep.length) {
    ctx.fillStyle = "rgba(255,255,255,0.5)";
    for (let i = Math.max(0, r.sweep.length - 400); i < r.sweep.length; i += 1) {
      const s = r.sweep[i]!;
      ctx.fillRect((1 - s.x) * w - 1, s.y * h - 1, 2, 2);
    }
  }

  // the fitted box
  if (box && (phase === "still" || phase === "open" || phase === "close" || phase === "reach")) {
    ctx.strokeStyle = "rgba(122,122,255,0.9)";
    ctx.lineWidth = 2;
    const x = (1 - box.x1) * w;
    ctx.strokeRect(x, box.y0 * h, (box.x1 - box.x0) * w, (box.y1 - box.y0) * h);
  }
}
