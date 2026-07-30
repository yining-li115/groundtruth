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
 * ASSET HOSTING: the WASM runtime and both models are served from the kiosk's OWN origin,
 * placed there by `scripts/fetch-mediapipe.mjs` (which dev and build run for you). They used
 * to come from public CDNs, which is the wrong dependency for a screen behind glass on a
 * university network: a blocked or throttled CDN doesn't fail loudly, it just means no hand
 * is ever tracked and the wall looks broken for no visible reason (architecture §8).
 *
 * The WASM is copied out of node_modules, so it always matches the pinned tasks-vision
 * version — a runtime/API mismatch throws at load.
 */

const ASSET = {
  wasm: "/mediapipe/wasm",
  gestureModel: "/mediapipe/models/gesture_recognizer.task",
  faceModel: "/mediapipe/models/blaze_face_short_range.tflite",
};

/** One hand landmark, normalised to [0,1] of the video frame (raw, un-mirrored). `z` is
 *  MediaPipe's relative depth: roughly 0 at the wrist, negative toward the camera. */
export interface Landmark {
  x: number;
  y: number;
  z: number;
}

/** Indices into the 21-point hand skeleton, for the joints the interaction actually reads. */
export const JOINT = {
  wrist: 0,
  thumbTip: 4,
  indexMcp: 5,
  indexTip: 8,
  middleTip: 12,
  ringTip: 16,
  pinkyMcp: 17,
  pinkyTip: 20,
} as const;

/** The 21-point skeleton as bones, for drawing. */
export const HAND_BONES: ReadonlyArray<readonly [number, number]> = [
  [0, 1], [1, 2], [2, 3], [3, 4], // thumb
  [0, 5], [5, 6], [6, 7], [7, 8], // index
  [5, 9], [9, 10], [10, 11], [11, 12], // middle
  [9, 13], [13, 14], [14, 15], [15, 16], // ring
  [13, 17], [17, 18], [18, 19], [19, 20], // pinky
  [0, 17], // palm base
];

/**
 * Top hand this frame: canned gesture label, index-fingertip position, and the FULL 21-point
 * skeleton. The landmarks were always in the model output — only the fingertip used to be
 * kept, which is not enough to read a pinch or draw a hand.
 */
export interface HandResult {
  label: string;
  score: number;
  cx: number; // index fingertip x in [0,1]
  cy: number; // index fingertip y in [0,1]
  /** 21 points normalised to the frame — use for drawing and for where the hand IS */
  landmarks: Landmark[];
  /**
   * The same 21 points in METRES, origin at the hand's centre. Distances here are
   * independent of how far the hand is from the lens, which normalised coordinates are not:
   * measure a pinch in frame units and simply stepping back reads as a tighter pinch.
   */
  world: Landmark[];
  /** "Left" | "Right" as seen by the model (the raw, un-mirrored camera view) */
  handedness: string;
}

/** Which fingers are held out, in thumb→pinky order. */
export type Fingers = [boolean, boolean, boolean, boolean, boolean];

const FINGER_JOINTS: ReadonlyArray<readonly [number, number]> = [
  [4, 2], // thumb: tip vs its MCP
  [8, 6], // index: tip vs PIP
  [12, 10],
  [16, 14],
  [20, 18],
];

/**
 * Read which fingers are extended, by asking whether each fingertip reaches further from the
 * wrist than the joint below it. Comparing against the wrist rather than using raw screen
 * coordinates is what keeps this working with the hand tilted or upside down — a test like
 * "tip is above the knuckle" only holds for a hand held straight up.
 */
export function extendedFingers(lm: Landmark[]): Fingers {
  const wrist = lm[0];
  if (!wrist || lm.length < 21) return [false, false, false, false, false];
  const reach = (i: number) => Math.hypot(lm[i]!.x - wrist.x, lm[i]!.y - wrist.y);
  return FINGER_JOINTS.map(([tip, joint]) => reach(tip) > reach(joint) * 1.12) as Fingers;
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
  /** highest-confidence hand — what the older single-hand interactions read */
  hand: HandResult | null;
  /** every tracked hand this frame, up to two */
  hands: HandResult[];
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
        numHands: 2, // two-handed control: separation drives zoom, midpoint drives pan
        // raise the bars so background / faces don't register as a phantom hand (which would
        // wrongly flip the showreel into "someone is here" and assemble the splat)
        minHandDetectionConfidence: 0.7,
        minHandPresenceConfidence: 0.7,
        minTrackingConfidence: 0.6,
      }),
      FaceDetector.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: ASSET.faceModel, delegate: "GPU" },
        runningMode: "VIDEO",
      }),
    ]);
  }

  /** Run both models on one video frame. `tsMs` must strictly increase across calls. */
  process(video: HTMLVideoElement, tsMs: number): VisionResult {
    if (!this.gesture || !this.face) return { hand: null, hands: [], face: null };
    const g: GestureRecognizerResult = this.gesture.recognizeForVideo(video, tsMs);
    const f: FaceDetectorResult = this.face.detectForVideo(video, tsMs);
    const hands = allHands(g);
    return { hand: hands[0] ?? null, hands, face: largestFace(f, video) };
  }

  close(): void {
    this.gesture?.close();
    this.face?.close();
    this.gesture = this.face = null;
  }
}

function allHands(r: GestureRecognizerResult): HandResult[] {
  const out: HandResult[] = [];
  for (let i = 0; i < (r.landmarks?.length ?? 0); i += 1) {
    const lm = r.landmarks[i];
    if (!lm || lm.length < 21) continue;
    const cat = r.gestures?.[i]?.[0];
    out.push({
      // keep the hand even when no canned gesture matches; label may be "None"
      label: cat?.categoryName ? cat.categoryName : "None",
      score: cat?.score ?? 0,
      cx: lm[8]!.x, // index fingertip — the "pointer" the older interactions steer with
      cy: lm[8]!.y,
      landmarks: lm.map((p) => ({ x: p.x, y: p.y, z: p.z ?? 0 })),
      world: (r.worldLandmarks?.[i] ?? []).map((p) => ({ x: p.x, y: p.y, z: p.z ?? 0 })),
      handedness: r.handedness?.[i]?.[0]?.categoryName ?? "",
    });
  }
  return out;
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
