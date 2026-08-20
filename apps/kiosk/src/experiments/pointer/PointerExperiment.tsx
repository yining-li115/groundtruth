import { useEffect, useRef, useState } from "react";
import { DEFAULT_POINTER, useHandPointer } from "../../lib/vision/handPointer";
import "./pointer.css";

/**
 * Hand pointing playground (/?exp=pointer) — hit the targets.
 *
 * The lab before this measured whether the signal exists. This asks the only question left
 * that a number cannot answer: does it feel like pointing? So it is a game rather than a
 * protocol. Targets appear, you hit them by pinching or by resting on them, and the hit rate
 * and the time per target accumulate in the corner without anyone being asked to hold still
 * for six seconds.
 *
 * Everything that defines the feel is on a slider, because these values cannot be derived —
 * the 1€ filter's own authors describe tuning it by hand, in a fixed order, watching the
 * cursor. Tune `smoothing` until a still hand gives a still cursor, then `responsiveness`
 * until a fast hand stops dragging the cursor behind it. The box sliders decide how much arm
 * movement covers the screen.
 *
 * Both selection methods run at once on purpose. Pinch is the visionOS gesture and the one to
 * ship; dwell is Apple's own documented fallback, and the measurements say we will need it —
 * a third of deliberate pinches left no trace in the tracking data at all.
 */

const PARAMS = typeof window === "undefined" ? null : new URLSearchParams(location.search);
const num = (k: string, d: number) => {
  const v = Number(PARAMS?.get(k));
  return Number.isFinite(v) && PARAMS?.get(k) !== null ? v : d;
};

/** Target radius as a fraction of the smaller viewport side. Big, per Apple's targeting advice. */
const TARGET_R = num("target", 0.07);
/**
 * Targets in a round.
 *
 * A round exists at all because an endless stream of targets has no answer to "how many do I
 * have to do?", and the honest answer — "until it feels right" — is not something anyone can
 * act on. Ten is enough for a hit rate to mean something and short enough to repeat after
 * moving a slider, which is the actual loop this page is for.
 */
const ROUND = num("round", 10);

/**
 * Which of the two selection methods produced a shot.
 *
 * Recorded separately because the whole point of running both is to find out whether pinch
 * can carry the interaction. Scoring them together hides exactly the thing we need: a visitor
 * who believes their pinch worked, on a target that dwell quietly selected for them, produces
 * a hit rate that says pinch is fine when it isn't.
 */
type Via = "pinch" | "fist" | "dwell";

interface Shot {
  hit: boolean;
  ms: number;
  via: Via;
}

/** Which selection methods are live. Isolating one is how you find out if it works alone. */
type Mode = "all" | "pinch" | "fist" | "dwell";

const MODE_LABEL: Record<Mode, string> = {
  all: "全开",
  pinch: "只捏合",
  fist: "只握拳",
  dwell: "只停留",
};

/** Scatter targets away from the very edges, which the box mapping reaches least reliably. */
function newTarget(prev: { x: number; y: number } | null): { x: number; y: number } {
  for (let i = 0; i < 24; i += 1) {
    const x = 0.12 + Math.random() * 0.76;
    const y = 0.14 + Math.random() * 0.72;
    // Don't place the next target on top of the last one — that rewards not moving at all.
    if (!prev || Math.hypot(x - prev.x, y - prev.y) > 0.28) return { x, y };
  }
  return { x: 0.5, y: 0.5 };
}

export function PointerExperiment() {
  const { videoRef, status, error, pointer, present } = useHandPointer(true);

  const cursorRef = useRef<HTMLDivElement>(null);
  const dwellRef = useRef<SVGCircleElement>(null);
  const targetRef = useRef<HTMLDivElement>(null);
  const hudRef = useRef<HTMLDivElement>(null);
  const flashRef = useRef<HTMLDivElement>(null);

  const [target, setTarget] = useState(() => newTarget(null));
  const [shots, setShots] = useState<Shot[]>([]);
  const [showCam, setShowCam] = useState(false);
  const [mode, setMode] = useState<Mode>("all");
  const modeRef = useRef<Mode>(mode);
  modeRef.current = mode;
  /** The one line of guidance on screen. Driven by the loop, but only re-rendered when it changes. */
  const [guide, setGuide] = useState<string | null>("正在打开摄像头…");
  const guideRef = useRef<string | null>(null);

  // Slider state. Mirrored into the pointer on change; the loop reads the pointer, not React.
  const [minCutoff, setMinCutoff] = useState(DEFAULT_POINTER.oneEuro.minCutoff);
  const [beta, setBeta] = useState(DEFAULT_POINTER.oneEuro.beta);
  const [boxW, setBoxW] = useState(DEFAULT_POINTER.box.widthFaces);
  const [boxH, setBoxH] = useState(DEFAULT_POINTER.box.heightFaces);
  const [dwellMs, setDwellMs] = useState(DEFAULT_POINTER.dwellMs);

  useEffect(() => {
    pointer.current.configure({
      oneEuro: { ...DEFAULT_POINTER.oneEuro, minCutoff, beta },
      box: { ...DEFAULT_POINTER.box, widthFaces: boxW, heightFaces: boxH },
      dwellMs,
      clickGesture: mode === "pinch" ? "pinch" : mode === "fist" ? "fist" : "either",
    });
  }, [pointer, minCutoff, beta, boxW, boxH, dwellMs, mode]);

  /** The target the loop should test against, without making the loop depend on React state. */
  const targetPos = useRef(target);
  targetPos.current = target;
  const shownAt = useRef(performance.now());
  /** Round over — the loop stops scoring, so a summary can be read without it moving. */
  const doneRef = useRef(false);

  useEffect(() => {
    shownAt.current = performance.now();
  }, [target]);

  useEffect(() => {
    let raf = 0;
    const loop = () => {
      raf = requestAnimationFrame(loop);
      const s = pointer.current.state;
      const w = window.innerWidth;
      const h = window.innerHeight;
      const px = s.x * w;
      const py = s.y * h;

      const cur = cursorRef.current;
      if (cur) {
        cur.style.transform = `translate3d(${px}px, ${py}px, 0)`;
        cur.dataset.present = String(s.present);
        cur.dataset.pinched = String(s.pinched);
        // A cursor that dims when the geometry is untrustworthy tells the visitor the truth
        // without a sentence of explanation.
        cur.style.opacity = String(0.25 + s.conf.value * 0.75);
      }
      const t = targetPos.current;
      const r = TARGET_R * Math.min(w, h);
      const over = s.present && Math.hypot(px - t.x * w, py - t.y * h) <= r;

      const m = modeRef.current;
      const gestureLive = m !== "dwell";
      const dwellLive = m === "dwell" || m === "all";

      // The dwell ring only fills over something clickable. Dwell that ran everywhere would
      // fire every time a visitor simply rested their arm, and — worse as an affordance —
      // a ring that is always filling teaches nothing about what can be selected.
      const dw = dwellRef.current;
      if (dw) {
        const C = 2 * Math.PI * 22;
        dw.style.strokeDasharray = `${(over && dwellLive ? s.dwell : 0) * C} ${C}`;
      }

      // --- selection: a pinch is a click wherever it happens; dwell only acts on a target ---
      // Pinch wins a tie, so a slow deliberate pinch is never credited to dwell.
      const via: Via | null =
        gestureLive && s.pressed && s.present
          ? (s.pressVia ?? "pinch")
          : dwellLive && s.dwellFired && over
            ? "dwell"
            : null;

      if (via && !doneRef.current) {
        const ms = performance.now() - shownAt.current;
        setShots((prev) => [...prev, { hit: over, ms, via }]);
        // Say out loud which method just fired — otherwise a disappearing ball is evidence
        // for neither, and the two get credited to whichever one the visitor believes in.
        const fl = flashRef.current;
        if (fl) {
          const name = via === "pinch" ? "捏合" : via === "fist" ? "握拳" : "停留";
          fl.textContent = `${name} · ${over ? "命中" : "落空"}`;
          fl.dataset.via = via;
          fl.style.left = `${px}px`;
          fl.style.top = `${py}px`;
          fl.style.animation = "none";
          void fl.offsetWidth; // restart
          fl.style.animation = "pt-flash 0.8s ease-out forwards";
        }
        if (over) {
          setTarget(newTarget(t));
          const el = targetRef.current;
          if (el) {
            el.style.animation = "none";
            void el.offsetWidth; // restart
            el.style.animation = "pt-pop 0.35s ease-out";
          }
        }
      }

      // --- one line of guidance, from the same confidence the interaction runs on ---
      const g =
        status === "loading"
          ? "正在打开摄像头…"
          : status === "error"
            ? "摄像头打不开 — 见左下角"
            : s.conf.reason === "no-face"
              ? "站到屏幕前，让摄像头看到你的脸"
              : s.conf.reason === "too-close"
                ? "往后退一点"
                : s.conf.reason === "too-far"
                  ? "往前走一点"
                  : !s.present
                    ? "举起一只手"
                    : null;
      if (g !== guideRef.current) {
        guideRef.current = g;
        setGuide(g);
      }

      const hud = hudRef.current;
      if (hud) {
        const th = pointer.current.pinchThresholds;
        hud.textContent =
          `${s.fps.toFixed(0)}fps · ${s.conf.reason} · ` +
          `ratio ${Number.isFinite(s.ratio) ? s.ratio.toFixed(2) : "—"} ` +
          `(捏<${th.on.toFixed(2)}) · ${s.pinched ? "PINCH" : "open"}`;
      }
      return undefined;
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [pointer, status]);

  const hits = shots.filter((s) => s.hit);
  const rate = shots.length ? (hits.length / shots.length) * 100 : 0;
  const meanMs = hits.length ? hits.reduce((a, s) => a + s.ms, 0) / hits.length : 0;
  const done = hits.length >= ROUND;
  doneRef.current = done;

  const byVia = (v: Via) => {
    const all = shots.filter((s) => s.via === v);
    const h = all.filter((s) => s.hit);
    return { total: all.length, hits: h.length, rate: all.length ? (h.length / all.length) * 100 : 0 };
  };
  const pinchStats = byVia("pinch");
  const fistStats = byVia("fist");
  const dwellStats = byVia("dwell");

  const settingsLine =
    `mode ${mode} · minCutoff ${minCutoff} · beta ${beta} · box ${boxW}×${boxH} · dwell ${dwellMs}ms` +
    ` → 命中 ${rate.toFixed(0)}% (${hits.length}/${shots.length}) · 平均 ${(meanMs / 1000).toFixed(1)}s` +
    ` · 捏合 ${pinchStats.hits}/${pinchStats.total}` +
    ` · 握拳 ${fistStats.hits}/${fistStats.total}` +
    ` · 停留 ${dwellStats.hits}/${dwellStats.total}`;

  const restart = () => {
    setShots([]);
    setTarget(newTarget(null));
  };

  return (
    <div className="pt-root" data-theme="dark">
      {/* The camera element must exist for the hook to attach a stream to it, even when hidden. */}
      <video
        ref={videoRef}
        className={showCam ? "pt-cam" : "pt-cam pt-cam--off"}
        playsInline
        muted
      />

      {!done ? (
        <div
          ref={targetRef}
          className="pt-target"
          style={{
            left: `${target.x * 100}%`,
            top: `${target.y * 100}%`,
            width: `${TARGET_R * 200}vmin`,
            height: `${TARGET_R * 200}vmin`,
          }}
        >
          {/* No number in here. The counter top-left already tracks progress, and a numbered
              badge on the ball read as if it matched the numbered steps in the legend. */}
          <span className="pt-target__tag">打这个</span>
        </div>
      ) : null}

      {done ? (
        <div className="pt-done">
          <b>这一轮结束</b>
          <div className="pt-done__grid">
            <span>命中率</span>
            <strong>{rate.toFixed(0)}%</strong>
            <span>每个球平均</span>
            <strong>{(meanMs / 1000).toFixed(1)}s</strong>
            <span>其中 捏合 打掉的</span>
            <strong>{pinchStats.hits}</strong>
            <span>其中 停留 打掉的</span>
            <strong>{dwellStats.hits}</strong>
          </div>
          <p className="pt-done__hint">
            命中 ≥80% 且平均 ≤2.5s 就算调好了。没到就动一根滑杆，再来一轮 —— 一次只动一根。
            {mode === "all" && dwellStats.hits + fistStats.hits > pinchStats.hits ? (
              <>
                <br />
                这一轮主要不是捏合在起作用 —— 切到「只捏合」再打一轮，才知道捏合单独行不行。
              </>
            ) : null}
          </p>
          <div className="pt-done__row">
            <button type="button" className="pt-btn" onClick={restart}>
              再来一轮
            </button>
            <button
              type="button"
              className="pt-btn pt-btn--ghost"
              onClick={() => {
                navigator.clipboard?.writeText(settingsLine);
                console.log("[pointer]", settingsLine);
              }}
            >
              复制这组设置
            </button>
          </div>
        </div>
      ) : null}

      {/* How to play, always on. A passer-by gets no briefing either — if this needs
          explaining out loud, the interaction is not finished. */}
      <div className="pt-legend">
        <b>用手打靶 · 一轮 {ROUND} 个</b>
        <span>举起一只手（胸口高度）→ 光标跟着手掌走</span>
        <span>把光标移到蓝球上</span>
        <span className="pt-legend__or">点击有三种方式，任选一种：</span>
        <span>· 捏合 —— 拇指和食指碰一下</span>
        <span>· 握拳 —— 五指收拢（摄像头最容易看清）</span>
        <span>· 停留 —— 停在球上不动 0.9 秒（光标转一圈）</span>
        <span className="pt-legend__note">球消失时会显示是哪一种起的作用</span>
      </div>

      {/* The single most important thing on screen when it isn't working: why. */}
      {guide ? (
        <div className="pt-guide">
          <span className="pt-guide__hand">✋</span>
          {guide}
        </div>
      ) : null}

      {/* Which method just fired, said at the place it happened. */}
      <div ref={flashRef} className="pt-flash" />

      <div ref={cursorRef} className="pt-cursor" data-present="false">
        <svg viewBox="0 0 48 48" className="pt-cursor__svg">
          <circle className="pt-cursor__dot" cx="24" cy="24" r="5" />
          <circle className="pt-cursor__ring" cx="24" cy="24" r="22" />
          <circle ref={dwellRef} className="pt-cursor__dwell" cx="24" cy="24" r="22" />
        </svg>
      </div>

      <div className="pt-stats">
        <div className="pt-stats__big">
          {hits.length}
          <span className="pt-stats__of"> / {ROUND}</span>
        </div>
        <div className="pt-stats__k">
          命中 {rate.toFixed(0)}% · {shots.length - hits.length} 次落空 · 平均{" "}
          {(meanMs / 1000).toFixed(1)}s
        </div>
        <button type="button" className="pt-reset" onClick={restart}>
          重来
        </button>
      </div>

      <div className="pt-panel">
        <div className={`pt-status pt-status--${status}`}>
          {status === "loading" && "加载模型…"}
          {status === "running" && (present ? "跟踪中" : "举起一只手")}
          {status === "error" && `错误：${error ?? "unknown"}`}
          {status === "idle" && "idle"}
        </div>
        <div ref={hudRef} className="pt-hud" />

        <div className="pt-modes">
          {(["all", "pinch", "fist", "dwell"] as const).map((m) => (
            <button
              key={m}
              type="button"
              className={`pt-mode ${mode === m ? "is-on" : ""}`}
              onClick={() => {
                setMode(m);
                restart();
              }}
            >
              {MODE_LABEL[m]}
            </button>
          ))}
        </div>
        <div className="pt-tally">
          捏合 {pinchStats.hits}/{pinchStats.total} · 握拳 {fistStats.hits}/{fistStats.total} ·
          停留 {dwellStats.hits}/{dwellStats.total}
        </div>

        <Slider
          label="平滑 minCutoff"
          hint="调低到手不动时光标也不动"
          value={minCutoff}
          min={0.1}
          max={3}
          step={0.05}
          onChange={setMinCutoff}
        />
        <Slider
          label="跟手 beta"
          hint="调高到快速挥手时光标不拖尾。静止时它不起作用，所以给大不吃亏"
          value={beta}
          min={0}
          max={30}
          step={0.5}
          fixed={1}
          onChange={setBeta}
        />
        <Slider
          label="交互框宽"
          hint="几个脸宽 = 全屏。调小 = 手动一点走更远"
          value={boxW}
          min={2}
          max={7}
          step={0.1}
          onChange={setBoxW}
        />
        <Slider
          label="交互框高"
          value={boxH}
          min={1.5}
          max={5}
          step={0.1}
          onChange={setBoxH}
        />
        <Slider
          label="Dwell 停留 (ms)"
          hint="0 = 关闭，只用捏合"
          value={dwellMs}
          min={0}
          max={2500}
          step={50}
          fixed={0}
          onChange={setDwellMs}
        />

        <label className="pt-check">
          <input type="checkbox" checked={showCam} onChange={(e) => setShowCam(e.target.checked)} />
          显示摄像头
        </label>
      </div>
    </div>
  );
}

function Slider({
  label,
  hint,
  value,
  min,
  max,
  step,
  fixed = 2,
  onChange,
}: {
  label: string;
  hint?: string;
  value: number;
  min: number;
  max: number;
  step: number;
  fixed?: number;
  onChange: (v: number) => void;
}) {
  return (
    <label className="pt-slider">
      <span className="pt-slider__row">
        <span>{label}</span>
        <b>{value.toFixed(fixed)}</b>
      </span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
      {hint ? <span className="pt-slider__hint">{hint}</span> : null}
    </label>
  );
}
