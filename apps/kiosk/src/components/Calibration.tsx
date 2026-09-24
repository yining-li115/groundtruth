import { useCallback, useEffect, useRef, useState } from "react";
import { DEFAULT_BOX, palmCenter, type BoxConfig } from "../lib/vision/calibration";
import { activePointer } from "../lib/vision/handPointer";
import {
  advanceGestureProof,
  advanceValidationDwell,
  VALIDATION_DWELL_MS,
  VALIDATION_REGIONS,
  type CalibrationZone,
} from "../lib/vision/calibrationValidation";
import {
  PROFILE_VERSION,
  conservativeInstallationBox,
  type CalibrationProfile,
} from "../lib/vision/profile";
import {
  activeProfile,
  applyProfile,
  displayFacts,
  displaySignature,
  restoreProfile,
} from "../lib/vision/profileStore";
import {
  fitAxisReach,
  type AxisReachSamples,
  type ReachSample,
} from "../lib/vision/reachFit";
import {
  clickGestureInstruction,
  clickGestureNoun,
  useClickGesture,
} from "../lib/vision/useClickGesture";
import { visionLog } from "../lib/vision/visionLog";
import {
  activeCameraIdentity,
  cameraIdentityRevision,
  cameraSignature,
} from "../lib/vision/cameraPairing";
import { useKioskStore } from "../state/store";
import "./calibration.css";

/**
 * Installation calibration, deliberately separated from visitor recognition.
 *
 * The stored profile contains only facts that remain true after the person who calibrated the
 * kiosk walks away: camera identity, display identity and a conservative mapping seed. Gesture
 * thresholds and cursor noise are runtime state; persisting either would tune the next visitor
 * to somebody else's hand.
 *
 * No step asks for a screen corner. Five comfortable, axis-aligned camera-space holds establish
 * the visible range, the configured selection gesture is proved three times, and a deliberately
 * different screen-space map then validates the fitted output. Stage 3 is not a second attempt to
 * hit the five samples from stage 1. A profile is saved only after all three proofs pass.
 */

type Phase = "resolving" | "seek" | "positions" | "gesture" | "validate" | "done";
type PositionId = CalibrationZone;

interface Recording {
  ownerId: number | null;
  positions: Partial<Record<PositionId, ReachSample>>;
  positionIdx: number;
  recentRaw: ReachSample[];
  fps: number;
  frame: { w: number; h: number };
  lastFrameSeq: number;
  lastSampleAt: number;
  sourceFresh: boolean;
  recording: boolean;
  held: number;
  gestureArmed: boolean;
  gestureClosed: boolean;
  gestureCycles: number;
  gestureRetries: number;
  validated: PositionId[];
  validationCandidate: PositionId | null;
  validationHeld: number;
  box: BoxConfig | null;
  installationDisplay: string;
  installationCamera: string;
  installationDisplayRevision: number;
  installationCameraRevision: number;
  lastInstallationCheckAt: number;
}

const LEAD_IN_MS = 1_600;
const POSITION_HOLD_MS = 800;
const POSITION_STILL_TOLERANCE = 0.01;
const FRAME_MARGIN = 0.08;
const POSITION_BEAT_MS = 650;
const POSITION_FIT_INSET = -0.08;
const GESTURE_CYCLES = 3;
const GESTURE_CAP_MS = 18_000;
const VALIDATE_CAP_MS = 25_000;
/** Never join two short holds across a decoder/inference pause. */
const MAX_EVIDENCE_GAP_MS = 250;

const POSITIONS: ReadonlyArray<{
  id: PositionId;
  name: string;
  instruction: string;
}> = [
  { id: "center", name: "centre", instruction: "Hold your hand comfortably in front of you" },
  { id: "left", name: "left", instruction: "Move comfortably to your left" },
  { id: "right", name: "right", instruction: "Move comfortably to your right" },
  { id: "up", name: "up", instruction: "Move comfortably upward" },
  { id: "down", name: "down", instruction: "Move comfortably downward" },
];

const PARAMS = typeof window === "undefined" ? null : new URLSearchParams(location.search);
const FORCE = PARAMS?.get("calibrate") === "1";
const DISABLED = PARAMS?.get("calibrate") === "0";

function newRecording(
  installationDisplay = displaySignature(),
  installationCamera = cameraSignature(),
  installationDisplayRevision = 0,
  installationCameraRevision = cameraIdentityRevision(),
): Recording {
  return {
    ownerId: null,
    positions: {},
    positionIdx: 0,
    recentRaw: [],
    fps: 30,
    frame: { w: 0, h: 0 },
    lastFrameSeq: -1,
    lastSampleAt: 0,
    sourceFresh: false,
    recording: false,
    held: 0,
    gestureArmed: false,
    gestureClosed: false,
    gestureCycles: 0,
    gestureRetries: 0,
    validated: [],
    validationCandidate: null,
    validationHeld: 0,
    box: null,
    installationDisplay,
    installationCamera,
    installationDisplayRevision,
    installationCameraRevision,
    lastInstallationCheckAt: 0,
  };
}

export function Calibration({ onDone }: { onDone: () => void }) {
  const clickGesture = useClickGesture();
  const [phase, setPhase] = useState<Phase>("resolving");
  const [progress, setProgress] = useState(0);
  const [note, setNote] = useState("");
  const [reached, setReached] = useState<string[]>([]);
  const [validationCandidate, setValidationCandidate] = useState<PositionId | null>(null);
  const [validationPoint, setValidationPoint] = useState<{ x: number; y: number } | null>(null);
  const [recording, setRecording] = useState(false);
  const [result, setResult] = useState<CalibrationProfile | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const previousProfile = useRef<CalibrationProfile | null>(activeProfile());
  const rec = useRef<Recording>(newRecording());
  const displayRevision = useRef(0);
  const finishTimer = useRef(0);

  // A signature checked only at the end cannot detect A → B → A inside one sampling window.
  // Keep an event epoch as well; any display transition invalidates all evidence gathered before
  // it, even when the final geometry happens to match again.
  useEffect(() => {
    const changed = () => {
      displayRevision.current += 1;
    };
    window.addEventListener("resize", changed);
    window.addEventListener("orientationchange", changed);
    window.screen?.orientation?.addEventListener?.("change", changed);
    return () => {
      window.removeEventListener("resize", changed);
      window.removeEventListener("orientationchange", changed);
      window.screen?.orientation?.removeEventListener?.("change", changed);
    };
  }, []);

  const resetUi = useCallback((message = "") => {
    setReached([]);
    setResult(null);
    setProgress(0);
    setValidationCandidate(null);
    setValidationPoint(null);
    setRecording(false);
    setNote(message);
  }, []);

  /** Re-check the physical pairing before leaving the Ready summary. */
  const finish = useCallback(
    (profile: CalibrationProfile | null) => {
      if (finishTimer.current) window.clearTimeout(finishTimer.current);
      const currentCamera = activeCameraIdentity();
      const currentDisplayKey = displaySignature();
      const currentCameraKey = cameraSignature(currentCamera);
      if (
        rec.current.installationDisplay !== currentDisplayKey ||
        rec.current.installationCamera !== currentCameraKey ||
        (profile !== null &&
          (displaySignature(profile.display) !== currentDisplayKey ||
            cameraSignature(profile.camera) !== currentCameraKey))
      ) {
        const restored = restoreProfile(currentCamera.deviceId, currentCamera.label);
        previousProfile.current = restored;
        rec.current = newRecording(
          currentDisplayKey,
          currentCameraKey,
          displayRevision.current,
          cameraIdentityRevision(),
        );
        resetUi("The camera or display changed. Setup has restarted for this pairing.");
        if (!FORCE && restored) onDone();
        else setPhase("seek");
        return;
      }
      if (profile) applyProfile(profile);
      else applyProfile(previousProfile.current, false);

      const expectedDisplay = displaySignature();
      const expectedCamera = cameraSignature();
      setResult(profile);
      setPhase("done");
      finishTimer.current = window.setTimeout(() => {
        const camera = activeCameraIdentity();
        const nextDisplay = displaySignature();
        const nextCamera = cameraSignature(camera);
        if (nextDisplay !== expectedDisplay || nextCamera !== expectedCamera) {
          const restored = restoreProfile(camera.deviceId, camera.label);
          previousProfile.current = restored;
          rec.current = newRecording(
            nextDisplay,
            nextCamera,
            displayRevision.current,
            cameraIdentityRevision(),
          );
          resetUi("The camera or display changed. Setup has restarted for this pairing.");
          if (!FORCE && restored) onDone();
          else setPhase("seek");
          return;
        }
        onDone();
      }, profile ? 2_600 : 400);
    },
    [onDone, resetUi],
  );

  useEffect(
    () => () => {
      if (finishTimer.current) window.clearTimeout(finishTimer.current);
    },
    [],
  );

  // Resolve the actual camera track before looking up a profile. On a first visit that may mean
  // waiting for the browser permission prompt; a timer cannot tell permission from failure.
  useEffect(() => {
    let cancelled = false;
    let timer = 0;
    const tick = () => {
      if (cancelled) return;
      const camera = activeCameraIdentity();
      const status = useKioskStore.getState().handStatus;
      if (camera.deviceId || camera.label) {
        const restored = restoreProfile(camera.deviceId, camera.label);
        previousProfile.current = restored;
        rec.current = newRecording(
          displaySignature(),
          cameraSignature(camera),
          displayRevision.current,
          cameraIdentityRevision(),
        );
        if (DISABLED || (!FORCE && restored)) {
          onDone();
          return;
        }
        setPhase("seek");
        return;
      }
      // Synthetic browser tests have no MediaStream track identity. Their explicit skip is
      // authoritative and must not leave the app on a blank resolving screen forever.
      if (DISABLED && (activePointer()?.state.sample.seq ?? 0) > 0) {
        applyProfile(null, false);
        onDone();
        return;
      }
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

  useEffect(() => {
    if (phase === "resolving" || phase === "done") return;
    let raf = 0;
    let phaseStart = performance.now();
    let current: Phase = phase;

    const clearTransientEvidence = (r: Recording) => {
      r.recording = false;
      r.held = 0;
      r.recentRaw = [];
      r.lastSampleAt = 0;
      r.gestureArmed = false;
      r.gestureClosed = false;
      r.validationCandidate = null;
      r.validationHeld = 0;
      setValidationCandidate(null);
      setValidationPoint(null);
    };

    const advance = (next: Phase) => {
      const r = rec.current;
      current = next;
      phaseStart = performance.now();
      clearTransientEvidence(r);
      if (next === "gesture") {
        r.gestureArmed = false;
        r.gestureClosed = false;
        r.gestureCycles = 0;
      }
      setProgress(0);
      setNote("");
      setRecording(false);
      setPhase(next);
    };

    const restartForPairing = (message: string) => {
      const camera = activeCameraIdentity();
      const display = displaySignature();
      const cameraKey = cameraSignature(camera);
      const restored = restoreProfile(camera.deviceId, camera.label);
      previousProfile.current = restored;
      rec.current = newRecording(
        display,
        cameraKey,
        displayRevision.current,
        cameraIdentityRevision(),
      );
      resetUi(message);
      if (!FORCE && restored) {
        current = "done";
        onDone();
      } else {
        current = "seek";
        phaseStart = performance.now();
        setPhase("seek");
      }
    };

    const restartForOwner = (message: string) => {
      applyProfile(previousProfile.current, false);
      const prior = rec.current;
      rec.current = newRecording(
        prior.installationDisplay,
        prior.installationCamera,
        prior.installationDisplayRevision,
        prior.installationCameraRevision,
      );
      current = "seek";
      phaseStart = performance.now();
      resetUi(message);
      setPhase("seek");
    };

    const loop = () => {
      raf = requestAnimationFrame(loop);
      const pointer = activePointer();
      if (!pointer) return;
      const s = pointer.state;
      const now = performance.now();
      const r = rec.current;

      if (
        cameraIdentityRevision() !== r.installationCameraRevision ||
        displayRevision.current !== r.installationDisplayRevision
      ) {
        restartForPairing("The camera or display changed. Setup has restarted for this pairing.");
        return;
      }

      // A terminal camera/model failure is an installation outcome, not a setup screen the
      // unattended wall can remain trapped behind. Restore this pairing's previous/default
      // profile and let the showreel continue; transient loading/stale states still wait here.
      if (current !== "done" && useKioskStore.getState().handStatus === "error") {
        current = "done";
        finish(null);
        return;
      }

      if (now - r.lastInstallationCheckAt >= 500) {
        r.lastInstallationCheckAt = now;
        const nextDisplay = displaySignature();
        const nextCamera = cameraSignature();
        if (nextDisplay !== r.installationDisplay || nextCamera !== r.installationCamera) {
          restartForPairing("The camera or display changed. Setup has restarted for this pairing.");
          return;
        }
      }

      if (!s.sample.sourceFresh) {
        if (r.sourceFresh) {
          r.sourceFresh = false;
          clearTransientEvidence(r);
        }
        setRecording(false);
        setNote("The camera feed paused. Hold your position; measuring will restart when it resumes.");
        drawPreview(canvasRef.current, s.box, current);
        return;
      }
      if (!r.sourceFresh) {
        r.sourceFresh = true;
        clearTransientEvidence(r);
        phaseStart = now;
        setNote("");
      }

      const frameSeq = s.sample.seq;
      const fresh = frameSeq !== r.lastFrameSeq;
      const sampleAt = s.sample.receivedAtMs;
      const rawSampleDt = fresh && r.lastSampleAt > 0 ? sampleAt - r.lastSampleAt : 0;
      const continuous = rawSampleDt >= 0 && rawSampleDt <= MAX_EVIDENCE_GAP_MS;
      const sampleDt = fresh && continuous ? Math.min(100, rawSampleDt) : 0;
      if (fresh) {
        r.lastFrameSeq = frameSeq;
        r.lastSampleAt = sampleAt;
        if (!continuous && rawSampleDt > 0) clearTransientEvidence(r);
      }
      if (s.fps > 1) r.fps = s.fps;
      if (s.frame.w > 0 && s.frame.h > 0) r.frame = { w: s.frame.w, h: s.frame.h };

      const palm = palmCenter(
        s.owner.selectedIndex >= 0 ? s.hands[s.owner.selectedIndex] : undefined,
      );
      const face = s.face;
      const ownerVisible = s.owner.id !== null && s.owner.visible && !!palm;
      const tracked = ownerVisible && !!face && face.w > 0;

      // A missing ID merely pauses evidence. A positively different ID restarts positions; once
      // a bounded box exists, re-proving gesture + mapped range is enough for installation v4.
      if (
        current !== "seek" &&
        r.ownerId !== null &&
        s.owner.id !== null &&
        s.owner.id !== r.ownerId
      ) {
        if (current === "positions") {
          restartForOwner("The tracked hand changed. Raise one hand and setup will restart.");
          return;
        }
        r.ownerId = s.owner.id;
        r.gestureCycles = 0;
        r.gestureArmed = false;
        r.gestureClosed = false;
        r.validated = [];
        r.validationCandidate = null;
        r.validationHeld = 0;
        setReached([]);
        advance("gesture");
        setNote("The tracked hand changed. Prove the selection gesture again.");
        return;
      }

      switch (current) {
        case "seek": {
          if (tracked && s.present && s.owner.id !== null) {
            r.ownerId = s.owner.id;
            advance("positions");
          }
          break;
        }

        case "positions": {
          const elapsed = now - phaseStart;
          r.recording = elapsed >= LEAD_IN_MS;
          const target = POSITIONS[r.positionIdx];
          if (!target) break;
          const inShot =
            !!palm &&
            palm.x > FRAME_MARGIN &&
            palm.x < 1 - FRAME_MARGIN &&
            palm.y > FRAME_MARGIN &&
            palm.y < 1 - FRAME_MARGIN;

          if (r.recording && fresh && continuous && tracked && palm && face && inShot) {
            r.recentRaw.push({
              u: (palm.x - face.cx) / face.w,
              v: (palm.y - face.cy) / face.w,
              x: palm.x,
              y: palm.y,
              faceW: face.w,
            });
            if (r.recentRaw.length > 12) r.recentRaw.shift();
            if (spread(r.recentRaw) < POSITION_STILL_TOLERANCE) r.held += sampleDt;
            else r.held = 0;
          } else if (r.recording && fresh) {
            r.held = 0;
            r.recentRaw = [];
          }

          setProgress(
            r.recording
              ? Math.min(
                  1,
                  (r.positionIdx + Math.min(1, r.held / POSITION_HOLD_MS)) /
                    POSITIONS.length,
                )
              : 0,
          );
          setNote(
            !r.recording
              ? ""
              : !tracked
                ? "Keep your face and hand where the camera can see them."
                : !inShot
                  ? "Too far — come back inside the camera picture and hold there."
                  : r.held === 0 && r.recentRaw.length > 6
                    ? "Hold it still…"
                    : "",
          );

          if (r.held >= POSITION_HOLD_MS && r.recentRaw.length >= 4) {
            const n = r.recentRaw.length;
            r.positions[target.id] = r.recentRaw.reduce(
              (mean, point) => ({
                u: mean.u + point.u / n,
                v: mean.v + point.v / n,
                x: mean.x + point.x / n,
                y: mean.y + point.y / n,
                faceW: mean.faceW + point.faceW / n,
              }),
              { u: 0, v: 0, x: 0, y: 0, faceW: 0 },
            );
            r.positionIdx += 1;
            r.held = 0;
            r.recentRaw = [];
            setReached(Object.keys(r.positions));
            phaseStart = now - LEAD_IN_MS + POSITION_BEAT_MS;
            r.recording = false;

            if (r.positionIdx >= POSITIONS.length) {
              const held = completePositions(r.positions);
              const aspect = r.frame.h > 0 ? r.frame.w / r.frame.h : 16 / 9;
              const fit = held
                ? fitAxisReach(held, aspect, { inset: POSITION_FIT_INSET })
                : null;
              const safeBox = fit ? conservativeInstallationBox(fit.box) : null;
              if (!safeBox) {
                r.positions = {};
                r.positionIdx = 0;
                setReached([]);
                phaseStart = now;
                setNote(
                  "Those holds did not establish a safe range. Try again and make each direction distinct, without stretching to the frame edge.",
                );
                break;
              }
              r.box = safeBox;
              pointer.configure({ box: safeBox });
              setReached([]);
              advance("gesture");
            }
          }
          break;
        }

        case "gesture": {
          const elapsed = now - phaseStart;
          r.recording = elapsed >= LEAD_IN_MS;
          if (r.recording && fresh && continuous && ownerVisible) {
            // Begin from an observed open hand, so a fist already held while this phase appears
            // cannot be credited as a deliberate close-open cycle.
            if (!r.gestureArmed) {
              if (!s.pinched && s.posture === "open") r.gestureArmed = true;
            } else {
              const proof = advanceGestureProof(
                { confirmedClosed: r.gestureClosed, cycles: r.gestureCycles },
                s.pinched,
                s.posture,
              );
              r.gestureClosed = proof.confirmedClosed;
              r.gestureCycles = proof.cycles;
            }
          } else if (r.recording && fresh) {
            r.gestureArmed = false;
            r.gestureClosed = false;
          }
          setProgress(r.recording ? Math.min(1, r.gestureCycles / GESTURE_CYCLES) : 0);
          setNote(
            r.recording && !r.gestureArmed
              ? "Open your hand clearly to begin."
              : r.gestureRetries > 0
              ? `No reliable ${clickGestureNoun(clickGesture)} cycle was detected. Keep the whole hand visible and try three slower close–open cycles, or skip to retain the previous settings.`
              : r.recording && elapsed > LEAD_IN_MS + 7_000 && r.gestureCycles === 0
                ? `The ${clickGestureNoun(clickGesture)} is not reading reliably. Keep the whole hand inside the camera picture and move slowly.`
                : "",
          );
          if (r.gestureCycles >= GESTURE_CYCLES) {
            r.validated = [];
            setReached([]);
            advance("validate");
          } else if (elapsed > GESTURE_CAP_MS) {
            r.gestureArmed = false;
            r.gestureClosed = false;
            r.gestureCycles = 0;
            r.gestureRetries += 1;
            r.recording = false;
            phaseStart = now;
            setProgress(0);
          }
          break;
        }

        case "validate": {
          // This is a reachability check, not a second calibration measurement. Consume the same
          // filtered, stabilised screen coordinate as the real cursor instead of applying a new
          // raw-palm stillness gate. Face coasting is valid here too: the owner, mapped box and
          // source must remain fresh, but one missed face frame must not erase a good hold.
          const validationOwner =
            ownerVisible &&
            s.owner.id === r.ownerId &&
            !!s.box &&
            Number.isFinite(s.liveX) &&
            Number.isFinite(s.liveY);
          r.recording = validationOwner;
          if (fresh && continuous && validationOwner) {
            setValidationPoint({ x: clamp01(s.liveX), y: clamp01(s.liveY) });
            const proof = advanceValidationDwell(
              { candidate: r.validationCandidate, heldMs: r.validationHeld },
              { u: s.liveX, v: s.liveY },
              r.validated,
              sampleDt,
            );
            r.validationCandidate = proof.candidate;
            r.validationHeld = proof.heldMs;
            setValidationCandidate(proof.candidate);
            if (proof.confirmed) {
              r.validated.push(proof.confirmed);
              setReached([...r.validated]);
            }
          } else if (fresh) {
            r.validationCandidate = null;
            r.validationHeld = 0;
            setValidationCandidate(null);
            setValidationPoint(null);
          }

          setProgress(
            Math.min(
              1,
              (r.validated.length + r.validationHeld / VALIDATION_DWELL_MS) / POSITIONS.length,
            ),
          );
          if (r.validated.length === POSITIONS.length) {
            // Commit only evidence collected under this exact installation token. A display can
            // move in the sub-500ms interval between periodic checks; never persist old evidence
            // under the newly observed pairing.
            if (
              displaySignature() !== r.installationDisplay ||
              cameraSignature() !== r.installationCamera
            ) {
              restartForPairing(
                "The camera or display changed. Setup has restarted for this pairing.",
              );
              return;
            }
            current = "done";
            finish(buildProfile(r));
          } else if (now - phaseStart > VALIDATE_CAP_MS) {
            const pending = POSITIONS.filter((item) => !r.validated.includes(item.id))
              .map((item) => item.name)
              .join(", ");
            setNote(
              `Still needed: ${pending}. Move the marker into each broad band; no corner is required.`,
            );
          }
          break;
        }

        default:
          break;
      }

      setRecording(r.recording);
      drawPreview(canvasRef.current, s.box, current);
    };

    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [clickGesture, finish, onDone, phase, resetUi]);

  const restart = useCallback(() => {
    if (finishTimer.current) window.clearTimeout(finishTimer.current);
    applyProfile(previousProfile.current, false);
    rec.current = newRecording(
      displaySignature(),
      cameraSignature(),
      displayRevision.current,
      cameraIdentityRevision(),
    );
    resetUi();
    setPhase("seek");
  }, [resetUi]);

  if (phase === "resolving") return null;

  const baseCopy = COPY[phase];
  const position = POSITIONS[rec.current.positionIdx];
  const title =
    phase === "positions"
      ? (position?.instruction ?? baseCopy.title)
      : phase === "gesture"
        ? `${clickGestureInstruction(clickGesture)}, then open — three times`
        : baseCopy.title;
  const hint =
    phase === "gesture"
      ? "Close deliberately, then open the whole hand clearly. This verifies the selection gesture on this camera."
      : baseCopy.hint;
  const validationCandidateName = POSITIONS.find(
    (item) => item.id === validationCandidate,
  )?.name;
  const validationNext = POSITIONS.find((item) => !reached.includes(item.id));
  const validationAspect =
    typeof window === "undefined" || window.innerHeight <= 0
      ? 16 / 9
      : window.innerWidth / window.innerHeight;

  return (
    <div className="cal" role="dialog" aria-label="Set up hand control">
      {phase === "validate" ? (
        <div
          className="cal-screen-check"
          style={{ aspectRatio: validationAspect }}
          role="img"
          aria-label="Mapped display with broad centre, left, right, up and down validation bands"
        >
          <span className="cal-screen-check__label">Mapped display</span>
          {POSITIONS.map((item) => {
            const region = VALIDATION_REGIONS[item.id];
            return (
              <span
                key={item.id}
                className={`cal-screen-check__zone ${
                  reached.includes(item.id) ? "is-on" : ""
                } ${validationCandidate === item.id ? "is-candidate" : ""} ${
                  validationNext?.id === item.id ? "is-next" : ""
                }`}
                style={{
                  left: `${region.x0 * 100}%`,
                  top: `${region.y0 * 100}%`,
                  width: `${(region.x1 - region.x0) * 100}%`,
                  height: `${(region.y1 - region.y0) * 100}%`,
                }}
              >
                {reached.includes(item.id) ? "✓" : directionGlyph(item.id)}
                <span>{item.name}</span>
              </span>
            );
          })}
          {validationPoint && (
            <span
              className="cal-screen-check__cursor"
              style={{
                left: `${validationPoint.x * 100}%`,
                top: `${validationPoint.y * 100}%`,
              }}
              aria-hidden="true"
            />
          )}
        </div>
      ) : (
        <div className="cal-frame">
          <canvas ref={canvasRef} className="cal-canvas" width={480} height={270} />
        </div>
      )}

      <div className="cal-body">
        <span className="cal-step">{baseCopy.step}</span>
        <h1 className="cal-title">{title}</h1>
        {baseCopy.purpose && <p className="cal-purpose">{baseCopy.purpose}</p>}
        <p className="cal-hint">{note || hint}</p>

        {phase === "positions" && (
          <>
            <span className="cal-evidence-label">Camera-range checklist · not screen targets</span>
            <div
              className="cal-directions"
              aria-label="Comfortable camera-space movement checklist; not cursor targets"
            >
              {POSITIONS.map((item) => (
                <span
                  key={item.id}
                  className={`cal-direction cal-direction--${item.id} ${
                    reached.includes(item.id) ? "is-on" : ""
                  } ${position?.id === item.id ? "is-next" : ""}`}
                >
                  {reached.includes(item.id) ? "✓" : directionGlyph(item.id)}
                  <span>{item.name}</span>
                </span>
              ))}
            </div>
          </>
        )}

        {phase !== "done" && phase !== "seek" && (
          <div className={`cal-bar ${recording ? "is-live" : ""}`}>
            <div className="cal-bar__fill" style={{ transform: `scaleX(${progress})` }} />
            <span className="cal-bar__label">
              {phase === "validate"
                ? validationCandidateName
                  ? `hold ${validationCandidateName}…`
                  : recording
                    ? validationNext
                      ? `move the marker to ${validationNext.name}`
                      : "checking mapped reach…"
                    : "keep your hand in view…"
                : recording
                  ? "measuring"
                  : "get ready…"}
            </span>
          </div>
        )}

        {phase === "done" && result && <Summary profile={result} click={clickGesture} />}
      </div>

      {phase !== "done" && (
        <div className="cal-actions">
          <span className="cal-actions__label">Operator controls · mouse, touch or keyboard</span>
          <button type="button" className="cal-btn" onClick={restart}>
            Start over
          </button>
          <button type="button" className="cal-btn" onClick={() => finish(null)}>
            {previousProfile.current
              ? "Skip — keep the previous settings"
              : "Skip — use the default settings"}
          </button>
        </div>
      )}
    </div>
  );
}

function spread(points: Array<{ x: number; y: number }>): number {
  if (points.length < 4) return Number.POSITIVE_INFINITY;
  const mx = points.reduce((sum, point) => sum + point.x, 0) / points.length;
  const my = points.reduce((sum, point) => sum + point.y, 0) / points.length;
  return Math.sqrt(
    points.reduce(
      (sum, point) => sum + (point.x - mx) ** 2 + (point.y - my) ** 2,
      0,
    ) / points.length,
  );
}

function completePositions(
  positions: Partial<Record<PositionId, ReachSample>>,
): AxisReachSamples | null {
  const { center, left, right, up, down } = positions;
  return center && left && right && up && down ? { center, left, right, up, down } : null;
}

function directionGlyph(id: PositionId): string {
  if (id === "left") return "←";
  if (id === "right") return "→";
  if (id === "up") return "↑";
  if (id === "down") return "↓";
  return "•";
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function buildProfile(r: Recording): CalibrationProfile {
  const camera = activeCameraIdentity();
  const video = visionLog.video;
  const frameW = r.frame.w > 0 ? r.frame.w : (video?.videoWidth ?? 0);
  const frameH = r.frame.h > 0 ? r.frame.h : (video?.videoHeight ?? 0);
  return {
    version: PROFILE_VERSION,
    measuredAt: Date.now(),
    camera: {
      ...camera,
      frameW,
      frameH,
      fps: Math.max(1, r.fps),
    },
    display: displayFacts(),
    box: r.box ?? { ...DEFAULT_BOX },
    validated: true,
  };
}

function Summary({
  profile,
  click,
}: {
  profile: CalibrationProfile;
  click: ReturnType<typeof useClickGesture>;
}) {
  return (
    <dl className="cal-summary">
      <div>
        <dt>Reach</dt>
        <dd>
          {profile.box.widthFaces.toFixed(1)} × {profile.box.heightFaces.toFixed(1)} face widths
        </dd>
      </div>
      <div>
        <dt>Click</dt>
        <dd>{clickGestureNoun(click)} · three cycles verified</dd>
      </div>
      <div>
        <dt>Display</dt>
        <dd>
          {profile.display.width}×{profile.display.height} · {profile.display.dpr.toFixed(2)}×
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

const COPY: Record<
  Phase,
  { step: string; title: string; purpose?: string; hint: string }
> = {
  resolving: { step: "", title: "", hint: "" },
  seek: {
    step: "Setup",
    title: "Stand where you would stand",
    hint: "Raise one hand so the camera can see both you and it.",
  },
  positions: {
    step: "1 of 3",
    title: "Show your comfortable movement range",
    purpose: "Purpose · measure the camera-visible hand range that will size the mapping.",
    hint: "Follow the movement words and hold comfortably. The checklist records camera positions; do not aim at a dot or screen location.",
  },
  gesture: {
    step: "2 of 3",
    title: "Verify the selection gesture",
    purpose: "Purpose · confirm this camera can see a deliberate close and open.",
    hint: "Close deliberately, then open the hand clearly.",
  },
  validate: {
    step: "3 of 3",
    title: "Check the fitted screen mapping",
    purpose: "Purpose · verify that the range measured in step 1 reaches the mapped display.",
    hint: "Move the marker through the five broad bands and pause briefly in each. This checks the result of step 1; it does not ask you to repeat its camera points or reach a corner.",
  },
  done: { step: "", title: "Ready", hint: "" },
};

function drawPreview(
  canvas: HTMLCanvasElement | null,
  box: { x0: number; y0: number; x1: number; y1: number } | null,
  phase: Phase,
): void {
  const ctx = canvas?.getContext("2d");
  if (!canvas || !ctx) return;
  const { width: w, height: h } = canvas;
  ctx.clearRect(0, 0, w, h);

  const video = visionLog.video;
  if (video && video.readyState >= 2 && video.videoWidth > 0) {
    ctx.save();
    ctx.translate(w, 0);
    ctx.scale(-1, 1);
    ctx.drawImage(video, 0, 0, w, h);
    ctx.restore();
    ctx.globalAlpha = 0.28;
    ctx.fillStyle = getComputedStyle(canvas).getPropertyValue("--gt-brand-black");
    ctx.fillRect(0, 0, w, h);
    ctx.globalAlpha = 1;
  }

  ctx.strokeStyle = "rgba(255,255,255,0.25)";
  ctx.lineWidth = 1;
  ctx.strokeRect(0.5, 0.5, w - 1, h - 1);

  if (phase === "positions") {
    ctx.strokeStyle = "rgba(255,255,255,0.18)";
    ctx.setLineDash([4, 4]);
    ctx.strokeRect(
      FRAME_MARGIN * w,
      FRAME_MARGIN * h,
      (1 - 2 * FRAME_MARGIN) * w,
      (1 - 2 * FRAME_MARGIN) * h,
    );
    ctx.setLineDash([]);
  }

  if (box && (phase === "gesture" || phase === "validate")) {
    ctx.strokeStyle = "rgba(122,122,255,0.9)";
    ctx.lineWidth = 2;
    ctx.strokeRect(
      (1 - box.x1) * w,
      box.y0 * h,
      (box.x1 - box.x0) * w,
      (box.y1 - box.y0) * h,
    );
  }
}
