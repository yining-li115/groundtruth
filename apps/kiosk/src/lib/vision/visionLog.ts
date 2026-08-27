import type { PointerState } from "./handPointer";
import { onReject, VISION_LOG, type RejectReason } from "./trace";

/**
 * The repeatable physical-experiment harness: a metronome, a recorder, and a file.
 *
 * WHY A GUIDED RUN AND NOT JUST A LOG. The numbers the audit needs are conditional —
 * "pinches recognised GIVEN a hand was found", "clicks emitted GIVEN a pinch was recognised" —
 * and a conditional needs a denominator. A passive log cannot supply one: it records what the
 * system saw, and the whole question is what it FAILED to see. Only the person in front of the
 * camera knows they just pinched. So the screen asks for each attempt on a fixed cadence, and
 * an attempt that produced no trace at all is still an attempt, still counted, and still in
 * the file. That is the difference between measuring recall and measuring precision, and it is
 * why the earlier fixture (`scripts/fixtures/pinch-trials.json`) had to carry its ground truth
 * as a hand-written `expected` field.
 *
 * REST RUNS EXIST FOR THE SAME REASON. `?run=rest` asks the visitor to stand there with a hand
 * up and do nothing. Every click during a rest window is a false positive with a denominator
 * attached, which is the only form in which a false-positive rate means anything.
 *
 * Usage at the wall:
 *
 *   /?enter=1&visionDebug=1&run=pinch&dist=2.0&n=20
 *   /?enter=1&visionDebug=1&run=fist&dist=2.0&n=20
 *   /?enter=1&visionDebug=1&run=rest&dist=2.0&n=10
 *
 * The page counts you in, prompts twenty times, then downloads one JSON file. Feed the files
 * to `node scripts/vision-audit.mjs <files…>` for the metric table.
 *
 * Nothing in here runs unless a `run=` or `visionLog=1` parameter is present.
 */

const PARAMS = typeof window === "undefined" ? null : new URLSearchParams(location.search);

export type RunKind = "pinch" | "fist" | "rest";

export interface RunSpec {
  kind: RunKind;
  /** the stated standing distance, in metres — a label, not a measurement */
  distanceM: number;
  /** how many attempts to prompt for */
  attempts: number;
  /** how long each attempt window lasts, ms */
  periodMs: number;
  /** a quiet lead-in, so the first attempt is not made while the visitor is still reading */
  leadInMs: number;
  /** free-text, e.g. the camera model — carried into the file so a run is identifiable later */
  note: string;
}

/** Parse `?run=pinch&dist=2.0&n=20&period=3000` — absent `run` means passive logging only. */
export function runSpec(): RunSpec | null {
  const kind = PARAMS?.get("run");
  if (kind !== "pinch" && kind !== "fist" && kind !== "rest") return null;
  const num = (k: string, d: number) => {
    const v = Number(PARAMS?.get(k));
    return Number.isFinite(v) && v > 0 ? v : d;
  };
  return {
    kind,
    distanceM: num("dist", 0),
    attempts: Math.round(num("n", 20)),
    periodMs: num("period", 3000),
    leadInMs: num("leadIn", 4000),
    note: PARAMS?.get("note") ?? "",
  };
}

/**
 * One recorded frame, as a flat array. Self-describing via `COLUMNS`.
 *
 * Flat rather than an object because twenty attempts at three seconds is close to two thousand
 * frames, and a run is meant to be small enough to mail to somebody.
 */
export const COLUMNS = [
  "t", // ms since the run started
  "present", // the pointer trusts a hand (past enterMs)
  "hand", // landmarks in this frame at all
  "palmPx", // palm width in TRUE camera pixels
  "aperturePx", // thumb tip → index tip, in true camera pixels
  "ratio3", // PRODUCTION feature: world 3D aperture / world 3D span
  "ratio2", // candidate: the same with z dropped
  "ratioPx", // candidate: image-plane pixel aperture / pixel span
  "apertureZ", // how much of the 3D aperture is pure inferred depth, metres
  "raw", // the raw posture latch, before the debounce
  "pinched", // the debounced press the interaction layer sees
  "phase", // gesture FSM phase, as an index into PHASES
  "vel", // cursor speed, screen fractions per second
  "reject", // index into REJECTS, or -1
] as const;

export const PHASES = ["IDLE", "CLOSING", "ARMING", "HELD", "DRAGGING", "SUPPRESSED"] as const;

export const REJECTS: RejectReason[] = [
  "HAND_NOT_FOUND",
  "NO_INTERACTION_BOX",
  "HAND_TOO_SMALL",
  "LANDMARK_UNSTABLE",
  "PINCH_SCORE_ABOVE_THRESHOLD",
  "PINCH_TOO_SHORT",
  "PINCH_HELD_TOO_LONG",
  "PINCH_RELEASE_NOT_FOUND",
  "RECLASSIFIED_AS_DRAG",
  "POINTER_MOTION_SUPPRESSED_CLICK",
  "NO_CLICK_TARGET",
  "CLICK_ON_INERT_TARGET",
  "CLICK_SUPPRESSED",
];

export interface RunEvent {
  t: number;
  type: "cue" | "press" | "release" | "click" | "reject" | "drag";
  detail: string;
}

export interface AttemptWindow {
  i: number;
  kind: RunKind;
  /** ms since run start: when the prompt appeared, and when the window closed */
  cueAt: number;
  endAt: number;
}

export interface VisionRun {
  version: 1;
  spec: RunSpec;
  /** everything the camera actually turned out to be — Phase 2, recorded not assumed */
  camera: CameraFacts;
  startedAt: string;
  userAgent: string;
  columns: typeof COLUMNS;
  phases: typeof PHASES;
  rejects: RejectReason[];
  attempts: AttemptWindow[];
  frames: number[][];
  events: RunEvent[];
}

/** What the browser ACTUALLY gave us, as distinct from what was asked for. */
export interface CameraFacts {
  /** the constraint the code requested — kept only so the two can be compared */
  requested: { width: number; height: number };
  /** `video.videoWidth` / `videoHeight`: the decoded frame size */
  videoWidth: number;
  videoHeight: number;
  /** `track.getSettings()` — the device's own account of itself */
  settings: Record<string, unknown>;
  /** the track's reported label and capabilities, where the browser exposes them */
  label: string;
  /** measured, not declared: frames per second through the whole pipeline */
  measuredFps: number;
  /** the video element's CSS box, which must NOT be what the model sees */
  cssWidth: number;
  cssHeight: number;
}

export function cameraFacts(video: HTMLVideoElement | null, measuredFps: number): CameraFacts {
  const stream = video?.srcObject instanceof MediaStream ? video.srcObject : null;
  const track = stream?.getVideoTracks()[0] ?? null;
  const rect = video?.getBoundingClientRect();
  return {
    requested: { width: 1280, height: 720 },
    videoWidth: video?.videoWidth ?? 0,
    videoHeight: video?.videoHeight ?? 0,
    settings: (track?.getSettings?.() as Record<string, unknown>) ?? {},
    label: track?.label ?? "",
    measuredFps,
    cssWidth: rect?.width ?? 0,
    cssHeight: rect?.height ?? 0,
  };
}

type RunPhase = "waiting" | "leadIn" | "running" | "done";

/**
 * The recorder. One instance, driven from the same rAF loop as everything else.
 *
 * It is deliberately a plain object with a `tick`, not a hook: the pointer loop already runs
 * once per frame and the log has to be sampled on exactly those frames, not on React's.
 */
class VisionLog {
  readonly spec = runSpec();
  phase: RunPhase = "waiting";
  /** which attempt is being prompted, 0-based; -1 before the first */
  index = -1;
  /** 0..1 through the current attempt window, for the prompt's own countdown */
  progress = 0;

  private t0 = 0;
  private startedAt = "";
  private frames: number[][] = [];
  private events: RunEvent[] = [];
  private attempts: AttemptWindow[] = [];
  private unsub: (() => void) | null = null;
  private lastRun: VisionRun | null = null;

  get active(): boolean {
    return this.phase === "leadIn" || this.phase === "running";
  }

  get enabled(): boolean {
    return VISION_LOG;
  }

  get frameCount(): number {
    return this.frames.length;
  }

  get result(): VisionRun | null {
    return this.lastRun;
  }

  start(): void {
    if (!VISION_LOG || this.active) return;
    this.t0 = performance.now();
    this.startedAt = new Date().toISOString();
    this.frames = [];
    this.events = [];
    this.attempts = [];
    this.index = -1;
    this.progress = 0;
    this.phase = this.spec ? "leadIn" : "running";
    this.unsub = onReject((r) =>
      this.event("reject", `${r.reason}${r.detail ? ` (${r.detail})` : ""}`, r.at),
    );
  }

  /** Record something discrete. `at` is a performance.now() stamp; defaults to right now. */
  event(type: RunEvent["type"], detail = "", at = performance.now()): void {
    if (!this.active) return;
    this.events.push({ t: Math.round(at - this.t0), type, detail });
  }

  /** One frame. Called from the pointer loop, after the state has been updated. */
  tick(s: PointerState): void {
    if (!this.active) return;
    const t = performance.now() - this.t0;

    // Advance the metronome first, so the cue event lands on the frame the prompt changes.
    if (this.spec) {
      const { leadInMs, periodMs, attempts } = this.spec;
      if (this.phase === "leadIn" && t >= leadInMs) this.phase = "running";
      if (this.phase === "running") {
        const elapsed = t - leadInMs;
        const i = Math.floor(elapsed / periodMs);
        this.progress = (elapsed % periodMs) / periodMs;
        if (i >= attempts) {
          this.finish();
          return;
        }
        if (i !== this.index) {
          this.index = i;
          const cueAt = Math.round(leadInMs + i * periodMs);
          this.attempts.push({
            i,
            kind: this.spec.kind,
            cueAt,
            endAt: cueAt + periodMs,
          });
          this.event("cue", `${this.spec.kind} ${i + 1}/${attempts}`, this.t0 + cueAt);
        }
      }
    }

    const f = s.features;
    this.frames.push([
      Math.round(t),
      s.present ? 1 : 0,
      // The explicit flag, NOT "is the pixel span a number" — that test is also false when the
      // frame size is unknown, which silently zeroed the denominator of every recall figure.
      s.handSeen ? 1 : 0,
      r2(s.palmPx),
      r2(f.aperturePx),
      r3(f.ratioWorld3D),
      r3(f.ratioWorld2D),
      r3(f.ratioPx),
      r3(f.apertureZM),
      s.rawHeld ? 1 : 0,
      s.pinched ? 1 : 0,
      PHASES.indexOf(s.phase),
      r2(s.velocity),
      s.reject ? REJECTS.indexOf(s.reject) : -1,
    ]);
  }

  /** Close the run, build the file, and hand it to the browser. */
  finish(video?: HTMLVideoElement | null, fps = 0): VisionRun | null {
    if (!this.active) return this.lastRun;
    this.phase = "done";
    this.unsub?.();
    this.unsub = null;
    const run: VisionRun = {
      version: 1,
      spec: this.spec ?? {
        kind: "rest",
        distanceM: 0,
        attempts: 0,
        periodMs: 0,
        leadInMs: 0,
        note: "passive",
      },
      camera: cameraFacts(video ?? this.video, fps || this.fps),
      startedAt: this.startedAt,
      userAgent: typeof navigator === "undefined" ? "" : navigator.userAgent,
      columns: COLUMNS,
      phases: PHASES,
      rejects: REJECTS,
      attempts: this.attempts,
      frames: this.frames,
      events: this.events,
    };
    this.lastRun = run;
    if (typeof window !== "undefined") {
      // The driver reads this; a human gets the download below.
      (window as unknown as { __visionRun?: VisionRun }).__visionRun = run;
    }
    download(run);
    return run;
  }

  /** The HUD hands these over so `finish()` can stamp the camera without plumbing them. */
  video: HTMLVideoElement | null = null;
  fps = 0;
}

const r2 = (v: number) => (Number.isFinite(v) ? Math.round(v * 100) / 100 : -1);
const r3 = (v: number) => (Number.isFinite(v) ? Math.round(v * 1000) / 1000 : -1);

function download(run: VisionRun): void {
  if (typeof document === "undefined") return;
  const name = `vision-${run.spec.kind}-${run.spec.distanceM || "x"}m-${run.startedAt.replace(
    /[:.]/g,
    "-",
  )}.json`;
  const blob = new Blob([JSON.stringify(run)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
}

export const visionLog = new VisionLog();

// Exposed so a scripted driver can follow the metronome and read the finished run back out
// without going through a browser download. Only when the audit is switched on.
if (VISION_LOG && typeof window !== "undefined") {
  (window as unknown as { __visionLog?: VisionLog }).__visionLog = visionLog;
}
