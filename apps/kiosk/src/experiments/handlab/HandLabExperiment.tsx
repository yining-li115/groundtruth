import { useEffect, useRef, useState } from "react";
import { dark } from "@groundtruth/tokens";
import { HAND_BONES, JOINT, VisionEngine, type Landmark } from "../../lib/vision/mediapipe";
import {
  DEFAULT_BOX,
  PinchDetector,
  confidence,
  interactionBox,
  mapToBox,
  palmCenter,
  palmWidthNorm,
  type Confidence,
  type InteractionBox,
} from "../../lib/vision/calibration";
import {
  PROTOCOL,
  aperture,
  discriminability,
  jitterPx,
  palmSpan,
  pinchVerdict,
  summarise,
  type Sample,
  type Trial,
  type TrialKind,
} from "./handMetrics";
import "./handlab.css";

/**
 * Hand lab (/?exp=handlab) — an instrument, not an interface.
 *
 * Step 0 of moving the kiosk to hand control. Before any of the interaction is designed there
 * is one question that can invalidate all of it: at the distance a visitor actually stands
 * from a screen behind glass, with one webcam, can a PINCH be told apart from an open hand?
 * Vision Pro's whole grammar rests on pinch, but it reads the hand from twelve cameras half a
 * metre away; we have one, at two to three metres. That gap is not a detail to be tuned later.
 *
 * An earlier attempt at pinch here was abandoned as unworkable (see `useHandFlight`), but it
 * measured the aperture in FRAME units, where stepping backwards is arithmetically identical
 * to pinching. This lab measures in world space and as a ratio to palm width, which is the
 * measurement that earlier verdict deserved — so the question is genuinely open again.
 *
 * The output is a protocol, not an impression: five scripted trials at a stated standing
 * distance, rolled up into a discriminability score with a written-down decision rule, plus
 * the jitter, reach and detection numbers that every threshold downstream will be tuned from.
 * Run it at 1.5m, 2m and 3m, then export the JSON.
 *
 * Nothing here ships. It imports the vision engine and the tokens and touches nothing else.
 */

const PARAMS = typeof window === "undefined" ? null : new URLSearchParams(location.search);
const num = (k: string, d: number) => {
  const v = Number(PARAMS?.get(k));
  return Number.isFinite(v) && PARAMS?.get(k) !== null ? v : d;
};

/**
 * Pinch trigger points, as FRACTIONS of this hand's own rolling open-posture ratio — see
 * `PinchCalibrator`. Meta's published Quest figures (1.6cm on, 3.0cm off) were the starting
 * point and measured out as unusable here: they never fired once across two runs of ten
 * deliberate pinches, because MediaPipe reads a firm pinch at roughly 5cm.
 */
const PINCH_ON_FRAC = num("on", 0.72);
const PINCH_OFF_FRAC = num("off", 0.88);
/** Interaction box, in face widths — overridable to tune the mapping without a rebuild. */
const BOX = {
  widthFaces: num("boxw", DEFAULT_BOX.widthFaces),
  heightFaces: num("boxh", DEFAULT_BOX.heightFaces),
  dropFaces: num("boxdrop", DEFAULT_BOX.dropFaces),
};
/** Countdown before a trial records, so there is time to get into position. */
const READY_S = num("ready", 3);
/** How many fingertip samples the magnified jitter trace keeps. */
const TRACE_N = 90;
/** The trace is meaningless at 1:1 — this is how far it is blown up to make jitter visible. */
const TRACE_ZOOM = num("zoom", 900);
/** Screen width the jitter figure is converted to, so "how many pixels does it wander" is real. */
const SCREEN_W = num("screen", 3840);

type Status = "idle" | "loading" | "running" | "error";
type Phase = "idle" | "ready" | "recording";

interface Live {
  hands: number;
  ratio: number;
  pinchWorld: number;
  pinchNorm: number;
  span: number;
  faceW: number;
  pinched: boolean;
  reps: number;
  fps: number;
  inferMs: number;
  /** auto-calibration: where the hand maps to on the screen, and how much to trust it */
  u: number;
  v: number;
  outside: boolean;
  conf: Confidence;
  palmPx: number;
  thresholds: { on: number; off: number };
  /** box had to slide back into frame (normal at close range) vs was cut (too close) */
  boxShifted: boolean;
}

const LIVE0: Live = {
  hands: 0,
  ratio: Number.NaN,
  pinchWorld: Number.NaN,
  pinchNorm: Number.NaN,
  span: Number.NaN,
  faceW: 0,
  pinched: false,
  reps: 0,
  fps: 0,
  inferMs: 0,
  u: 0.5,
  v: 0.5,
  outside: false,
  conf: { value: 0, reason: "no-face" },
  palmPx: Number.NaN,
  thresholds: { on: 0.72, off: 0.88 },
  boxShifted: false,
};

/** What each confidence reason should tell the visitor to do — the point of reporting it. */
const CONF_HINT: Record<Confidence["reason"], string> = {
  ok: "可用",
  "no-face": "没看到人 — 交互框需要脸做尺度基准",
  "too-close": "太近 — 交互框被画面切掉了，胸口不在镜头里，够不到屏幕边缘",
  "too-far": "太远 — 手在传感器上太小，指节几何已经不可靠",
  "hand-too-small": "偏远 — 还能用，但捏合会开始漏检",
  "no-hand": "没看到手",
};

const fmt = (v: number, digits = 3) => (Number.isFinite(v) ? v.toFixed(digits) : "—");
const cm = (v: number) => (Number.isFinite(v) ? `${(v * 100).toFixed(1)} cm` : "—");
const pct = (v: number) => `${(v * 100).toFixed(1)}%`;

export function HandLabExperiment() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const skeletonRef = useRef<HTMLCanvasElement>(null);
  const traceRef = useRef<HTMLCanvasElement>(null);
  const screenRef = useRef<HTMLCanvasElement>(null);

  const [status, setStatus] = useState<Status>("idle");
  const [error, setError] = useState<string | null>(null);
  const [live, setLive] = useState<Live>(LIVE0);
  const [trials, setTrials] = useState<Trial[]>([]);
  const [distance, setDistance] = useState(2);
  const [phase, setPhase] = useState<Phase>("idle");
  const [step, setStep] = useState(0);
  const [remain, setRemain] = useState(0);

  /** Per-frame state the raf loop owns; React never re-renders for it. */
  const liveRef = useRef<Live>({ ...LIVE0 });
  const traceRef2 = useRef<Array<{ x: number; y: number }>>([]);
  /** The pinch state machine runs continuously — a trial only snapshots its counter. */
  const latchRef = useRef(new PinchDetector(PINCH_ON_FRAC, PINCH_OFF_FRAC));
  /** Latest auto-calibrated box, for the overlay. */
  const boxRef = useRef<InteractionBox | null>(null);
  const recRef = useRef<{
    kind: TrialKind;
    expectedReps: number | null;
    distanceM: number;
    t0: number;
    endsAt: number;
    repsAt0: number;
    samples: Sample[];
  } | null>(null);
  /** Set by the buttons, read by the loop — so starting a trial can't race a frame. */
  const requestRef = useRef<{ index: number; distanceM: number } | null>(null);
  const phaseRef = useRef<{ phase: Phase; until: number }>({ phase: "idle", until: 0 });
  const finishedRef = useRef<Trial | null>(null);

  useEffect(() => {
    let raf = 0;
    let stopped = false;
    let stream: MediaStream | null = null;
    const engine = new VisionEngine();
    const video = videoRef.current;
    if (!video) return;

    let lastTs = 0;
    let frames = 0;
    let fpsAt = performance.now();
    let uiAt = 0;
    let nextId = 1;

    (async () => {
      try {
        setStatus("loading");
        if (!navigator.mediaDevices?.getUserMedia) {
          throw new Error(
            "camera API unavailable — open via http://localhost:5173 (or HTTPS); " +
              "insecure http://<LAN-IP> origins block the webcam",
          );
        }
        // Ask for the highest sane resolution: this lab is measuring the LIMIT of what the
        // camera can resolve at distance, and 640×480 would measure the limit of the request
        // instead. `ideal` rather than `exact` so a modest webcam still starts.
        stream = await navigator.mediaDevices.getUserMedia({
          video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: "user" },
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
          if (video.readyState < 2) return;

          let ts = performance.now();
          if (ts <= lastTs) ts = lastTs + 1;
          lastTs = ts;

          const before = performance.now();
          const res = engine.process(video, ts);
          const inferMs = performance.now() - before;
          const now = performance.now();

          frames += 1;
          if (now - fpsAt > 500) {
            liveRef.current.fps = (frames / (now - fpsAt)) * 1000;
            frames = 0;
            fpsAt = now;
          }

          const hand = res.hands[0] ?? null;
          const pinchWorld = aperture(hand?.world);
          const pinchNorm = aperture(hand?.landmarks);
          const span = palmSpan(hand?.world);
          const ratio = pinchWorld / span;
          const idx = hand?.landmarks[JOINT.indexTip];
          const wrist = hand?.landmarks[JOINT.wrist];

          const pinched = latchRef.current.update(ratio);

          // --- auto-calibration: face gives the scale, the box follows the body ---
          const aspect = video.videoHeight > 0 ? video.videoWidth / video.videoHeight : 16 / 9;
          const box = interactionBox(res.face, aspect, BOX);
          boxRef.current = box;
          const palm = palmCenter(hand?.landmarks);
          const palmPx = palmWidthNorm(hand?.landmarks) * (video.videoWidth || 1);
          const mapped = box && palm ? mapToBox(box, palm) : null;

          const l = liveRef.current;
          l.hands = res.hands.length;
          l.ratio = ratio;
          l.pinchWorld = pinchWorld;
          l.pinchNorm = pinchNorm;
          l.span = span;
          l.faceW = res.face?.w ?? 0;
          l.pinched = pinched;
          l.reps = latchRef.current.count;
          l.inferMs = inferMs;
          l.u = mapped?.u ?? l.u;
          l.v = mapped?.v ?? l.v;
          l.outside = mapped?.outside ?? false;
          l.palmPx = palmPx;
          l.conf = confidence(res.face, box, palmPx);
          l.thresholds = latchRef.current.thresholds;
          l.boxShifted = box?.shifted ?? false;

          if (idx) {
            const trace = traceRef2.current;
            trace.push({ x: idx.x, y: idx.y });
            if (trace.length > TRACE_N) trace.shift();
          }

          drawSkeleton(
            skeletonRef.current,
            video,
            res.hands.map((h) => h.landmarks),
            pinched,
            box,
            res.face,
          );
          drawTrace(traceRef.current, traceRef2.current);
          drawScreen(screenRef.current, l.u, l.v, pinched, l.conf.value, !!palm);

          // --- trial state machine ---
          const req = requestRef.current;
          if (req) {
            requestRef.current = null;
            phaseRef.current = { phase: "ready", until: now + READY_S * 1000 };
            recRef.current = {
              kind: PROTOCOL[req.index]!.kind,
              expectedReps: PROTOCOL[req.index]!.expectedReps,
              distanceM: req.distanceM,
              t0: 0,
              endsAt: 0,
              repsAt0: 0,
              samples: [],
            };
            setPhase("ready");
          }

          const ph = phaseRef.current;
          const rec = recRef.current;
          if (ph.phase === "ready" && rec) {
            if (now >= ph.until) {
              rec.t0 = now;
              rec.repsAt0 = latchRef.current.count;
              const seconds = PROTOCOL.find((p) => p.kind === rec.kind)?.seconds ?? 6;
              rec.endsAt = now + seconds * 1000;
              phaseRef.current = { phase: "recording", until: rec.endsAt };
              setPhase("recording");
            }
          } else if (ph.phase === "recording" && rec) {
            rec.samples.push({
              t: now - rec.t0,
              pinchWorld,
              pinchNorm,
              span,
              ratio,
              ix: idx?.x ?? Number.NaN,
              iy: idx?.y ?? Number.NaN,
              wx: wrist?.x ?? Number.NaN,
              wy: wrist?.y ?? Number.NaN,
              faceW: res.face?.w ?? 0,
              hands: res.hands.length,
              inferMs,
            });
            if (now >= ph.until) {
              const trial = summarise(
                nextId,
                rec.kind,
                rec.distanceM,
                rec.expectedReps,
                latchRef.current.count - rec.repsAt0,
                rec.samples,
              );
              nextId += 1;
              finishedRef.current = trial;
              recRef.current = null;
              phaseRef.current = { phase: "idle", until: 0 };
              setPhase("idle");
            }
          }

          // --- throttled UI ---
          if (now - uiAt > 100) {
            uiAt = now;
            setLive({ ...liveRef.current });
            const until = phaseRef.current.until;
            setRemain(until ? Math.max(0, (until - now) / 1000) : 0);
            const done = finishedRef.current;
            if (done) {
              finishedRef.current = null;
              setTrials((prev) => [...prev, done]);
              setStep((s) => Math.min(PROTOCOL.length - 1, s + 1));
            }
          }
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
  }, []);

  const startTrial = (index: number) => {
    if (phase !== "idle" || status !== "running") return;
    setStep(index);
    requestRef.current = { index, distanceM: distance };
  };

  const exportJson = () => {
    const payload = {
      recordedWith: {
        pinchOnFrac: PINCH_ON_FRAC,
        pinchOffFrac: PINCH_OFF_FRAC,
        box: BOX,
        screenWidthPx: SCREEN_W,
        userAgent: navigator.userAgent,
      },
      trials,
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `handlab-${trials.length}trials.json`;
    a.click();
    URL.revokeObjectURL(a.href);
    console.log("[handlab]", payload);
  };

  const verdicts = buildVerdicts(trials);
  const current = PROTOCOL[step]!;

  return (
    <div className="hl-root" data-theme="dark">
      <header className="hl-head">
        <h1 className="hl-title">HAND LAB</h1>
        <p className="hl-sub">
          第 0 步 · 捏合在 kiosk 距离上到底能不能用。按 1→5 跑完一轮，换个站距再跑一轮，最后导出 JSON。
        </p>
        <div className={`hl-status hl-status--${status}`}>
          {status === "loading" && "loading models…"}
          {status === "running" && `running · ${live.fps.toFixed(0)} fps · ${live.inferMs.toFixed(1)} ms/frame`}
          {status === "error" && `error: ${error ?? "unknown"}`}
          {status === "idle" && "idle"}
        </div>
      </header>

      <div className="hl-grid">
        {/* --- camera + skeleton --- */}
        <section className="hl-panel hl-panel--cam">
          <div className="hl-mirror">
            <video ref={videoRef} className="hl-video" playsInline muted />
            <canvas ref={skeletonRef} className="hl-skeleton" />
          </div>
          <div className={`hl-pinch ${live.pinched ? "is-on" : ""}`}>
            {live.pinched ? "PINCH" : "open"} · {live.reps} 次
          </div>

          <h2 className="hl-h2" style={{ marginTop: "0.8rem" }}>
            自动校准 · 映射到屏幕
          </h2>
          <canvas ref={screenRef} className="hl-screen" width={320} height={180} />
          <div className={`hl-conf hl-conf--${live.conf.reason === "ok" ? "good" : "warn"}`}>
            {CONF_HINT[live.conf.reason]}
            {live.boxShifted ? <span className="hl-muted"> · 框已上移以留在画面内</span> : null}
          </div>
          <p className="hl-note">
            蓝框 = 自动交互框（{BOX.widthFaces}×{BOX.heightFaces} 个脸宽，脸下方 {BOX.dropFaces}
            ）。装不下时先整体挪，实在太大才切（虚线）。上图四角是必须够得到的目标 ——
            划一圈手臂，看点能不能碰到四个角。
          </p>
        </section>

        {/* --- live numbers --- */}
        <section className="hl-panel">
          <h2 className="hl-h2">实时读数</h2>
          <div className="hl-big">
            <span className="hl-big__v">{fmt(live.ratio, 2)}</span>
            <span className="hl-big__k">捏合 / 掌宽（无量纲，主指标）</span>
          </div>
          <dl className="hl-dl">
            <dt>捏合距离（world）</dt>
            <dd>{cm(live.pinchWorld)}</dd>
            <dt>掌宽（world）</dt>
            <dd>{cm(live.span)}</dd>
            <dt>捏合距离（帧归一化）</dt>
            <dd className="hl-muted">{fmt(live.pinchNorm)} ← 随站距漂移，仅作对照</dd>
            <dt>判定线（固定）</dt>
            <dd>
              &lt;{fmt(live.thresholds.on, 2)} 捏 / &gt;{fmt(live.thresholds.off, 2)} 松
            </dd>
            <dt>人脸宽度 / 画面</dt>
            <dd>{fmt(live.faceW)} （距离的尺）</dd>
            <dt>手掌像素宽</dt>
            <dd>{Number.isFinite(live.palmPx) ? `${live.palmPx.toFixed(0)} px` : "—"}</dd>
            <dt>指到屏幕</dt>
            <dd>
              {fmt(live.u, 2)}, {fmt(live.v, 2)}
              {live.outside ? <span className="hl-muted"> · 出框</span> : null}
            </dd>
            <dt>手数</dt>
            <dd>{live.hands}</dd>
          </dl>
          <h2 className="hl-h2">静止抖动（放大 {TRACE_ZOOM}×）</h2>
          <canvas ref={traceRef} className="hl-trace" width={260} height={160} />
          <p className="hl-note">
            食指指尖最近 {TRACE_N} 帧。圆圈 = 1 个标准差。手不动时这团越大，光标就越需要滤波。
          </p>
        </section>

        {/* --- protocol runner --- */}
        <section className="hl-panel">
          <h2 className="hl-h2">测量流程</h2>
          <label className="hl-field">
            站立距离（米）
            <input
              type="number"
              step="0.5"
              min="0.5"
              max="6"
              value={distance}
              onChange={(e) => setDistance(Number(e.target.value))}
              disabled={phase !== "idle"}
            />
          </label>

          <ol className="hl-steps">
            {PROTOCOL.map((p, i) => {
              const done = trials.some((t) => t.kind === p.kind && t.distanceM === distance);
              return (
                <li key={p.kind} className={i === step ? "is-current" : ""}>
                  <button
                    type="button"
                    className="hl-btn"
                    onClick={() => startTrial(i)}
                    disabled={phase !== "idle" || status !== "running"}
                  >
                    {done ? "↻ " : ""}
                    {p.label}
                    <span className="hl-btn__s">{p.seconds}s</span>
                  </button>
                </li>
              );
            })}
          </ol>

          <div className={`hl-runner hl-runner--${phase}`}>
            {phase === "idle" && <span className="hl-muted">{current.hint}</span>}
            {phase === "ready" && (
              <>
                <strong>准备… {remain.toFixed(1)}s</strong>
                <span>{current.hint}</span>
              </>
            )}
            {phase === "recording" && (
              <>
                <strong>● 录制中 {remain.toFixed(1)}s</strong>
                <span>{current.hint}</span>
              </>
            )}
          </div>
        </section>
      </div>

      {/* --- the decision --- */}
      <section className="hl-panel hl-panel--wide">
        <h2 className="hl-h2">结论</h2>
        {verdicts.length === 0 ? (
          <p className="hl-muted">
            在同一站距上跑完「张开静止」和「捏住静止」两项后，这里给出可分性 d 和判定。
          </p>
        ) : (
          <table className="hl-table">
            <thead>
              <tr>
                <th>站距</th>
                <th>d（比值）</th>
                <th>d（world）</th>
                <th>张开 μ±σ</th>
                <th>捏合 μ±σ</th>
                <th>静止抖动</th>
                <th>判定</th>
              </tr>
            </thead>
            <tbody>
              {verdicts.map((v) => (
                <tr key={v.distanceM}>
                  <td>{v.distanceM} m</td>
                  <td className={`hl-d hl-d--${v.verdict.band}`}>{fmt(v.dRatio, 2)}</td>
                  <td>{fmt(v.dWorld, 2)}</td>
                  <td>
                    {fmt(v.open.mean, 2)} ± {fmt(v.open.sd, 3)}
                  </td>
                  <td>
                    {fmt(v.pinched.mean, 2)} ± {fmt(v.pinched.sd, 3)}
                  </td>
                  <td>
                    {v.jitterPx.toFixed(1)} px<span className="hl-muted"> @{SCREEN_W}</span>
                  </td>
                  <td className={`hl-d--${v.verdict.band}`}>{v.verdict.text}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {/* --- everything recorded --- */}
      <section className="hl-panel hl-panel--wide">
        <div className="hl-rowhead">
          <h2 className="hl-h2">记录（{trials.length}）</h2>
          <div className="hl-actions">
            <button type="button" className="hl-btn hl-btn--ghost" onClick={() => setTrials([])}>
              清空
            </button>
            <button type="button" className="hl-btn" onClick={exportJson} disabled={!trials.length}>
              导出 JSON
            </button>
          </div>
        </div>
        <table className="hl-table">
          <thead>
            <tr>
              <th>#</th>
              <th>项目</th>
              <th>站距</th>
              <th>比值 μ±σ</th>
              <th>捏合 μ</th>
              <th>掌宽 μ</th>
              <th>捏合次数</th>
              <th>检出率</th>
              <th>掉帧</th>
              <th>抖动 x/y</th>
              <th>可及范围</th>
              <th>fps</th>
            </tr>
          </thead>
          <tbody>
            {trials.map((t) => (
              <tr key={t.id}>
                <td>{t.id}</td>
                <td>{t.kind}</td>
                <td>{t.distanceM} m</td>
                <td>
                  {fmt(t.ratio.mean, 2)} ± {fmt(t.ratio.sd, 3)}
                </td>
                <td>{cm(t.pinchWorld.mean)}</td>
                <td>{cm(t.span.mean)}</td>
                <td>
                  {t.expectedReps === null ? (
                    t.detectedReps > 0 ? (
                      <span className="hl-d--bad">{t.detectedReps} 误触</span>
                    ) : (
                      "—"
                    )
                  ) : (
                    <span className={t.detectedReps === t.expectedReps ? "hl-d--good" : "hl-d--bad"}>
                      {t.detectedReps} / {t.expectedReps}
                    </span>
                  )}
                </td>
                <td>{pct(t.detection)}</td>
                <td>
                  {t.drops.count}
                  {t.drops.count > 0 ? ` (${t.drops.longestMs.toFixed(0)}ms)` : ""}
                </td>
                <td>
                  {jitterPx(t.jitterXFrame, SCREEN_W).toFixed(1)} /{" "}
                  {jitterPx(t.jitterYFrame, SCREEN_W).toFixed(1)} px
                </td>
                <td>
                  {fmt(t.reach.w, 2)} × {fmt(t.reach.h, 2)}
                </td>
                <td>{t.fps.toFixed(0)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}

/** Pair up the two still baselines per standing distance and score them. */
function buildVerdicts(trials: Trial[]) {
  const distances = [...new Set(trials.map((t) => t.distanceM))].sort((a, b) => a - b);
  return distances.flatMap((d) => {
    // Latest run wins — a repeated trial is a correction, not another data point.
    const open = [...trials].reverse().find((t) => t.distanceM === d && t.kind === "still-open");
    const pinch = [...trials].reverse().find((t) => t.distanceM === d && t.kind === "still-pinch");
    if (!open || !pinch) return [];
    const dRatio = discriminability(open.ratio, pinch.ratio);
    return [
      {
        distanceM: d,
        dRatio,
        dWorld: discriminability(open.pinchWorld, pinch.pinchWorld),
        open: open.ratio,
        pinched: pinch.ratio,
        jitterPx: jitterPx(Math.hypot(open.jitterXFrame, open.jitterYFrame), SCREEN_W),
        verdict: pinchVerdict(dRatio),
      },
    ];
  });
}

/** Draw the tracked skeletons, the face anchor and the auto-calibrated box over the feed. */
function drawSkeleton(
  canvas: HTMLCanvasElement | null,
  video: HTMLVideoElement,
  hands: Landmark[][],
  pinched: boolean,
  box: InteractionBox | null,
  face: { cx: number; cy: number; w: number; h: number } | null,
) {
  if (!canvas) return;
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  if (!w || !h) return;
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  const ctx = canvas.getContext("2d");
  if (!ctx || !video.videoWidth) return;
  ctx.clearRect(0, 0, w, h);

  // The face is the ruler everything else is measured against — drawn so it is obvious when
  // the box misbehaves because the FACE was lost, not because the hand was.
  if (face) {
    ctx.strokeStyle = dark.text.secondary;
    ctx.globalAlpha = 0.5;
    ctx.lineWidth = 1;
    ctx.strokeRect(
      (face.cx - face.w / 2) * w,
      (face.cy - face.h / 2) * h,
      face.w * w,
      face.h * h,
    );
  }

  // The interaction box: the region of the frame that maps onto the whole screen. A dashed
  // edge means it was cut by the frame, i.e. part of the screen is out of reach.
  if (box) {
    ctx.strokeStyle = dark.accent;
    ctx.globalAlpha = 0.85;
    ctx.lineWidth = 2;
    ctx.setLineDash(box.clamped ? [6, 5] : []);
    ctx.strokeRect(box.x0 * w, box.y0 * h, box.w * w, box.h * h);
    ctx.setLineDash([]);
    // Centre cross-hairs, so it is visible at a glance whether the box tracks the body.
    ctx.globalAlpha = 0.3;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo((box.x0 + box.w / 2) * w, box.y0 * h);
    ctx.lineTo((box.x0 + box.w / 2) * w, (box.y0 + box.h) * h);
    ctx.moveTo(box.x0 * w, (box.y0 + box.h / 2) * h);
    ctx.lineTo((box.x0 + box.w) * w, (box.y0 + box.h / 2) * h);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;

  hands.forEach((lm, i) => {
    const lead = i === 0;
    ctx.strokeStyle = lead && pinched ? dark.accent : dark.text.primary;
    ctx.lineWidth = lead ? 2 : 1;
    ctx.globalAlpha = lead ? 0.9 : 0.4;
    ctx.beginPath();
    for (const [a, b] of HAND_BONES) {
      const p = lm[a];
      const q = lm[b];
      if (!p || !q) continue;
      ctx.moveTo(p.x * w, p.y * h);
      ctx.lineTo(q.x * w, q.y * h);
    }
    ctx.stroke();

    // The two joints the whole decision rests on, marked so a bad frame is visible as a
    // wandering dot rather than as a number that quietly moved.
    const thumb = lm[JOINT.thumbTip];
    const index = lm[JOINT.indexTip];
    if (thumb && index) {
      ctx.fillStyle = dark.accent;
      for (const p of [thumb, index]) {
        ctx.beginPath();
        ctx.arc(p.x * w, p.y * h, lead ? 5 : 3, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = lead ? 0.6 : 0.25;
      ctx.strokeStyle = dark.accent;
      ctx.beginPath();
      ctx.moveTo(thumb.x * w, thumb.y * h);
      ctx.lineTo(index.x * w, index.y * h);
      ctx.stroke();
    }
  });
  ctx.globalAlpha = 1;
}

/**
 * A stand-in for the real screen: where the hand currently points, after auto-calibration.
 *
 * This is the only view that answers the question the box exists for — not "is the hand
 * tracked" but "does the hand reach the corners". Sweeping an arm and watching this dot fail
 * to reach an edge is the whole diagnosis, and no table of numbers substitutes for it.
 */
function drawScreen(
  canvas: HTMLCanvasElement | null,
  u: number,
  v: number,
  pinched: boolean,
  conf: number,
  hasHand: boolean,
) {
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const w = canvas.width;
  const h = canvas.height;
  ctx.clearRect(0, 0, w, h);

  ctx.strokeStyle = dark.border;
  ctx.lineWidth = 1;
  ctx.strokeRect(0.5, 0.5, w - 1, h - 1);
  // Corner marks: the targets a visitor has to be able to reach for the mapping to be usable.
  ctx.globalAlpha = 0.5;
  const m = 10;
  for (const [cx, cy] of [
    [m, m],
    [w - m, m],
    [m, h - m],
    [w - m, h - m],
  ] as const) {
    ctx.beginPath();
    ctx.arc(cx, cy, 4, 0, Math.PI * 2);
    ctx.stroke();
  }

  // No hand means the last known position is stale. Drawing it as a confident dot would be a
  // small lie of exactly the kind this instrument exists to catch, so it goes hollow instead.
  if (!hasHand) {
    ctx.globalAlpha = 0.35;
    ctx.strokeStyle = dark.text.secondary;
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.arc(u * w, v * h, 6, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;
    return;
  }

  ctx.globalAlpha = 0.25 + conf * 0.75; // a dim cursor IS the low-confidence signal
  ctx.fillStyle = dark.accent;
  ctx.beginPath();
  ctx.arc(u * w, v * h, pinched ? 11 : 6, 0, Math.PI * 2);
  ctx.fill();
  if (pinched) {
    ctx.globalAlpha = 0.9;
    ctx.strokeStyle = dark.text.primary;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(u * w, v * h, 16, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
}

/**
 * The jitter trace: fingertip positions of the last TRACE_N frames, blown up around their own
 * mean, with a 1σ circle. At 1:1 this noise is invisible, which is exactly why it gets
 * dismissed until it is a twitching cursor on a two-metre screen.
 */
function drawTrace(canvas: HTMLCanvasElement | null, trace: Array<{ x: number; y: number }>) {
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const w = canvas.width;
  const h = canvas.height;
  ctx.clearRect(0, 0, w, h);
  if (trace.length < 4) return;

  const mx = trace.reduce((a, p) => a + p.x, 0) / trace.length;
  const my = trace.reduce((a, p) => a + p.y, 0) / trace.length;
  const sd = Math.sqrt(
    trace.reduce((a, p) => a + (p.x - mx) ** 2 + (p.y - my) ** 2, 0) / trace.length / 2,
  );

  ctx.strokeStyle = dark.border;
  ctx.globalAlpha = 0.6;
  ctx.beginPath();
  ctx.moveTo(w / 2, 0);
  ctx.lineTo(w / 2, h);
  ctx.moveTo(0, h / 2);
  ctx.lineTo(w, h / 2);
  ctx.stroke();

  ctx.globalAlpha = 0.9;
  ctx.strokeStyle = dark.accent;
  ctx.beginPath();
  ctx.arc(w / 2, h / 2, sd * TRACE_ZOOM, 0, Math.PI * 2);
  ctx.stroke();

  ctx.strokeStyle = dark.text.primary;
  ctx.globalAlpha = 0.75;
  ctx.lineWidth = 1;
  ctx.beginPath();
  trace.forEach((p, i) => {
    const x = w / 2 + (p.x - mx) * TRACE_ZOOM;
    const y = h / 2 + (p.y - my) * TRACE_ZOOM;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.stroke();
  ctx.globalAlpha = 1;
}
