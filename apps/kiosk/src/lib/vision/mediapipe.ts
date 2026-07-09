import {
  FilesetResolver,
  GestureRecognizer,
  FaceDetector,
  type GestureRecognizerResult,
  type FaceDetectorResult,
} from "@mediapipe/tasks-vision";

/**
 * MediaPipe vision engine — loads the Gesture Recognizer (hand open/close) and the Face
 * Detector (head position) once, then runs both on a single webcam frame per tick.
 *
 * This is the "camera → numbers" layer for the touchless showreel interaction: hand
 * gestures drive the point cloud's dispersal, head position drives its orbit. It is
 * framework-agnostic on purpose (no React) so it can move from the /?exp=cv playground
 * into the real showreel unchanged.
 *
 * ASSET HOSTING — EXPERIMENT STAGE: the WASM runtime + the two model files are pulled
 * from public CDNs (jsDelivr + Google model storage) so we can iterate fast. Before this
 * ships into the idle showreel it MUST be self-hosted under apps/kiosk/public/ so the
 * kiosk works offline (docs/architecture.md §8). Only ASSET_BASE below changes then.
 */

// tasks-vision is pinned in package.json — keep this version in lockstep with it so the
// WASM runtime matches the JS API (a mismatch throws at load).
const TASKS_VISION_VERSION = "0.10.35";

const ASSET = {
  wasm: `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${TASKS_VISION_VERSION}/wasm`,
  gestureModel:
    "https://storage.googleapis.com/mediapipe-models/gesture_recognizer/gesture_recognizer/float16/1/gesture_recognizer.task",
  faceModel:
    "https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/1/blaze_face_short_range.tflite",
};

/** Top hand this frame: canned gesture label + INDEX-FINGERTIP position ([0,1], raw/un-mirrored). */
export interface HandResult {
  label: string;
  score: number;
  cx: number; // index fingertip x in [0,1]
  cy: number; // index fingertip y in [0,1]
}

/** Largest detected face, box normalised to [0,1] of the video frame (raw, un-mirrored). */
export interface FaceResult {
  cx: number;
  cy: number;
  w: number;
  h: number;
  score: number;
}

export interface VisionResult {
  hand: HandResult | null;
  face: FaceResult | null;
}

export class VisionEngine {
  private gesture: GestureRecognizer | null = null;
  private face: FaceDetector | null = null;

  async load(): Promise<void> {
    const fileset = await FilesetResolver.forVisionTasks(ASSET.wasm);
    // Load both tasks in parallel. Prefer the GPU delegate; MediaPipe silently falls back
    // to CPU inside the WASM runtime if WebGL isn't available.
    [this.gesture, this.face] = await Promise.all([
      GestureRecognizer.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: ASSET.gestureModel, delegate: "GPU" },
        runningMode: "VIDEO",
        numHands: 1,
      }),
      FaceDetector.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: ASSET.faceModel, delegate: "GPU" },
        runningMode: "VIDEO",
      }),
    ]);
  }

  /** Run both models on one video frame. `tsMs` must strictly increase across calls. */
  process(video: HTMLVideoElement, tsMs: number): VisionResult {
    if (!this.gesture || !this.face) return { hand: null, face: null };
    const g: GestureRecognizerResult = this.gesture.recognizeForVideo(video, tsMs);
    const f: FaceDetectorResult = this.face.detectForVideo(video, tsMs);
    return { hand: topHand(g), face: largestFace(f, video) };
  }

  close(): void {
    this.gesture?.close();
    this.face?.close();
    this.gesture = this.face = null;
  }
}

function topHand(r: GestureRecognizerResult): HandResult | null {
  const lm = r.landmarks?.[0];
  if (!lm || lm.length < 21) return null; // no hand this frame
  // index fingertip (landmark 8) → the "pointer" that steers the orbit
  const cx = lm[8]!.x;
  const cy = lm[8]!.y;
  const cat = r.gestures?.[0]?.[0];
  // keep the hand (for orbit) even when no canned gesture matches; label may be "None"
  const label = cat && cat.categoryName ? cat.categoryName : "None";
  return { label, score: cat?.score ?? 0, cx, cy };
}

function largestFace(r: FaceDetectorResult, video: HTMLVideoElement): FaceResult | null {
  const dets = r.detections;
  if (!dets?.length) return null;
  const vw = video.videoWidth || 1;
  const vh = video.videoHeight || 1;
  let best = dets[0]!;
  let bestArea = -1;
  for (const d of dets) {
    const b = d.boundingBox;
    if (!b) continue;
    const area = b.width * b.height;
    if (area > bestArea) {
      bestArea = area;
      best = d;
    }
  }
  const b = best.boundingBox;
  if (!b) return null;
  return {
    cx: (b.originX + b.width / 2) / vw,
    cy: (b.originY + b.height / 2) / vh,
    w: b.width / vw,
    h: b.height / vh,
    score: best.categories?.[0]?.score ?? 1,
  };
}
