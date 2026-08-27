import { useEffect, useRef } from "react";
import type { HandPointer } from "../lib/vision/handPointer";
import { MIN_PALM_PX } from "../lib/vision/calibration";
import { PINCH_OFF, PINCH_ON } from "../lib/vision/calibration";
import { PRESS_DEBOUNCE_MS } from "../lib/vision/handPointer";
import { REJECT_LAYER, VISION_DEBUG, interactionTrace } from "../lib/vision/trace";
import { visionLog } from "../lib/vision/visionLog";
import "./visionDebug.css";

/**
 * The vision HUD — `?visionDebug=1`. A developer instrument bolted to the shipping pipeline.
 *
 * It exists because of one asymmetry: everything that can go wrong with the touchless click
 * produces the same outcome on the wall, which is nothing. From in front of the screen a hand
 * the model never found, a pinch two hundredths of a ratio short of the threshold, a pinch
 * fifty milliseconds under the debounce and a click delivered cleanly onto a div with no
 * handler are indistinguishable — so anyone standing at the kiosk trying to work out why it
 * "doesn't work" is guessing, and the previous rounds of tuning were guesses.
 *
 * So this prints the whole chain, in order, with the number that decided each link, and — the
 * line that matters most — the LAST REJECTION: the named reason no click came out. Not "the
 * pinch failed" but `PINCH_SCORE_ABOVE_THRESHOLD ratio 0.812 ≥ on 0.74`, or `HAND_TOO_SMALL
 * palm 31px < 42px floor`, which are two entirely different problems with two entirely
 * different fixes (a feature, and a lens).
 *
 * It is also grouped by LAYER rather than by field, because the three layers fail
 * independently and the fix for each is a different kind of thing:
 *
 *   ACQUISITION  — did the camera find a hand at all?        → optics, placement, lighting
 *   RECOGNITION  — given a hand, was the posture read?       → the feature and its thresholds
 *   INTERACTION  — given a posture, did a click come out?    → drag/debounce/target policy
 *
 * Rendered straight into refs from the pointer's own rAF loop, never through React state: a
 * panel that re-rendered a component tree sixty times a second would be measuring itself.
 *
 * When the flag is absent this returns null before any effect runs, so production is exactly
 * what it was.
 */
export function VisionDebug({
  video,
  pointer,
}: {
  video: React.RefObject<HTMLVideoElement | null>;
  pointer: { current: HandPointer };
}) {
  const bodyRef = useRef<HTMLPreElement>(null);
  const cueRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!VISION_DEBUG) return;
    let raf = 0;
    let lastCue = "";

    const render = () => {
      raf = requestAnimationFrame(render);
      const s = pointer.current.state;
      const v = video.current;
      const t = interactionTrace;

      // Phase 2 — what the camera ACTUALLY is, every field read at runtime. The requested
      // constraint appears alongside it precisely so the two can be seen to disagree.
      const stream = v?.srcObject instanceof MediaStream ? v.srcObject : null;
      const track = stream?.getVideoTracks()[0] ?? null;
      const set = (track?.getSettings?.() ?? {}) as {
        width?: number;
        height?: number;
        frameRate?: number;
        deviceId?: string;
      };
      const rect = v?.getBoundingClientRect();

      const f = s.features;
      const th = pointer.current.pinchThresholds;
      const rj = t.lastReject;
      const num = (x: number, d = 0) => (Number.isFinite(x) && x >= 0 ? x.toFixed(d) : "—");

      const camMismatch =
        !!v?.videoWidth && (v.videoWidth !== 1280 || v.videoHeight !== 720) ? "  ⚠ NOT 1280×720" : "";
      const palmVerdict =
        Number.isFinite(s.palmPx) && s.palmPx < MIN_PALM_PX ? `  ⚠ under the ${MIN_PALM_PX}px floor` : "";

      const rows: string[] = [
        `── CAMERA ─────────────────────────────────`,
        `requested        1280×720 (ideal)`,
        `video.video*     ${v?.videoWidth ?? 0}×${v?.videoHeight ?? 0}${camMismatch}`,
        `track settings   ${set.width ?? "?"}×${set.height ?? "?"} @ ${
          set.frameRate ? set.frameRate.toFixed(0) : "?"
        }fps declared`,
        `pipeline fps     ${s.fps.toFixed(1)} measured`,
        `css box          ${rect ? `${rect.width.toFixed(0)}×${rect.height.toFixed(0)}` : "—"} (must not matter)`,
        `device           ${(track?.label || "—").slice(0, 34)}`,
        ``,
        `── 1 · ACQUISITION ────────────────────────`,
        `hand this frame  ${s.handSeen ? "YES" : "no"}   present ${s.present ? "YES" : "no"}   tracked ${s.hands.length}`,
        // `numHands: 2`, and the pointer reads hands[0]. In a public corridor that index
        // can change owner between frames — a bystander walking behind, or the visitor's
        // own second hand — and the pinch feature would jump with it.
        s.hands.length > 1 ? `  ⚠ two hands tracked; the pointer follows hands[0] only` : ``,
        `hand bbox px     ${num(f.boxPx.w)} × ${num(f.boxPx.h)}`,
        `palm span px     ${num(s.palmPx, 1)}${palmVerdict}`,
        `confidence       ${s.conf.value.toFixed(2)}  ${s.conf.reason}${
          s.box?.clamped ? "  [box CLAMPED]" : s.box?.shifted ? "  [box shifted]" : ""
        }`,
        `face anchor      ${s.box ? (s.faceHeld ? "coasting on memory" : "seen") : "NONE"}`,
        `hand frames      ${s.counts.handFrames}/${s.counts.frames} (${pct(
          s.counts.handFrames,
          s.counts.frames,
        )})`,
        ``,
        `── 2 · RECOGNITION ────────────────────────`,
        `thumb tip px     ${num(f.thumbPx.x)}, ${num(f.thumbPx.y)}`,
        `index tip px     ${num(f.indexPx.x)}, ${num(f.indexPx.y)}`,
        `aperture px      ${num(f.aperturePx, 1)}  ← the optics-limited number`,
        `SHIPPING ratio3D ${num(f.ratioWorld3D, 3)}   (on<${th.on} off>${th.off})`,
        `  cand. ratio2D  ${num(f.ratioWorld2D, 3)}   world, z dropped`,
        `  cand. ratioPx  ${num(f.ratioPx, 3)}   image plane only`,
        `  aperture z     ${num(f.apertureZM, 3)}m  inferred depth inside ratio3D`,
        `raw posture      ${s.rawHeld ? "CLOSED" : "open"}   filtered ${s.pinched ? "PRESSED" : "—"}${
          s.pressVia ? ` via ${s.pressVia}` : ""
        }`,
        `debounce         ${(s.pressProgress * 100).toFixed(0)}% of ${PRESS_DEBOUNCE_MS}ms`,
        `FSM              ${s.phase}   held ${s.gestureMs.toFixed(0)}ms`,
        `raw latches      ${s.counts.rawLatches} → presses ${s.counts.presses}`,
        ``,
        `── 3 · INTERACTION ────────────────────────`,
        `pointer velocity ${s.velocity.toFixed(2)} screen/s`,
        `drag displacement ${t.dragFrac.toFixed(3)} (${t.dragPx.toFixed(0)}px), threshold 0.025`,
        `scrollable at grab ${t.canScroll ? "YES — a drag there WILL eat the click" : "no"}`,
        `hover target     ${t.hover}${t.hoverInteractive ? "" : "   [not clickable]"}`,
        `clicks emitted   ${t.counts.clicks}   drags ${t.counts.drags}   dwell ${t.counts.dwellClicks}`,
        `last action      ${t.lastAction}`,
        ``,
        `── WHY NOTHING HAPPENED ───────────────────`,
        rj
          ? `${rj.layer.toUpperCase()} · ${rj.reason}   ${age(rj.at)} ago`
          : `— (no rejection recorded yet)`,
        rj?.detail ? `  ${rj.detail}` : ``,
        `now              ${s.reject ?? "—"}`,
        recentSummary(),
      ];

      if (visionLog.enabled) {
        rows.push(
          ``,
          `── RUN ────────────────────────────────────`,
          `state ${visionLog.phase}  attempt ${Math.max(0, visionLog.index + 1)}/${
            visionLog.spec?.attempts ?? 0
          }  frames ${visionLog.frameCount}`,
        );
      }

      if (bodyRef.current) bodyRef.current.textContent = rows.filter((r) => r !== "").join("\n");

      // The metronome prompt: big, central, and the only thing a person doing twenty pinches
      // in a corridor should have to look at.
      if (cueRef.current) {
        const spec = visionLog.spec;
        let cue = "";
        if (spec && visionLog.phase === "leadIn") cue = `get ready · ${spec.kind.toUpperCase()} ×${spec.attempts} @ ${spec.distanceM}m`;
        else if (spec && visionLog.phase === "running") {
          const n = visionLog.index + 1;
          cue =
            spec.kind === "rest"
              ? `HOLD STILL · ${n}/${spec.attempts}`
              : `${spec.kind.toUpperCase()} NOW · ${n}/${spec.attempts}`;
        } else if (spec && visionLog.phase === "done") cue = "done — file downloaded";
        if (cue !== lastCue) {
          cueRef.current.textContent = cue;
          cueRef.current.dataset.on = String(!!cue);
          lastCue = cue;
        }
        if (spec && visionLog.phase === "running") {
          cueRef.current.style.setProperty("--gt-cue", String(visionLog.progress));
        }
      }
    };

    raf = requestAnimationFrame(render);
    return () => cancelAnimationFrame(raf);
  }, [pointer, video]);

  if (!VISION_DEBUG) return null;
  return (
    <>
      <pre className="gt-vision-hud" ref={bodyRef} aria-hidden />
      <div className="gt-vision-cue" ref={cueRef} data-on="false" aria-hidden />
    </>
  );
}

/** How long ago, so a stale rejection is never mistaken for the current state. */
function age(at: number): string {
  const ms = performance.now() - at;
  return ms < 1000 ? `${ms.toFixed(0)}ms` : `${(ms / 1000).toFixed(1)}s`;
}

function pct(a: number, b: number): string {
  return b > 0 ? `${((a / b) * 100).toFixed(0)}%` : "—";
}

/** The last few refusals, collapsed to counts — the pattern, not the latest frame. */
function recentSummary(): string {
  const by = new Map<string, number>();
  for (const r of interactionTrace.recent) by.set(r.reason, (by.get(r.reason) ?? 0) + 1);
  if (!by.size) return "";
  const parts = [...by.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([k, n]) => `${n}× ${k}[${REJECT_LAYER[k as keyof typeof REJECT_LAYER]?.[0] ?? "?"}]`);
  return `recent           ${parts.join("  ")}`;
}

export { PINCH_ON, PINCH_OFF };
