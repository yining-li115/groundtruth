import { useCallback, useEffect, useRef, useState } from "react";
import { activePointer } from "../lib/vision/handPointer";
import { mapToBox, palmCenter, type BoxConfig } from "../lib/vision/calibration";
import { fitReach, laps, shrinkBox, MIN_SAMPLES, type ReachSample } from "../lib/vision/reachFit";
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
 *   1. reach   → the interaction box, in face widths, fitted to an EASY circle the visitor
 *                traces — the movement they find comfortable, not the one they can force —
 *                and shrunk so the screen's corners land on that circle (`COMFORT`)
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

/**
 * NOTHING HERE IS A COUNTDOWN, and the first version's were the bug.
 *
 * Each step used to run a fixed clock that started the instant a hand was seen — which is the
 * instant BEFORE the visitor has read what to do. The progress bar filled while somebody was
 * still looking at the sentence telling them to sweep, and the step ended having recorded a
 * hand held politely still. A measurement that runs on a timer measures the reading speed of
 * whoever is standing there.
 *
 * So every step now waits out a lead-in first (long enough to read one short line), then
 * records until the THING IT NEEDS has happened — enough of the reach covered, enough
 * contiguous stillness, enough pinches. The bar shows that, not elapsed time, so it stops
 * being a deadline and starts being feedback. The caps below exist only so a step cannot
 * trap someone forever; reaching one is a result, not a failure.
 */
const LEAD_IN_MS = 1600;
/** how many times round the circle has to go before it is a measurement (see `laps`) */
const LAPS_NEEDED = 2;
const SWEEP_CAP_MS = 30_000;
/**
 * How much of the traced circle the screen is mapped to.
 *
 * The circle is COMFORTABLE now, not maximal — see the sweep copy — and a box fitted to its
 * bounding rectangle would put the screen's corners outside it: a corner of a rectangle is
 * 1.4 radii from the centre of its inscribed circle, and 1.4 times a comfortable reach is a
 * stretch. Shrinking the box to this fraction of the circle puts the corners ON the circle
 * (0.8 x 1.41 x 0.9 ≈ 1.0 radii to the corner targets at 5% inset), so the whole screen sits
 * inside a movement the visitor has already shown to be easy. The price is gain: a smaller box
 * means the cursor moves further per centimetre of hand. The stillness step measures the
 * result and sets the filter to match, so the price is paid where it can be seen.
 */
const COMFORT = 0.8;
/** contiguous milliseconds of a genuinely still hand */
const STILL_NEEDED_MS = 2200;
const STILL_CAP_MS = 15_000;
/** contiguous milliseconds of a genuinely open hand */
const OPEN_NEEDED_MS = 1600;
const OPEN_CAP_MS = 12_000;
/** how many open→closed→open cycles make a cloud worth fitting */
const PINCH_CYCLES = 4;
const CLOSE_CAP_MS = 22_000;
const REACH_MS = 15_000;
/** RMS wander, in screen fractions, below which a hand counts as held still */
const STILL_TOLERANCE = 0.02;
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
  /** false during a step's lead-in — the beat that exists so the instruction can be read
   *  before anything is recorded. Shown, because a bar that is not moving and a bar that is
   *  not listening look identical otherwise. */
  const [recording, setRecording] = useState(false);
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
    /** the lead-in is over and samples are being kept */
    recording: false,
    /** contiguous stillness / openness accumulated so far, in ms */
    held: 0,
    /** the last few mapped positions, for deciding whether the hand is actually still */
    recent: [] as Array<{ x: number; y: number }>,
    /** pinch-cycle detection: the widest the hand has read, and where we are in a cycle */
    ratioMax: 0,
    closed: false,
    cycles: 0,
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
    let timer = 0;
    /**
     * Wait for the camera to RESOLVE, not for a stopwatch to run out.
     *
     * A camera cannot be identified until the browser has granted access to it, and on a fresh
     * machine over HTTPS that means somebody has to answer a permission prompt. This used to
     * give up after twelve seconds — so anybody who read the prompt, or whose prompt was behind
     * another window, was silently dropped past the setup and into the site with the shipped
     * defaults. Nothing was stored, so it would ask again on the next load; on a wall that runs
     * for weeks, "the next load" is not a plan.
     *
     * Waiting costs nothing, which is the part that makes this obvious in hindsight: while this
     * is unresolved the component renders NOTHING, so the showreel is already playing
     * underneath. There is no held-hostage screen to rescue anyone from. The only thing that
     * legitimately ends the wait is the camera actually failing — no device, or access refused —
     * and that is a signal, not a duration.
     */
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
      // No camera at all is not a reason to hold the screen hostage: the wall falls back to
      // playing its showreel, which is a perfectly respectable thing for it to be doing.
      if (status === "error") {
        onDone();
        return;
      }
      timer = window.setTimeout(tick, 200);
    };
    tick();
    return () => {
      cancelled = true;
      if (timer) window.clearTimeout(timer);
    };
  }, [onDone]);

  // ---- the recording loop -----------------------------------------------------------------
  useEffect(() => {
    if (phase === "resolving" || phase === "done") return;
    let raf = 0;
    let phaseStart = performance.now();
    let current: Phase = phase;

    const advance = (next: Phase) => {
      const r = rec.current;
      current = next;
      phaseStart = performance.now();
      r.recording = false;
      r.held = 0;
      r.recent = [];
      r.ratioMax = 0;
      r.closed = false;
      r.cycles = 0;
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
          const elapsed = now - phaseStart;
          r.recording = elapsed >= LEAD_IN_MS;
          if (r.recording && fresh && tracked && palm && face) {
            r.sweep.push({
              u: (palm.x - face.cx) / face.w,
              v: (palm.y - face.cy) / face.w,
              x: palm.x,
              y: palm.y,
              faceW: face.w,
            });
          }
          const cov = Math.min(1, laps(r.sweep) / LAPS_NEEDED);
          setProgress(r.recording ? cov : 0);
          setNote(
            !r.recording
              ? ""
              : !tracked
                ? "Keep your hand where the camera can see it."
                : cov > 0.5 && cov < 1
                  ? "Once more round."
                  : "",
          );
          if ((cov >= 1 && r.sweep.length >= MIN_SAMPLES) || elapsed > SWEEP_CAP_MS) {
            const aspect = r.frame.h > 0 ? r.frame.w / r.frame.h : 16 / 9;
            const fit = fitReach(r.sweep, aspect, { comfort: COMFORT });
            if (!fit) {
              setNote(
                r.sweep.length < MIN_SAMPLES
                  ? "The hand kept dropping out of view — try again, a little closer to the camera."
                  : "That circle was too small to measure from. Once more, a little bigger — still easy.",
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
          const elapsed = now - phaseStart;
          r.recording = elapsed >= LEAD_IN_MS;
          if (r.recording && fresh && palm && s.box) {
            // The RAW mapping, deliberately: `liveX/liveY` have already been through the 1€
            // filter, and measuring the noise after filtering it is measuring the filter.
            const m = mapToBox(s.box, palm);
            r.recent.push({ x: m.u, y: m.v });
            if (r.recent.length > 12) r.recent.shift();
            // Only STILL frames count, and a moving hand resets the run. Otherwise this reads
            // whatever noise a drifting arm happens to add and calls it the sensor's.
            if (spread(r.recent) < STILL_TOLERANCE) {
              r.held += 1000 / Math.max(10, r.fps);
              r.still.push({ x: m.u, y: m.v, t: now });
            } else {
              r.held = 0;
              r.still = [];
            }
          }
          setProgress(r.recording ? Math.min(1, r.held / STILL_NEEDED_MS) : 0);
          setNote(r.recording && r.held === 0 && r.recent.length > 6 ? "Hold it steady…" : "");
          if (r.held >= STILL_NEEDED_MS || elapsed > STILL_CAP_MS) advance("open");
          break;
        }

        case "open": {
          const elapsed = now - phaseStart;
          r.recording = elapsed >= LEAD_IN_MS;
          if (r.recording && fresh && Number.isFinite(s.ratio)) {
            r.open.push(s.ratio);
            r.held += 1000 / Math.max(10, r.fps);
          }
          setProgress(r.recording ? Math.min(1, r.held / OPEN_NEEDED_MS) : 0);
          if (r.held >= OPEN_NEEDED_MS || elapsed > OPEN_CAP_MS) advance("close");
          break;
        }

        case "close": {
          const elapsed = now - phaseStart;
          r.recording = elapsed >= LEAD_IN_MS;
          if (r.recording && fresh && Number.isFinite(s.ratio)) {
            r.close.push(s.ratio);
            // Count actual open→closed→open cycles rather than seconds. Four deliberate
            // pinches is a cloud; four seconds of a hand that never closed is not, and the
            // difference matters most for exactly the visitor whose pinch does not read.
            r.ratioMax = Math.max(r.ratioMax, s.ratio);
            if (!r.closed && s.ratio < r.ratioMax - 0.25) r.closed = true;
            else if (r.closed && s.ratio > r.ratioMax - 0.1) {
              r.closed = false;
              r.cycles += 1;
            }
          }
          setProgress(r.recording ? Math.min(1, r.cycles / PINCH_CYCLES) : 0);
          setNote(
            r.recording && elapsed > LEAD_IN_MS + 8000 && r.cycles === 0
              ? "Nothing is registering — that is a result too. A fist will be used instead."
              : "",
          );
          if (r.cycles >= PINCH_CYCLES || elapsed > CLOSE_CAP_MS) {
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
          setProgress(Math.min(1, (now - phaseStart) / REACH_MS));
          break;
        }

        default:
          break;
      }

      setRecording(r.recording);
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

  /** Wipe every recording and go back to the beginning. */
  const restart = useCallback(() => {
    rec.current = {
      ...rec.current,
      sweep: [],
      still: [],
      open: [],
      close: [],
      recording: false,
      held: 0,
      recent: [],
      ratioMax: 0,
      closed: false,
      cycles: 0,
      box: null,
      retries: 0,
    };
    setReached([]);
    setResult(null);
    setNote("");
    setProgress(0);
    setPhase("seek");
  }, []);

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

        {phase !== "done" && phase !== "reach" && phase !== "seek" && (
          <div className={`cal-bar ${recording ? "is-live" : ""}`}>
            <div className="cal-bar__fill" style={{ transform: `scaleX(${progress})` }} />
            <span className="cal-bar__label">{recording ? "measuring" : "get ready…"}</span>
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
        // a badly wrong one, which is exactly the situation somebody would be leaving from.
        <div className="cal-actions">
          <button type="button" data-hover className="cal-btn" onClick={restart}>
            Start over
          </button>
          <button type="button" data-hover className="cal-btn" onClick={() => finish(null)}>
            Skip — use the default settings
          </button>
        </div>
      )}
    </div>
  );
}

/** RMS spread of a short run of positions — "is this hand actually still?" */
function spread(points: Array<{ x: number; y: number }>): number {
  if (points.length < 4) return Number.POSITIVE_INFINITY;
  const mx = points.reduce((a, p) => a + p.x, 0) / points.length;
  const my = points.reduce((a, p) => a + p.y, 0) / points.length;
  return Math.sqrt(
    points.reduce((a, p) => a + (p.x - mx) ** 2 + (p.y - my) ** 2, 0) / points.length,
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
    title: "Draw an easy circle, twice round",
    hint: "No need to stretch. Move your hand in a relaxed circle in front of you — whatever size feels natural — and go round twice. The screen will be fitted to that.",
  },
  still: {
    step: "2 of 4",
    title: "Now hold it still",
    hint: "Hold your hand steady for a couple of seconds. This measures how much the picture shakes when you do not.",
  },
  open: {
    step: "3 of 4",
    title: "Hold your hand open",
    hint: "Fingers spread, facing the camera.",
  },
  close: {
    step: "3 of 4",
    title: "Pinch, and open again — four times",
    hint: "Slowly. Touch your thumb and finger together, then open the hand right up. If nothing registers, that is a finding, and a fist will be used instead.",
  },
  reach: {
    step: "4 of 4",
    title: "Touch all four corners",
    hint: "Move the cursor into each dot. They should all sit inside the circle you drew — this is the part that proves it.",
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
