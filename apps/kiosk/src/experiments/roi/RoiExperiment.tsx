import { useEffect, useRef, useState } from "react";
import {
  FilesetResolver,
  GestureRecognizer,
  type GestureRecognizerResult,
} from "@mediapipe/tasks-vision";
import { JOINT } from "../../lib/vision/mediapipe";
import { pinchFeatures } from "../../lib/vision/features";
import "./roi.css";

/**
 * FIXED-SCENE ROI — an experiment, not a change to the kiosk (`/?exp=roi`).
 *
 * THE QUESTION. The wall is a fixed installation: the camera is bolted in place, the visitor
 * stands in a corridor, and the region a hand can possibly occupy is a known rectangle that
 * never moves. Yet MediaPipe is handed the entire frame, every frame, exactly as it would be
 * on a laptop where the subject could be anywhere.
 *
 * WHY THAT COSTS RESOLUTION, which is the whole point. MediaPipe's detector does not see the
 * 1280-pixel frame. It resizes whatever it is given down to a fixed model input — a couple of
 * hundred pixels on a side — and runs there. So the number that decides whether a pinch is
 * legible is not the palm's size on the SENSOR, it is the palm's size AT THE MODEL INPUT, and
 * that is the sensor size scaled by (model input / frame width). A palm spanning 60px of a
 * 1280-wide frame arrives at the model about 10px across. Crop first to a 320-wide region
 * that the hand actually lives in and the same untouched sensor pixels arrive about 42px
 * across — four times the linear detail, for free, with no better camera and no lost optics.
 *
 * If that is where the pinch is being lost, this is the single largest software lever
 * available, and it is testable rather than arguable.
 *
 * WHY THE CROP IS DONE BY HAND. `ImageProcessingOptions.regionOfInterest` exists in the API
 * and THROWS for this task — no vision task in the pinned build sets the internal
 * `supportsRegionOfInterest` flag, so a hand-landmark call with an ROI raises "This task
 * doesn't support region-of-interest." The crop therefore goes through a canvas, at the ROI's
 * NATIVE pixel size (never upscaled — upscaling would invent detail and quietly flatter the
 * result).
 *
 * WHY IT COMPARES ON RECORDED FOOTAGE. Two live passes would be two different hands. The page
 * records a few seconds of the real camera, then replays that one recording twice — full
 * frame, then cropped — through ONE recognizer at a time, closed and rebuilt between passes.
 * The kiosk's single-instance rule (CLAUDE.md §4) is intact: this page replaces the app
 * entirely, never runs alongside it, and never holds two recognizers at once.
 *
 * WHAT IT DOES NOT SETTLE. Cropping cannot help if the hand was never resolved on the sensor
 * in the first place; at some distance both columns collapse together and that distance is the
 * camera's answer, not the software's.
 */

const ASSET = {
  wasm: "/mediapipe/wasm",
  gestureModel: "/mediapipe/models/gesture_recognizer.task",
};

const PARAMS = typeof window === "undefined" ? null : new URLSearchParams(location.search);
const num = (k: string, d: number) => {
  const v = Number(PARAMS?.get(k));
  return Number.isFinite(v) && PARAMS?.get(k) !== null ? v : d;
};

/**
 * The interaction region, as fractions of the frame: left, top, right, bottom.
 *
 * The default is a centred column a little over half the width and most of the height —
 * shaped for one person standing square to a wall-mounted camera. It deliberately INCLUDES
 * the head: the kiosk's whole mapping is anchored to the face (`calibration.ts`), so an ROI
 * that crops the face away would trade a readable pinch for an unusable cursor.
 *
 * Override at the wall with `?roi=0.2,0.05,0.8,1`.
 */
const ROI = (() => {
  const raw = PARAMS?.get("roi");
  const parts = raw?.split(",").map(Number);
  if (parts?.length === 4 && parts.every((n) => Number.isFinite(n))) {
    return { x0: parts[0]!, y0: parts[1]!, x1: parts[2]!, y1: parts[3]! };
  }
  return { x0: 0.22, y0: 0.0, x1: 0.78, y1: 1.0 };
})();

const RECORD_S = num("secs", 8);

interface PassResult {
  label: string;
  /** what the model was actually handed, in pixels */
  inputW: number;
  inputH: number;
  frames: number;
  handFrames: number;
  /** palm width in FRAME pixels (identical units in both passes — the crop is native res) */
  palmPx: number[];
  /** palm width AT THE MODEL INPUT — the number that actually decides legibility */
  palmAtModelPx: number[];
  ratio3: number[];
  ratioPx: number[];
  aperturePx: number[];
  inferMs: number[];
  /** palm centre in FULL-FRAME normalised coords, after the remap — a correctness check */
  centre: Array<{ x: number; y: number }>;
}

/** The gesture model's input side, for the "palm at the model" figure. */
const MODEL_INPUT_PX = 224;

export function RoiExperiment() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const playRef = useRef<HTMLVideoElement>(null);
  const cropRef = useRef<HTMLCanvasElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const [stage, setStage] = useState("booting");
  const [results, setResults] = useState<PassResult[]>([]);
  const clipRef = useRef<Blob | null>(null);
  const [clipInfo, setClipInfo] = useState("");

  // --- live preview, so the ROI can be aimed before anything is recorded -----------------
  useEffect(() => {
    let stream: MediaStream | null = null;
    let raf = 0;
    let stopped = false;
    (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: "user" },
          audio: false,
        });
        const v = videoRef.current;
        if (!v || stopped) return;
        v.srcObject = stream;
        await v.play();
        setStage("ready");
        const draw = () => {
          raf = requestAnimationFrame(draw);
          const c = overlayRef.current;
          if (!c || !v.videoWidth) return;
          c.width = v.videoWidth;
          c.height = v.videoHeight;
          const g = c.getContext("2d");
          if (!g) return;
          g.clearRect(0, 0, c.width, c.height);
          g.strokeStyle = "#3A3AF0"; // asset colour: an instrument overlay, not site UI
          g.lineWidth = Math.max(2, c.width / 320);
          g.strokeRect(
            ROI.x0 * c.width,
            ROI.y0 * c.height,
            (ROI.x1 - ROI.x0) * c.width,
            (ROI.y1 - ROI.y0) * c.height,
          );
        };
        raf = requestAnimationFrame(draw);
      } catch (e) {
        setStage(`camera failed — ${e instanceof Error ? e.message : String(e)}`);
      }
    })();
    return () => {
      stopped = true;
      cancelAnimationFrame(raf);
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, []);

  const record = async () => {
    const v = videoRef.current;
    const stream = v?.srcObject instanceof MediaStream ? v.srcObject : null;
    if (!stream) return;
    setStage(`recording ${RECORD_S}s — stand at the test distance and pinch repeatedly`);
    const chunks: BlobPart[] = [];
    const rec = new MediaRecorder(stream, { mimeType: pickMime() });
    rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    const done = new Promise<void>((res) => (rec.onstop = () => res()));
    rec.start();
    await new Promise((r) => setTimeout(r, RECORD_S * 1000));
    rec.stop();
    await done;
    const blob = new Blob(chunks, { type: rec.mimeType });
    clipRef.current = blob;
    setClipInfo(`${(blob.size / 1e6).toFixed(1)} MB, ${rec.mimeType}`);
    setStage("recorded — now analyse");
  };

  const analyse = async () => {
    const clip = clipRef.current;
    const play = playRef.current;
    const crop = cropRef.current;
    if (!clip || !play || !crop) return;
    play.src = URL.createObjectURL(clip);
    await new Promise<void>((res) => {
      play.onloadedmetadata = () => res();
    });

    const fileset = await FilesetResolver.forVisionTasks(ASSET.wasm);
    const out: PassResult[] = [];

    for (const mode of ["full", "roi"] as const) {
      setStage(`analysing — ${mode === "full" ? "pass 1: full frame" : "pass 2: cropped ROI"}`);
      // One recognizer at a time, built and closed per pass. Never two at once.
      const rec = await GestureRecognizer.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: ASSET.gestureModel, delegate: "GPU" },
        runningMode: "VIDEO",
        numHands: 2,
        minHandDetectionConfidence: 0.7,
        minHandPresenceConfidence: 0.7,
        minTrackingConfidence: 0.6,
      });
      out.push(await pass(mode, rec, play, crop));
      rec.close();
      setResults([...out]);
    }
    URL.revokeObjectURL(play.src);
    setStage("done");
  };

  return (
    <div className="gt-roi">
      <h1>Fixed-scene ROI — full frame vs cropped</h1>
      <p className="gt-roi__note">
        Records {RECORD_S}s of the live camera, then replays that ONE recording through the hand
        model twice: once whole, once cropped to the interaction region. The crop is at native
        pixel size — no upscaling, no invented detail. What changes is how much of the model's
        fixed input the hand gets to occupy.
      </p>

      <div className="gt-roi__stage">
        <video ref={videoRef} playsInline muted className="gt-roi__cam" />
        <canvas ref={overlayRef} className="gt-roi__overlay" />
      </div>

      <div className="gt-roi__bar">
        <button type="button" onClick={record} disabled={stage.startsWith("analysing")}>
          record {RECORD_S}s
        </button>
        <button type="button" onClick={analyse} disabled={!clipRef.current}>
          analyse both ways
        </button>
        <span>{stage}</span>
        {clipInfo ? <span>clip: {clipInfo}</span> : null}
      </div>

      <p className="gt-roi__note">
        ROI = {ROI.x0}, {ROI.y0} → {ROI.x1}, {ROI.y1} (override with{" "}
        <code>?roi=x0,y0,x1,y1</code>, length with <code>?secs=</code>). It includes the head on
        purpose: the cursor mapping is anchored to the face, so cropping the face away would
        trade a readable pinch for an unusable pointer.
      </p>

      {results.length ? <Table results={results} /> : null}

      {/* Replay + crop surfaces. Off-screen: they are machinery, not a picture. */}
      <video ref={playRef} playsInline muted className="gt-roi__hidden" />
      <canvas ref={cropRef} className="gt-roi__hidden" />
    </div>
  );
}

/** Run the whole recording once, either whole or cropped, and collect the comparison. */
async function pass(
  mode: "full" | "roi",
  rec: GestureRecognizer,
  play: HTMLVideoElement,
  crop: HTMLCanvasElement,
): Promise<PassResult> {
  const fw = play.videoWidth;
  const fh = play.videoHeight;
  const cx0 = Math.round(ROI.x0 * fw);
  const cy0 = Math.round(ROI.y0 * fh);
  const cw = Math.max(16, Math.round((ROI.x1 - ROI.x0) * fw));
  const ch = Math.max(16, Math.round((ROI.y1 - ROI.y0) * fh));
  crop.width = cw;
  crop.height = ch;
  const g = crop.getContext("2d", { willReadFrequently: false });

  const r: PassResult = {
    label: mode === "full" ? "full frame" : `ROI ${cw}×${ch}`,
    inputW: mode === "full" ? fw : cw,
    inputH: mode === "full" ? fh : ch,
    frames: 0,
    handFrames: 0,
    palmPx: [],
    palmAtModelPx: [],
    ratio3: [],
    ratioPx: [],
    aperturePx: [],
    inferMs: [],
    centre: [],
  };

  let ts = 0;
  await new Promise<void>((resolve) => {
    const onFrame = () => {
      if (play.ended) {
        resolve();
        return;
      }
      ts += 1;
      let res: GestureRecognizerResult;
      const t0 = performance.now();
      if (mode === "full") {
        res = rec.recognizeForVideo(play, ts);
      } else {
        g?.drawImage(play, cx0, cy0, cw, ch, 0, 0, cw, ch);
        res = rec.recognizeForVideo(crop, ts);
      }
      r.inferMs.push(performance.now() - t0);
      r.frames += 1;

      const lm = res.landmarks?.[0];
      const world = res.worldLandmarks?.[0];
      if (lm && lm.length >= 21) {
        r.handFrames += 1;
        // Features are computed in the pass's OWN pixel space, which is what makes the two
        // columns comparable: the crop is native resolution, so a palm 60 sensor-pixels wide
        // is 60 pixels wide in both. What differs is the fraction of the model input it fills.
        const f = pinchFeatures(
          { landmarks: lm.map((p) => ({ x: p.x, y: p.y, z: p.z ?? 0 })), world: (world ?? []).map((p) => ({ x: p.x, y: p.y, z: p.z ?? 0 })) },
          r.inputW,
          r.inputH,
        );
        r.palmPx.push(f.spanPx);
        r.palmAtModelPx.push((f.spanPx / r.inputW) * MODEL_INPUT_PX);
        r.ratio3.push(f.ratioWorld3D);
        r.ratioPx.push(f.ratioPx);
        r.aperturePx.push(f.aperturePx);

        // REMAP back to full-frame normalised coordinates. Landmarks come back normalised to
        // whatever was handed in, so an ROI result is normalised to the CROP — using it
        // unremapped would place the cursor in the wrong place by exactly the crop offset,
        // which is the classic way an ROI optimisation ships as a pointing bug.
        const wrist = lm[JOINT.wrist]!;
        const imcp = lm[JOINT.indexMcp]!;
        const pmcp = lm[JOINT.pinkyMcp]!;
        const toFull = (p: { x: number; y: number }) =>
          mode === "full"
            ? { x: p.x, y: p.y }
            : { x: (cx0 + p.x * cw) / fw, y: (cy0 + p.y * ch) / fh };
        const a = toFull(wrist);
        const b = toFull(imcp);
        const c = toFull(pmcp);
        r.centre.push({ x: (a.x + b.x + c.x) / 3, y: (a.y + b.y + c.y) / 3 });
      }
      next();
    };
    const next = () => {
      const anyPlay = play as HTMLVideoElement & {
        requestVideoFrameCallback?: (cb: () => void) => number;
      };
      if (anyPlay.requestVideoFrameCallback) anyPlay.requestVideoFrameCallback(onFrame);
      else requestAnimationFrame(onFrame);
    };
    play.currentTime = 0;
    play.onended = () => resolve();
    void play.play();
    next();
  });

  return r;
}

function Table({ results }: { results: PassResult[] }) {
  const [a, b] = results;
  return (
    <div className="gt-roi__table">
      <table>
        <thead>
          <tr>
            <th>measure</th>
            {results.map((r) => (
              <th key={r.label}>{r.label}</th>
            ))}
            {a && b ? <th>change</th> : null}
          </tr>
        </thead>
        <tbody>
          <Row label="model input px" v={results.map((r) => `${r.inputW}×${r.inputH}`)} />
          <Row
            label="hand found"
            v={results.map((r) => `${r.handFrames}/${r.frames} (${pctOf(r.handFrames, r.frames)})`)}
            delta={a && b ? diff(b.handFrames / b.frames, a.handFrames / a.frames, 2) : ""}
          />
          <Row
            label="palm px on sensor"
            v={results.map((r) => med(r.palmPx).toFixed(1))}
            delta={a && b ? diff(med(b.palmPx), med(a.palmPx), 1) : ""}
          />
          <Row
            label="palm px AT MODEL INPUT"
            v={results.map((r) => med(r.palmAtModelPx).toFixed(1))}
            delta={a && b ? diff(med(b.palmAtModelPx), med(a.palmAtModelPx), 1) : ""}
            emphasis
          />
          <Row
            label="aperture px, minimum"
            v={results.map((r) => (r.aperturePx.length ? Math.min(...r.aperturePx).toFixed(1) : "—"))}
          />
          <Row
            label="ratio3D, minimum reached"
            v={results.map((r) => (r.ratio3.length ? Math.min(...r.ratio3).toFixed(3) : "—"))}
            emphasis
          />
          <Row
            label="ratioPx, minimum reached"
            v={results.map((r) => (r.ratioPx.length ? Math.min(...r.ratioPx).toFixed(3) : "—"))}
          />
          <Row label="inference ms, median" v={results.map((r) => med(r.inferMs).toFixed(1))} />
          <Row
            label="palm centre agreement"
            v={[a && b ? `${(agreement(a, b) * 100).toFixed(2)}% of frame` : "—", ""]}
          />
        </tbody>
      </table>
      <p className="gt-roi__note">
        <strong>palm px at model input</strong> is the number to read. The sensor row barely
        moves — cropping adds no optics — while the model row is the same pixels expressed as a
        share of the fixed input the network actually sees. <strong>ratio3D minimum</strong> is
        whether that extra share bought a readable pinch. <strong>Palm centre agreement</strong>{" "}
        is the remap's own check: the two passes should place the same hand in the same place in
        full-frame coordinates, so a large number there means the coordinate transform is wrong
        and nothing else in the table can be trusted.
      </p>
    </div>
  );
}

function Row({
  label,
  v,
  delta,
  emphasis,
}: {
  label: string;
  v: string[];
  delta?: string;
  emphasis?: boolean;
}) {
  return (
    <tr data-emphasis={emphasis ? "true" : undefined}>
      <td>{label}</td>
      {v.map((x, i) => (
        <td key={i}>{x}</td>
      ))}
      {delta !== undefined ? <td>{delta}</td> : null}
    </tr>
  );
}

/** Median distance between the two passes' palm centres, in full-frame fractions. */
function agreement(a: PassResult, b: PassResult): number {
  const n = Math.min(a.centre.length, b.centre.length);
  const d: number[] = [];
  for (let i = 0; i < n; i += 1) {
    d.push(Math.hypot(a.centre[i]!.x - b.centre[i]!.x, a.centre[i]!.y - b.centre[i]!.y));
  }
  return med(d);
}

function med(a: number[]): number {
  const v = a.filter(Number.isFinite).sort((x, y) => x - y);
  return v.length ? v[Math.floor((v.length - 1) / 2)]! : Number.NaN;
}
const pctOf = (a: number, b: number) => (b ? `${((a / b) * 100).toFixed(0)}%` : "—");
const diff = (b: number, a: number, d: number) =>
  Number.isFinite(a) && Number.isFinite(b) ? `${b >= a ? "+" : ""}${(b - a).toFixed(d)} (×${(b / a).toFixed(2)})` : "—";

function pickMime(): string {
  const want = ["video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm", "video/mp4"];
  return want.find((m) => MediaRecorder.isTypeSupported(m)) ?? "video/webm";
}
