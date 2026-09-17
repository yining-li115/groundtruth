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
 * This is only the "decoded camera frame → detections" layer. Ownership, gesture state and
 * interaction policy live downstream in `HandPointer`; keeping them out of this wrapper is
 * what lets every surface consume the same stable owner instead of inventing its own
 * interpretation of MediaPipe's per-frame result order.
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

/**
 * Is this hand closed into a fist, read from its own geometry?
 *
 * The canned `Closed_Fist` label is a trained classifier and it is the right first answer —
 * but on the wall it was the ONLY answer, and it kept not arriving: a visitor would close a
 * hand, hold it, and nothing happened, because the recogniser had decided "None" at 0.6 and
 * stayed there for as long as the fist was held. A fist seen from slightly below, or with the
 * thumb across the fingers, or at the far end of the camera's range, is exactly the kind of
 * frame a small classifier hedges on. Holding it longer does not help; the frames are all the
 * same frame.
 *
 * So the geometry is read as well. On the WORLD landmarks (metres, hand-centred), not the
 * screen ones: a finger pointing at the lens projects to almost nothing in 2D and reads as
 * curled, which is the false positive that makes geometric fists dangerous. In 3D a curled
 * fingertip is genuinely closer to the wrist than its own middle joint, whichever way the
 * hand is turned. Four curled fingers is a fist; the thumb is ignored, because where it ends
 * up in a fist varies by person and it is the least reliably tracked digit anyway.
 */
export function fistFromGeometry(world: Landmark[]): boolean {
  const ratios = fingerCurlRatios(world);
  return ratios !== null && ratios.every((ratio) => ratio < CURL_RATIO);
}

/**
 * Continuous non-thumb curl measurements used by the fist latch and its release hysteresis.
 * Values below 1 have not reached past the PIP joint; an extended finger is roughly 1.6.
 */
export function fingerCurlRatios(world: Landmark[]): [number, number, number, number] | null {
  if (world.length < 21) return null;
  const wrist = world[0]!;
  const d = (i: number) =>
    Math.hypot(world[i]!.x - wrist.x, world[i]!.y - wrist.y, world[i]!.z - wrist.z);
  const ratios = CURL_JOINTS.map(([tip, pip]) => {
    const joint = d(pip);
    const tipDistance = d(tip);
    return joint > 1e-6 && Number.isFinite(joint) && Number.isFinite(tipDistance)
      ? tipDistance / joint
      : Number.NaN;
  });
  if (!ratios.every(Number.isFinite)) return null;
  return ratios as [number, number, number, number];
}
const CURL_JOINTS: ReadonlyArray<readonly [number, number]> = [
  [8, 6],
  [12, 10],
  [16, 14],
  [20, 18],
];
/** How far short of the PIP joint the tip must sit. Below 1 is folded back toward the palm;
 *  an extended finger is at roughly 1.6, so the margin is wide on both sides. */
const CURL_RATIO = 1.0;

/** One detected face, box normalised to [0,1] of the video frame (raw, un-mirrored). */
export interface FaceResult {
  cx: number;
  cy: number;
  w: number;
  h: number;
  score: number;
}

export interface VisionResult {
  /**
   * @deprecated Per-frame array position is not an identity. Production interaction must use
   * `hands` through `StableHandOwner`; retained only for fixture/backwards compatibility.
   */
  hand: HandResult | null;
  /** Every tracked hand this frame, up to two. Ordering is explicitly unstable. */
  hands: HandResult[];
  /** Every detected face. Production associates one of these with the stable hand owner. */
  faces?: FaceResult[];
  /** @deprecated Largest face, retained for experiments and old fixtures. */
  face: FaceResult | null;
  /**
   * The frame's TRUE pixel size, as the browser actually delivered it.
   *
   * Landmarks are normalised, which quietly hides the one number the kiosk's whole distance
   * problem is about: how many pixels of hand there were. `getUserMedia` is asked for 1280×720
   * and is free to hand back 640×480, and everything downstream would read identically — a
   * palm at 0.1 of the frame is 128px or 64px depending on an answer nothing was checking.
   * Carried here so no consumer has to assume a resolution (one of them was assuming 1280).
   */
  frame?: { w: number; h: number };
}

export class VisionEngine {
  private gesture: GestureRecognizer | null = null;
  private face: FaceDetector | null = null;

  async load(): Promise<void> {
    const fileset = await FilesetResolver.forVisionTasks(ASSET.wasm);
    // Load both tasks in parallel. Prefer the GPU delegate; MediaPipe silently falls back
    // to CPU inside the WASM runtime if WebGL isn't available. `allSettled` matters here: if
    // one task succeeds and the other fails, Promise.all loses the fulfilled handle and leaks
    // its GPU/WASM resources forever.
    const [gesture, face] = await Promise.allSettled([
      GestureRecognizer.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: ASSET.gestureModel, delegate: "GPU" },
        runningMode: "VIDEO",
        // A second detection lets the owner tracker refuse a bystander instead of blindly
        // accepting whichever hand MediaPipe happened to place at index zero this frame.
        numHands: 2,
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
    if (gesture.status === "rejected" || face.status === "rejected") {
      if (gesture.status === "fulfilled") gesture.value.close();
      if (face.status === "fulfilled") face.value.close();
      if (gesture.status === "rejected") throw gesture.reason;
      if (face.status === "rejected") throw face.reason;
    }
    this.gesture = gesture.value;
    this.face = face.value;
  }

  /** Run both models on one video frame. `tsMs` must strictly increase across calls. */
  process(video: HTMLVideoElement, tsMs: number): VisionResult {
    if (!this.gesture || !this.face) return { hand: null, hands: [], face: null };
    const g: GestureRecognizerResult = this.gesture.recognizeForVideo(video, tsMs);
    const f: FaceDetectorResult = this.face.detectForVideo(video, tsMs);
    const hands = allHands(g);
    const faces = allFaces(f, video);
    return {
      hand: hands[0] ?? null,
      hands,
      faces,
      face: largestFace(faces),
      frame: { w: video.videoWidth, h: video.videoHeight },
    };
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

function allFaces(r: FaceDetectorResult, video: HTMLVideoElement): FaceResult[] {
  const dets = r.detections;
  if (!dets?.length) return [];
  const vw = video.videoWidth || 1;
  const vh = video.videoHeight || 1;
  const faces: FaceResult[] = [];
  for (const d of dets) {
    const b = d.boundingBox;
    if (!b) continue;
    const face = {
      cx: (b.originX + b.width / 2) / vw,
      cy: (b.originY + b.height / 2) / vh,
      w: b.width / vw,
      h: b.height / vh,
      score: d.categories?.[0]?.score ?? 1,
    };
    if (
      [face.cx, face.cy, face.w, face.h, face.score].every(Number.isFinite) &&
      face.w > 0 &&
      face.h > 0
    ) {
      faces.push(face);
    }
  }
  return faces;
}

function largestFace(faces: FaceResult[]): FaceResult | null {
  return faces.reduce<FaceResult | null>(
    (best, face) => (!best || face.w * face.h > best.w * best.h ? face : best),
    null,
  );
}
