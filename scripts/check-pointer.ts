/**
 * Edge-case harness for the hand pointer (`npm run check:pointer`).
 *
 * The pointing code cannot be exercised by opening the page: reproducing "the hand vanished
 * mid-pinch" or "the face was occluded for one second while the hand kept moving" in front of
 * a real camera is slow, unrepeatable, and impossible to assert on. So the state machine is
 * fed synthetic vision results instead, on a virtual clock, and every failure mode we have
 * actually hit is pinned down as a test that fails loudly if it comes back.
 *
 * These are the cases that matter because each one, in the real thing, is a screen in a
 * public hallway behaving as though it were broken: a click stuck down, a cursor that glides
 * in from where the last visitor left it, a dwell that fires forever, a pointer that dies the
 * moment someone reaches across their own face.
 */
import {
  DEFAULT_GESTURE_TIMING,
  HandPointer,
  DEFAULT_POINTER,
  FistLatch,
  hasFreshOwner,
  PRESS_DEBOUNCE_MS,
  type PointerConfig,
} from "../apps/kiosk/src/lib/vision/handPointer";
import type { FaceResult, HandResult, Landmark, VisionResult } from "../apps/kiosk/src/lib/vision/mediapipe";
import { StableHandOwner } from "../apps/kiosk/src/lib/vision/handOwner";
import { StableOwnerFace } from "../apps/kiosk/src/lib/vision/faceOwner";
import {
  CONTROL_FRESH_MAX_MS,
  CONTROL_FRESH_MIN_MS,
  CONTROL_MAX_INFERENCE_MS,
  InferenceHealthMonitor,
} from "../apps/kiosk/src/lib/vision/controlFreshness";
import {
  beginSceneGrab,
  cancelSceneGrab,
  endSceneGrab,
  flightInput,
  resetSceneInput,
  setSceneAvailability,
  setSceneMode,
  setSceneReady,
  updateSceneGrab,
} from "../apps/kiosk/src/lib/vision/flightInput";
import {
  FaceAnchor,
  fallbackBox,
  frameYInXUnits,
  interactionBox,
  palmWidthNorm,
  PINCH_GRACE_MS,
  PINCH_ON_MS,
  PINCH_SETTLE_MS,
  PinchDetector,
} from "../apps/kiosk/src/lib/vision/calibration";
import { PointerStabilizer } from "../apps/kiosk/src/lib/vision/pointerStabilizer";
import {
  advanceGestureProof,
  validationZone,
} from "../apps/kiosk/src/lib/vision/calibrationValidation";
import {
  activeCameraIdentity,
  cameraIdentityFromTrack,
  cameraIdentityRevision,
  cameraSignature,
  isAnonymousCameraIdentity,
  onCameraIdentity,
  publishCameraIdentity,
} from "../apps/kiosk/src/lib/vision/cameraPairing";
import { dragScrollVelocity } from "../apps/kiosk/src/lib/scrollGesture";
import {
  fitAxisReach,
  fitReach,
  fitCorners,
  shrinkBox,
  isUsableBox,
  type ReachSample,
} from "../apps/kiosk/src/lib/vision/reachFit";
import {
  PROFILE_VERSION,
  conservativeInstallationBox,
  isInstallationBox,
  isUsableProfile,
} from "../apps/kiosk/src/lib/vision/profile";
import {
  profileKey,
  profileMatchesPair,
} from "../apps/kiosk/src/lib/vision/profileStore";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ASPECT = 16 / 9;
const STEP = 33; // ms per frame, ~30fps like the measured camera

let failures = 0;
let checks = 0;

function ok(label: string, cond: boolean, detail = ""): void {
  checks += 1;
  if (cond) {
    console.log(`  ✓ ${label}`);
  } else {
    failures += 1;
    console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

function near(a: number, b: number, tol: number): boolean {
  return Math.abs(a - b) <= tol;
}

/** A face big enough that the box fits the frame comfortably — roughly a metre away. */
function face(cx = 0.5, cy = 0.35, w = 0.075): FaceResult {
  return { cx, cy, w, h: w * 1.3, score: 0.99 };
}

/**
 * A synthetic hand. `x`/`y` land exactly on the palm centre (the average of wrist and the two
 * outer knuckles), so a test can assert where the cursor should end up without reconstructing
 * the geometry. `ratio` is the aperture over palm width — the pinch signal.
 */
function hand(x: number, y: number, ratio = 1.44, label = "None", score = 0.9): HandResult {
  const lm: Landmark[] = Array.from({ length: 21 }, () => ({ x, y, z: 0 }));
  lm[0] = { x, y, z: 0 }; // wrist
  lm[5] = { x: x - 0.03, y, z: 0 }; // index MCP
  lm[17] = { x: x + 0.03, y, z: 0 }; // pinky MCP
  lm[8] = { x, y: y - 0.05, z: 0 }; // index tip

  const span = 0.08; // 8cm palm, in metres
  const world: Landmark[] = Array.from({ length: 21 }, () => ({ x: 0, y: 0, z: 0 }));
  world[5] = { x: -span / 2, y: 0, z: 0 };
  world[17] = { x: span / 2, y: 0, z: 0 };
  world[4] = { x: 0, y: 0, z: 0 }; // thumb tip
  world[8] = { x: ratio * span, y: 0, z: 0 }; // index tip, at the requested aperture

  return { label, score, cx: x, cy: y - 0.05, landmarks: lm, world, handedness: "Right" };
}

function handWithPalm(
  x: number,
  y: number,
  palmSpan: number,
  handedness = "Right",
): HandResult {
  const result = hand(x, y);
  result.landmarks[5] = { x: x - palmSpan / 2, y, z: 0 };
  result.landmarks[17] = { x: x + palmSpan / 2, y, z: 0 };
  result.handedness = handedness;
  return result;
}

function frame(h: HandResult | null, f: FaceResult | null = face()): VisionResult {
  return { hand: h, hands: h ? [h] : [], faces: f ? [f] : [], face: f };
}

/** Drive the pointer for `ms`, returning the last state. */
function run(
  p: HandPointer,
  clock: { t: number },
  ms: number,
  make: (t: number) => VisionResult,
): ReturnType<HandPointer["update"]> {
  let last = p.state;
  const end = clock.t + ms;
  while (clock.t < end) {
    clock.t += STEP;
    last = p.update(make(clock.t), ASPECT, clock.t);
  }
  return last;
}

function fresh(cfg: Partial<PointerConfig> = {}): { p: HandPointer; clock: { t: number } } {
  return { p: new HandPointer({ ...DEFAULT_POINTER, ...cfg }), clock: { t: 1000 } };
}

// ---------------------------------------------------------------------------

console.log("\nhand pointer — edge cases\n");

{
  console.log("camera/profile pairing boundary");
  const seen: string[] = [];
  const off = onCameraIdentity((camera) => seen.push(cameraSignature(camera)));
  publishCameraIdentity({ deviceId: "camera-a", label: "USB Camera" });
  publishCameraIdentity({ deviceId: "camera-a", label: "USB Camera" });
  publishCameraIdentity({ deviceId: "camera-b", label: "Laptop Camera" });
  off();
  ok("reopening the same camera does not manufacture a pairing change", seen.length === 2);
  ok(
    "a replacement camera is published before its profile can be reused",
    cameraSignature(activeCameraIdentity()) === "camera-b\u0000Laptop Camera",
  );
  const beforeRoundTrip = cameraIdentityRevision();
  publishCameraIdentity({ deviceId: "camera-a", label: "USB Camera" });
  publishCameraIdentity({ deviceId: "camera-b", label: "Laptop Camera" });
  ok(
    "an A → B → A pairing round-trip remains observable after the signature matches again",
    cameraIdentityRevision() === beforeRoundTrip + 2 &&
      cameraSignature(activeCameraIdentity()) === "camera-b\u0000Laptop Camera",
  );
  const anonymous = cameraIdentityFromTrack({
    id: "private-track-1",
    label: "",
    getSettings: () => ({}),
  } as MediaStreamTrack);
  ok(
    "a live anonymous browser track gets a session-bound identity",
    anonymous.deviceId.endsWith("private-track-1") &&
      isAnonymousCameraIdentity(anonymous) &&
      !!anonymous.label,
  );
}

{
  console.log("presence");
  const { p, clock } = fresh({ clickGesture: "pinch" });
  run(p, clock, 100, () => frame(hand(0.5, 0.7)));
  ok("a hand that has only just appeared is not trusted yet", !p.state.present);
  run(p, clock, 300, () => frame(hand(0.5, 0.7)));
  ok("...and is, once it persists past enterMs", p.state.present);

  run(p, clock, 150, () => frame(null));
  ok("a brief disappearance does not end the session", p.state.present);
  run(p, clock, 1500, () => frame(null));
  ok("a long one does", !p.state.present);
}

{
  console.log("\nstable hand ownership");
  const owner = new StableHandOwner({ missingHoldMs: 200, matchPalmWidths: 2 });
  const visitor = handWithPalm(0.28, 0.65, 0.1, "Right");
  const bystander = handWithPalm(0.76, 0.62, 0.055, "Left");

  const first = owner.update([visitor, bystander], 1000);
  const firstId = first.ownerId;
  ok("the nearer/larger hand becomes the initial owner", first.hand === visitor && firstId !== null);

  const swapped = owner.update([bystander, visitor], 1033);
  ok(
    "MediaPipe array reordering does not swap the owner",
    swapped.ownerId === firstId && swapped.hand === visitor && swapped.selectedIndex === 1,
  );

  const gap = owner.update([bystander], 1100);
  ok(
    "another visible hand cannot steal a briefly missing owner",
    gap.ownerId === firstId && !gap.visible && gap.hand === null,
  );

  const replacement = owner.update([bystander], 1300);
  ok(
    "after the reservation expires, a replacement gets a new identity",
    replacement.visible && replacement.ownerId !== firstId && replacement.changed,
  );

  const wideOwner = new StableHandOwner();
  const imageCentre = handWithPalm(0.5, 0.5, 0.08);
  const nearBottom = handWithPalm(0.5, 0.889, 0.08);
  const wideSelected = wideOwner.update([nearBottom, imageCentre], 1_000, 16 / 9);
  ok(
    "16:9 owner tie-breaking still means the visual image centre",
    wideSelected.hand === imageCentre,
  );

  const faceOwner = new StableOwnerFace();
  const ownerFace = face(0.25, 0.3, 0.08);
  const largerBystanderFace = face(0.72, 0.3, 0.15);
  const wrist = { x: 0.25, y: 0.55, z: 0 };
  const associated = faceOwner.update(
    [largerBystanderFace, ownerFace],
    1,
    wrist,
    0.06,
    1_000,
  );
  ok("the hand owner is paired with the nearby face, not the largest face", associated === ownerFace);
  const movedOwnerFace = face(0.26, 0.305, 0.075);
  const kept = faceOwner.update(
    [face(0.72, 0.3, 0.2), movedOwnerFace],
    1,
    wrist,
    0.06,
    1_033,
  );
  ok("a bystander's changing face size cannot steal the owner's ruler", kept === movedOwnerFace);
  const faceGap = faceOwner.update([largerBystanderFace], 1, wrist, 0.06, 1_100);
  ok("an owner-face dropout is held instead of jumping to the bystander", faceGap === null);

  const tracksPhysicalFaceMotion = (aspect: number) => {
    const tracker = new StableOwnerFace();
    const physicalFace = (cy: number): FaceResult => ({
      cx: 0.5,
      cy: cy * aspect,
      w: 0.08,
      h: 0.104 * aspect,
      score: 0.99,
    });
    const firstFace = physicalFace(0.25);
    const movedFace = physicalFace(0.35);
    const physicalWrist = { x: 0.5, y: 0.45 * aspect, z: 0 };
    tracker.update([firstFace], 1, physicalWrist, 0.06, 1_000, aspect);
    return tracker.update([movedFace], 1, physicalWrist, 0.06, 1_033, aspect) === movedFace;
  };
  ok(
    "owner-face continuity has the same physical vertical gate at 4:3 and 16:9",
    tracksPhysicalFaceMotion(4 / 3) && tracksPhysicalFaceMotion(16 / 9),
  );
}

{
  console.log("\nfresh samples and explicit gesture events");
  const { p, clock } = fresh({ clickGesture: "fist" });
  run(p, clock, 600, () => frame(hand(0.5, 0.7)));
  p.drainEvents();
  ok("a just-decoded owner sample is actionable", hasFreshOwner(p.state, clock.t));
  ok("the same sample expires independently of cursor presence", !hasFreshOwner(p.state, clock.t + 121));

  const slow = fresh({ clickGesture: "fist" });
  for (let i = 0; i < 8; i += 1) {
    slow.clock.t += 160;
    slow.p.update(frame(hand(0.5, 0.7)), ASPECT, {
      seq: i + 1,
      receivedAtMs: slow.clock.t - 150,
      processedAtMs: slow.clock.t,
      inferenceMs: 150,
      mediaTimeMs: slow.clock.t - 150,
    });
  }
  ok(
    "a 150ms inference result is fresh when it actually becomes available",
    hasFreshOwner(slow.p.state, slow.clock.t),
  );
  ok(
    "slow-laptop cadence expands the bounded control freshness window",
    slow.p.state.sample.freshForMs > 150 && hasFreshOwner(slow.p.state, slow.clock.t + 150),
    `${slow.p.state.sample.freshForMs.toFixed(0)}ms`,
  );

  const loadedShowreel = fresh({ clickGesture: "fist" });
  for (let i = 0; i < 6; i += 1) {
    loadedShowreel.clock.t += 430;
    loadedShowreel.p.update(frame(hand(0.5, 0.7)), ASPECT, {
      seq: i + 1,
      receivedAtMs: loadedShowreel.clock.t - 420,
      processedAtMs: loadedShowreel.clock.t,
      inferenceMs: 420,
      mediaTimeMs: loadedShowreel.clock.t - 420,
    });
  }
  ok(
    "a loaded showreel result at 420ms remains actionable instead of killing control",
    hasFreshOwner(loadedShowreel.p.state, loadedShowreel.clock.t) &&
      loadedShowreel.p.state.sample.freshForMs >= 670,
    `${loadedShowreel.p.state.sample.freshForMs.toFixed(0)}ms`,
  );

  const loadedHeld = fresh({ clickGesture: "fist" });
  run(
    loadedHeld.p,
    loadedHeld.clock,
    400,
    () => frame(hand(0.5, 0.7, 1.44, "Open_Palm", 0.95)),
  );
  countPresses(
    loadedHeld.p,
    loadedHeld.clock,
    700,
    () => frame(hand(0.5, 0.7, 0.35, "Closed_Fist", 0.95)),
  );
  loadedHeld.p.drainEvents();
  for (let i = 0; i < 6; i += 1) {
    loadedHeld.clock.t += 430;
    loadedHeld.p.update(frame(hand(0.5, 0.7, 0.35, "Closed_Fist", 0.95)), ASPECT, {
      seq: i + 1,
      receivedAtMs: loadedHeld.clock.t - 420,
      processedAtMs: loadedHeld.clock.t,
      inferenceMs: 420,
      mediaTimeMs: loadedHeld.clock.t - 420,
    });
  }
  const heldOwner = loadedHeld.p.state.owner.id;
  loadedHeld.clock.t += 430;
  loadedHeld.p.update(frame(null), ASPECT, {
    seq: 7,
    receivedAtMs: loadedHeld.clock.t - 420,
    processedAtMs: loadedHeld.clock.t,
    inferenceMs: 420,
    mediaTimeMs: loadedHeld.clock.t - 420,
  });
  ok(
    "one missing result at loaded-showreel cadence keeps the active owner reserved",
    loadedHeld.p.state.pinched &&
      loadedHeld.p.state.owner.id === heldOwner &&
      !loadedHeld.p.drainEvents().some((event) => event.type === "cancel"),
  );
  loadedHeld.clock.t += 430;
  loadedHeld.p.update(frame(hand(0.5, 0.7, 0.35, "Closed_Fist", 0.95)), ASPECT, {
    seq: 8,
    receivedAtMs: loadedHeld.clock.t - 420,
    processedAtMs: loadedHeld.clock.t,
    inferenceMs: 420,
    mediaTimeMs: loadedHeld.clock.t - 420,
  });
  ok(
    "the same closed owner recovers after that slow missing result without a second press",
    loadedHeld.p.state.pinched &&
      loadedHeld.p.state.owner.id === heldOwner &&
      !loadedHeld.p.drainEvents().some(
        (event) => event.type === "cancel" || event.type === "press",
      ),
  );
  ok(
    "even the adaptive window rejects a genuinely frozen result",
    !hasFreshOwner(slow.p.state, slow.clock.t + 501),
  );

  const overAge = fresh({ clickGesture: "fist" });
  const capturedAt = overAge.clock.t + STEP;
  const completedAt = capturedAt + 800;
  overAge.clock.t = completedAt;
  overAge.p.update(frame(hand(0.5, 0.7)), ASPECT, {
    seq: 1,
    receivedAtMs: capturedAt,
    processedAtMs: completedAt,
    inferenceMs: 800,
    mediaTimeMs: capturedAt,
  });
  ok(
    "an over-age inference result is rejected even at the instant it completes",
    !hasFreshOwner(overAge.p.state, completedAt) && !overAge.p.state.sample.sourceFresh,
  );
  ok(
    "an over-age inference cannot inflate the action TTL",
    overAge.p.state.sample.freshForMs === CONTROL_FRESH_MIN_MS,
    `${overAge.p.state.sample.freshForMs.toFixed(0)}ms`,
  );

  const health = new InferenceHealthMonitor(CONTROL_MAX_INFERENCE_MS, 2_000, 5);
  let slowHealth = health.update(CONTROL_MAX_INFERENCE_MS + 1, 1_000);
  for (const at of [1_400, 1_800, 2_200, 2_600]) {
    slowHealth = health.update(CONTROL_MAX_INFERENCE_MS + 1, at);
  }
  ok("a short run of over-budget inference is allowed to recover", !slowHealth.terminal);
  slowHealth = health.update(CONTROL_MAX_INFERENCE_MS + 1, 3_050);
  ok("sustained unusable inference becomes an explicit terminal condition", slowHealth.terminal);
  const recoveredHealth = health.update(150, 3_200);
  ok(
    "one actionable result resets the slow-inference streak",
    !recoveredHealth.overBudget &&
      !recoveredHealth.terminal &&
      recoveredHealth.consecutiveFrames === 0,
  );

  const gap = fresh({ clickGesture: "fist" });
  run(gap.p, gap.clock, 600, () => frame(hand(0.5, 0.7, 1.44, "Open_Palm", 0.95)));
  gap.p.drainEvents();
  gap.clock.t += STEP;
  gap.p.update(
    frame(hand(0.5, 0.7, 1.44, "Closed_Fist", 0.95)),
    ASPECT,
    gap.clock.t,
  );
  gap.clock.t += CONTROL_FRESH_MAX_MS + STEP;
  gap.p.update(
    frame(hand(0.5, 0.7, 1.44, "Closed_Fist", 0.95)),
    ASPECT,
    gap.clock.t,
  );
  run(
    gap.p,
    gap.clock,
    700,
    () => frame(hand(0.5, 0.7, 1.44, "Closed_Fist", 0.95)),
  );
  ok(
    "open → one closed frame → over-budget gap → closed cannot become a press",
    !gap.p.state.pinched && !gap.p.drainEvents().some((event) => event.type === "press"),
  );
  run(
    gap.p,
    gap.clock,
    DEFAULT_GESTURE_TIMING.fistOffMs + STEP * 2,
    () => frame(hand(0.5, 0.7, 1.44, "Open_Palm", 0.95)),
  );
  run(
    gap.p,
    gap.clock,
    700,
    () => frame(hand(0.5, 0.7, 1.44, "Closed_Fist", 0.95)),
  );
  ok(
    "a sustained fresh open hand re-arms recognition after that gap",
    gap.p.drainEvents().some((event) => event.type === "press") && gap.p.state.pinched,
  );

  const heldAcrossGap = fresh({ clickGesture: "fist" });
  run(
    heldAcrossGap.p,
    heldAcrossGap.clock,
    500,
    () => frame(hand(0.5, 0.7, 1.44, "Open_Palm", 0.95)),
  );
  run(
    heldAcrossGap.p,
    heldAcrossGap.clock,
    700,
    () => frame(hand(0.5, 0.7, 1.44, "Closed_Fist", 0.95)),
  );
  heldAcrossGap.p.drainEvents();
  heldAcrossGap.clock.t += CONTROL_FRESH_MAX_MS + STEP;
  heldAcrossGap.p.update(
    frame(hand(0.5, 0.7, 1.44, "Closed_Fist", 0.95)),
    ASPECT,
    heldAcrossGap.clock.t,
  );
  const gapCancellation = heldAcrossGap.p.drainEvents();
  ok(
    "a decoded-frame gap cancels an active press instead of manufacturing a release",
    !heldAcrossGap.p.state.pinched &&
      gapCancellation.some(
        (event) => event.type === "cancel" && event.reason === "source-stale",
      ) &&
      !gapCancellation.some((event) => event.type === "release"),
  );

  run(p, clock, 700, () => frame(hand(0.5, 0.7, 1.44, "Closed_Fist", 0.9)));
  const press = p.drainEvents();
  const pressed = press.find((event) => event.type === "press");
  ok("a held fist emits one immutable press edge", !!pressed && p.state.pinched);
  ok(
    "the press carries both frozen aim and same-frame live position",
    !!pressed && Number.isFinite(pressed.aim.x) && Number.isFinite(pressed.live.x),
  );

  run(
    p,
    clock,
    DEFAULT_GESTURE_TIMING.fistOffMs + STEP * 2,
    () => frame(hand(0.5, 0.7, 1.44, "Open_Palm", 0.95)),
  );
  const opened = p.drainEvents();
  ok(
    "sustained positive open-hand evidence emits a normal release",
    opened.some((event) => event.type === "release") &&
      !opened.some((event) => event.type === "cancel"),
  );
  ok("draining edges is one-shot", p.drainEvents().length === 0);

  run(p, clock, 200, () => frame(hand(0.5, 0.7, 1.44, "Open_Palm", 0.95)));
  run(p, clock, 700, () => frame(hand(0.5, 0.7, 1.44, "Closed_Fist", 0.9)));
  p.drainEvents();
  p.invalidate(clock.t + 1, "source-stale");
  const stale = p.drainEvents();
  ok("a frozen source immediately invalidates action freshness", !hasFreshOwner(p.state, clock.t + 1));
  ok("a frozen source cannot leave visitor presence stuck on", !p.state.present);
  ok(
    "source loss cancels the held gesture and cannot look like a release",
    stale.some((event) => event.type === "cancel" && event.reason === "source-stale") &&
      !stale.some((event) => event.type === "release"),
  );
  const priorSeq = p.state.sample.seq;
  clock.t += STEP;
  p.update(frame(hand(0.5, 0.7, 1.44, "Open_Palm", 0.95)), ASPECT, {
    seq: 1, // a newly-created decoded-frame loop starts its local counter again
    receivedAtMs: clock.t,
    mediaTimeMs: 0,
  });
  ok("pointer sample ids remain monotonic across camera-loop restarts", p.state.sample.seq > priorSeq);
}

{
  console.log("\nrelease keeps the last genuinely closed position");
  const { p, clock } = fresh({ clickGesture: "fist" });
  run(p, clock, 400, () => frame(hand(0.5, 0.7, 1.44, "Open_Palm", 0.95)));
  run(p, clock, 700, () => frame(hand(0.5, 0.7, 0.35, "Closed_Fist", 0.95)));
  p.drainEvents();

  // Move while genuinely held so the saved coordinate is not merely the original press point.
  run(p, clock, 300, () => frame(hand(0.54, 0.7, 0.35, "Closed_Fist", 0.95)));
  const lastClosed = { x: p.state.liveX, y: p.state.liveY };
  p.drainEvents();

  // Opening changes the detected hand shape and may move the mapped wrist. That motion belongs
  // to release recognition, not to the held drag, so it must not be allowed to cancel a tap.
  run(
    p,
    clock,
    DEFAULT_GESTURE_TIMING.fistOffMs + 250,
    () => frame(hand(0.68, 0.7, 1.44, "Open_Palm", 0.95)),
  );
  const release = p.drainEvents().find((event) => event.type === "release");
  ok(
    "the release edge uses the last directly closed live position",
    !!release &&
      near(release.live.x, lastClosed.x, 1e-9) &&
      near(release.live.y, lastClosed.y, 1e-9),
    release
      ? `saved ${lastClosed.x.toFixed(3)}, release ${release.live.x.toFixed(3)}`
      : "no release edge",
  );
  ok(
    "the opening-frame cursor actually moved far enough to expose the regression",
    !!release && Math.hypot(p.state.liveX - release.live.x, p.state.liveY - release.live.y) > 0.025,
  );
}

{
  console.log("\na standard three-fingers-open pinch remains a pinch");
  const { p, clock } = fresh({ clickGesture: "pinch" });
  const posed = (ratio: number) => {
    const h = hand(0.5, 0.7, ratio, "None", 0.9);
    for (const [tip, pip, dx] of [
      [12, 10, -0.012],
      [16, 14, 0.012],
      [20, 18, 0.028],
    ] as const) {
      h.landmarks[pip] = { x: 0.5 + dx, y: 0.67, z: 0 };
      h.landmarks[tip] = { x: 0.5 + dx, y: 0.60, z: 0 };
    }
    return h;
  };
  run(p, clock, 600, () => frame(posed(1.44)));
  p.drainEvents();
  run(p, clock, 800, () => frame(posed(0.3)));
  const events = p.drainEvents();
  ok(
    "thumb/index closure can press while the other fingers remain extended",
    events.some((event) => event.type === "press" && event.via === "pinch"),
  );
  ok("the extended fingers do not instantly release that pinch", p.state.pinched);
  clock.t += STEP;
  p.update(frame(posed(1.44)), ASPECT, clock.t);
  ok("one noisy open-aperture frame cannot release a held pinch", p.state.pinched);
  ok(
    "the aperture spike queued no false release",
    !p.drainEvents().some((event) => event.type === "release"),
  );
  run(p, clock, 250, () => frame(posed(1.44)));
  ok("opening the thumb/index aperture releases it", p.drainEvents().some((e) => e.type === "release"));
}

{
  console.log("\nwhole-hand intent wins ambiguous close signals");
  const { p, clock } = fresh({ clickGesture: "either" });
  run(p, clock, 600, () => frame(hand(0.5, 0.7)));
  p.drainEvents();

  run(p, clock, 700, () => frame(hand(0.5, 0.7, 0.3, "Closed_Fist", 0.95)));
  const press = p.drainEvents().find((event) => event.type === "press");
  ok("a close seen as both fist and pinch is owned by the fist", press?.via === "fist");
  ok("calibration can inspect the fist latch independently", p.state.fistHeld);
  ok("the independent pinch latch remains observable too", p.state.pinchHeld);

  // Aperture alone can jump open on a compact/occluded fist. It must not release an operation
  // whose whole-hand classifier still says the fist is closed.
  run(p, clock, 300, () => frame(hand(0.5, 0.7, 1.2, "Closed_Fist", 0.95)));
  ok("pinch-aperture noise cannot release that fist", p.state.pinched);
  ok("no false release edge was queued", !p.drainEvents().some((event) => event.type === "release"));

  run(
    p,
    clock,
    DEFAULT_GESTURE_TIMING.fistOffMs + STEP * 2,
    () => frame(hand(0.5, 0.7, 1.2, "Open_Palm", 0.95)),
  );
  ok(
    "a sustained explicit open palm still releases it",
    p.drainEvents().some((event) => event.type === "release"),
  );

  const mixed = fresh({ clickGesture: "either" });
  run(mixed.p, mixed.clock, 400, () => frame(hand(0.5, 0.7, 1.44, "Open_Palm", 0.95)));
  countPresses(
    mixed.p,
    mixed.clock,
    700,
    () => frame(hand(0.5, 0.7, 0.3, "Closed_Fist", 0.95)),
  );
  mixed.p.drainEvents();
  run(
    mixed.p,
    mixed.clock,
    450,
    () => frame(hand(0.5, 0.7, 0.3, "Open_Palm", 0.95)),
  );
  const mixedRelease = mixed.p.drainEvents();
  run(
    mixed.p,
    mixed.clock,
    500,
    () => frame(hand(0.5, 0.7, 0.3, "Open_Palm", 0.95)),
  );
  const secondaryHeld = mixed.p.drainEvents();
  ok(
    "releasing a fist while the secondary pinch latch remains held ends only one epoch",
    mixedRelease.filter((event) => event.type === "release").length === 1 &&
      !mixedRelease.some((event) => event.type === "press") &&
      !secondaryHeld.some((event) => event.type === "press" || event.type === "release"),
  );
  run(mixed.p, mixed.clock, 300, () => frame(hand(0.5, 0.7, 1.44, "Open_Palm", 0.95)));
  const mixedNext = countPresses(
    mixed.p,
    mixed.clock,
    700,
    () => frame(hand(0.5, 0.7, 0.3, "Closed_Fist", 0.95)),
  );
  ok("both channels opening rearms the next either-mode gesture", mixedNext === 1);

  const { p: switched, clock: switchedClock } = fresh({ clickGesture: "pinch" });
  run(switched, switchedClock, 500, () => frame(hand(0.5, 0.7)));
  switched.configure({ clickGesture: "either" });
  run(
    switched,
    switchedClock,
    200,
    () => frame(hand(0.5, 0.7, 1.2, "Closed_Fist", 0.95)),
  );
  ok("a provisional calibration may enable and prove the fist independently", switched.state.fistHeld);
}

{
  console.log("\nthe click never sticks");
  const { p, clock } = fresh({ clickGesture: "pinch" });
  run(p, clock, 500, () => frame(hand(0.5, 0.7)));
  run(p, clock, 600, () => frame(hand(0.5, 0.7, 0.3)));
  ok("a pinch registers once it has been held", p.state.pinched);

  // One or two missing detections are ordinary webcam noise, especially as the fingers fold
  // over the palm. The reserved owner must keep the transaction alive, but the missing frame
  // itself is never allowed to look like an open/release.
  run(p, clock, 66, () => frame(null));
  const blink = p.drainEvents();
  ok("two lost owner frames stay inside the bounded tracking grace", p.state.pinched);
  ok(
    "a brief tracking blink emits neither cancel nor release",
    !blink.some((event) => event.type === "cancel" || event.type === "release"),
  );
  run(p, clock, 100, () => frame(hand(0.5, 0.7, 0.3)));
  ok(
    "the same closed owner resumes without a duplicate press",
    p.state.pinched && !p.drainEvents().some((event) => event.type === "press"),
  );
  run(p, clock, 400, () => frame(hand(0.5, 0.7, 1.44)));
  ok(
    "opening after the recovered blink emits exactly one release",
    p.drainEvents().filter((event) => event.type === "release").length === 1,
  );

  const expired = fresh({ clickGesture: "pinch" });
  run(expired.p, expired.clock, 500, () => frame(hand(0.5, 0.7)));
  run(expired.p, expired.clock, 600, () => frame(hand(0.5, 0.7, 0.3)));
  expired.p.drainEvents();
  run(expired.p, expired.clock, 500, () => frame(null));
  const lost = expired.p.drainEvents();
  ok("tracking loss beyond the bounded grace cancels the held gesture", !expired.p.state.pinched);
  ok(
    "sustained loss is a cancel, never a successful release",
    lost.some((event) => event.type === "cancel" && event.reason === "hand-lost") &&
      !lost.some((event) => event.type === "release"),
  );
}

{
  console.log("\nthe click can never stick down");
  const { p, clock } = fresh({ clickGesture: "pinch" });

  ok("dwell is off by default — resting must not select", DEFAULT_POINTER.dwellMs === 0);

  // A hand whose open posture reads BELOW the seeded threshold. This is the failure that got
  // shipped: the reference is judged too high, so an open hand is read as pinched from the
  // first frame, and releasing needs a ratio it can never produce. The click sticks down —
  // and with it, taps (they fire on release) and dwell (it requires no pinch).
  const s = run(p, clock, 900, () => frame(hand(0.5, 0.7, 0.8)));
  ok("an unusual open hand is not mistaken for a held pinch", !s.pinched, `ratio 0.8`);

  // A continuous scene grab/scroll may legitimately last seconds. The watchdog is only a
  // backstop for a genuinely stuck classifier and cancellation is not a successful release.
  const { p: p2, clock: c2 } = fresh({ clickGesture: "pinch" });
  run(p2, c2, 600, () => frame(hand(0.5, 0.7)));
  run(p2, c2, 800, () => frame(hand(0.5, 0.7, 0.3)));
  ok("a real pinch is held while it lasts", p2.state.pinched);
  run(p2, c2, 3500, () => frame(hand(0.5, 0.7, 0.3)));
  ok("a several-second scene grab is not cut off", p2.state.pinched);
  run(p2, c2, 28_000, () => frame(hand(0.5, 0.7, 0.3)));
  const timeout = p2.drainEvents();
  ok("the stuck-classifier watchdog eventually cancels", !p2.state.pinched);
  ok(
    "the watchdog is a cancel, never a release",
    timeout.some((event) => event.type === "cancel" && event.reason === "hold-timeout") &&
      !timeout.some((event) => event.type === "release"),
  );
}

{
  console.log("\nnoise is not a click, and it must not kill dwell");
  const { p, clock } = fresh({
    clickGesture: "pinch",
    dwellMs: 600,
    dwellRadius: 0.04,
  });
  run(p, clock, 500, () => frame(hand(0.5, 0.7)));

  // A hand held open and still, with the ratio flickering the way a real tracked hand does.
  // None of this is a gesture — a one- or two-frame dip is the sensor, not a decision — and
  // the visitor is simply resting on a button waiting for it to select.
  let presses = 0;
  let dwells = 0;
  const jitter = [1.44, 1.4, 0.7, 1.42, 1.44, 0.65, 1.41, 1.45, 1.43, 0.8, 1.44];
  for (let i = 0; i < 44; i += 1) {
    clock.t += STEP;
    const st = p.update(frame(hand(0.5, 0.7, jitter[i % jitter.length]!)), ASPECT, clock.t);
    if (st.pressed) presses += 1;
    if (st.dwellFired) dwells += 1;
  }
  ok("flicker in the pinch signal produces no clicks", presses === 0, `${presses} presses`);
  // Each false press used to reset the dwell timer AND disarm it, so resting never selected.
  ok("...and resting on a button still selects", dwells === 1, `fired ${dwells}`);

  // A real, held gesture still gets through — the debounce must filter noise, not intent.
  const { p: p2, clock: c2 } = fresh({ clickGesture: "pinch" });
  run(p2, c2, 500, () => frame(hand(0.5, 0.7)));
  const real = countPresses(p2, c2, 900, () => frame(hand(0.5, 0.7, 0.3)));
  ok("a deliberate, held pinch still clicks", real === 1, `${real} presses`);
}

{
  console.log("\ndwell");
  const { p, clock } = fresh({ dwellMs: 500, dwellRadius: 0.03 });
  run(p, clock, 500, () => frame(hand(0.5, 0.7)));

  // A cursor being moved must never accumulate dwell.
  let fired = 0;
  for (let i = 0; i < 30; i += 1) {
    clock.t += STEP;
    const s = p.update(frame(hand(0.45 + i * 0.004, 0.7)), ASPECT, clock.t);
    if (s.dwellFired) fired += 1;
  }
  ok("a moving hand never dwells", fired === 0);

  fired = countDwells(p, clock, 1200, () => frame(hand(0.5, 0.7)));
  ok("a still hand dwells exactly once", fired === 1, `fired ${fired}`);

  fired = countDwells(p, clock, 2000, () => frame(hand(0.5, 0.7)));
  ok("and does not repeat while it stays put", fired === 0, `fired ${fired}`);

  // Moving away and back re-arms it — otherwise a visitor could only ever dwell once.
  run(p, clock, 400, () => frame(hand(0.2, 0.7)));
  fired = countDwells(p, clock, 1200, () => frame(hand(0.2, 0.7)));
  ok("moving elsewhere re-arms it", fired === 1, `fired ${fired}`);
}

{
  console.log("\ndwell crosses camera/display clocks exactly once");
  const { p, clock } = fresh({
    clickGesture: "fist",
    dwellMs: 500,
    dwellRadius: 0.03,
    enterMs: 0,
  });
  let delivered = 0;
  let pulseFrames = 0;
  // 15fps camera, 120Hz display: every camera state is observed eight times. The durable
  // queue must yield one event total, while the legacy diagnostic pulse remains true for all
  // eight reads of its camera sample.
  for (let cameraFrame = 0; cameraFrame < 18; cameraFrame += 1) {
    clock.t += 1000 / 15;
    const state = p.update(frame(hand(0.5, 0.7)), ASPECT, clock.t);
    for (let displayFrame = 0; displayFrame < 8; displayFrame += 1) {
      if (state.dwellFired) pulseFrames += 1;
      delivered += p.drainDwellEvents().length;
    }
  }
  ok("one low-rate dwell produces one high-rate activation", delivered === 1, `${delivered}`);
  ok("the fixture really reread the firing sample", pulseFrames >= 8, `${pulseFrames} reads`);

  // Conversely, a display that skips the exact firing sample still receives the queued event.
  const late = fresh({ clickGesture: "fist", dwellMs: 500, dwellRadius: 0.03, enterMs: 0 });
  run(late.p, late.clock, 900, () => frame(hand(0.5, 0.7)));
  late.clock.t += STEP;
  late.p.update(frame(hand(0.5, 0.7)), ASPECT, late.clock.t);
  ok("a display arriving after the pulse does not miss dwell", late.p.drainDwellEvents().length === 1);

  const conflict = fresh({
    clickGesture: "fist",
    dwellMs: 500,
    dwellRadius: 0.03,
    enterMs: 0,
  });
  run(conflict.p, conflict.clock, 430, () => frame(hand(0.5, 0.7)));
  run(conflict.p, conflict.clock, 500, () => frame(hand(0.5, 0.7, 0.35, "Closed_Fist")));
  ok(
    "closing a gesture cannot also complete an almost-ready dwell",
    conflict.p.drainDwellEvents().length === 0,
  );
}

{
  console.log("\nthe face may be covered — by the pointing hand, constantly");
  const { p, clock } = fresh({ clickGesture: "pinch" });
  run(p, clock, 600, () => frame(hand(0.5, 0.7)));
  const boxBefore = p.state.box;
  ok("a box exists while the face is visible", !!boxBefore);

  const s = run(p, clock, 900, () => frame(hand(0.55, 0.7), null));
  ok("the box survives the face being covered", !!s.box);
  ok("...and says it is coasting", s.faceHeld);
  ok("the cursor keeps tracking through it", Number.isFinite(s.x) && s.present);

  const beforeExpiry = s.liveX;
  const s2 = run(p, clock, 2500, () => frame(hand(0.55, 0.7), null));
  ok("the same owner keeps its last body anchor past the generic hold", s2.faceHeld);
  ok(
    "crossing the old two-second boundary cannot move a still cursor",
    Math.abs(s2.liveX - beforeExpiry) < 0.01,
    `${beforeExpiry.toFixed(4)} → ${s2.liveX.toFixed(4)}`,
  );
  ok("...and the visitor is still being tracked", s2.present);
}

{
  console.log("\na press keeps the aim it was made with");
  const { p, clock } = fresh({ clickGesture: "pinch" });
  run(p, clock, 600, () => frame(hand(0.35, 0.7)));
  const aimed = p.state.x;

  // The hand drifts while the pinch closes — the disturbance the lookback exists to undo.
  let t = 0;
  let pressedAt = -1;
  for (let i = 0; i < 30; i += 1) {
    clock.t += STEP;
    t += STEP;
    const closing = 1.44 - Math.min(1, i / 11) * 1.2; // closes over ~400ms, then stays closed
    const drifted = 0.35 + Math.min(1, i / 11) * 0.12; // and slides a long way while doing it
    const st = p.update(frame(hand(drifted, 0.7, closing)), ASPECT, clock.t);
    if (st.pressed) pressedAt = st.x;
  }
  ok("the press fired", pressedAt >= 0, `t=${t}`);
  // Mirrored, so drifting to a larger frame x moves the cursor to a SMALLER screen x.
  ok(
    "the frozen position is closer to the aim than to where the hand ended up",
    pressedAt >= 0 && Math.abs(pressedAt - aimed) < 0.5,
    `aimed ${aimed.toFixed(3)}, froze ${pressedAt.toFixed(3)}`,
  );
}

{
  console.log("\na tap survives the hand wobbling as it pinches");
  const { p, clock } = fresh({ clickGesture: "pinch" });
  run(p, clock, 600, () => frame(hand(0.35, 0.7)));

  // The aim is pinned while the press lands; the hand carries on moving. Both facts are
  // needed and they are different numbers — measuring the drag against the pinned aim counts
  // the pinning itself as travel, and every tap gets thrown away as a drag instead of firing.
  let sawPress = false;
  let aimDuringFreeze = -1;
  let liveDuringFreeze = -1;
  // Long enough for the press debounce to elapse after the fingers close — a gesture is not
  // a click until it has been held, so a test that only closes has not clicked yet.
  for (let i = 0; i < 26; i += 1) {
    clock.t += STEP;
    const closing = 1.44 - Math.min(1, i / 9) * 1.2;
    const drifted = 0.35 + Math.min(1, i / 9) * 0.1;
    const st = p.update(frame(hand(drifted, 0.7, closing)), ASPECT, clock.t);
    if (st.pressed) sawPress = true;
    if (sawPress && aimDuringFreeze < 0) {
      aimDuringFreeze = st.x;
      liveDuringFreeze = st.liveX;
    }
  }
  ok("the press fired", sawPress);
  ok(
    "the aim is pinned while the live position is not",
    Math.abs(aimDuringFreeze - liveDuringFreeze) > 0.001,
    `aim ${aimDuringFreeze.toFixed(3)} live ${liveDuringFreeze.toFixed(3)}`,
  );

  // ...and the fingers opening must still produce a release, or the tap never lands at all.
  let released = false;
  for (let i = 0; i < 30; i += 1) {
    clock.t += STEP;
    const st = p.update(frame(hand(0.45, 0.7, 1.44)), ASPECT, clock.t);
    if (st.released) released = true;
  }
  ok("opening the fingers releases, so the tap can land", released);
  ok("and it is not blamed on losing the hand", !p.state.releasedByLoss);
}

{
  console.log("\na face smaller than the hand is not the visitor's face");
  const { p, clock } = fresh();
  // A hand at the usual distance (palm 0.06 of the frame), and a "face" a sixth as wide, off
  // in a corner — a photo on the wall behind. Scaling the box from it would be a 3cm box.
  const poster = { cx: 0.15, cy: 0.15, w: 0.01, h: 0.013, score: 0.9 };
  const s1 = run(p, clock, 800, () => frame(hand(0.5, 0.7), poster));
  ok("the poster is not used as the ruler", s1.conf.reason === "no-face", s1.conf.reason);
  ok("...and the box is the hand's own size instead", !!s1.box && s1.box.w > 0.15, String(s1.box?.w));
  // The same hand, 2cm to one side: the cursor moves a little, not half a screen.
  const s2 = run(p, clock, 800, () => frame(hand(0.5 - 0.015, 0.7), poster));
  ok("a small move is a small move", Math.abs(s2.x - s1.x) < 0.15, `${(s2.x - s1.x).toFixed(3)}`);
  // A real face beside the hand is still the ruler.
  const s3 = run(p, clock, 800, () => frame(hand(0.5, 0.7), face()));
  ok("a real face is still trusted", s3.conf.reason === "ok", s3.conf.reason);
}

{
  console.log("\nthe reach knob makes the screen cheaper without remeasuring");
  const a = fresh();
  const b = fresh({ reachScale: 0.5 });
  // The same hand, the same small offset from the box centre — twice the cursor travel.
  const x = 0.5 - 0.02;
  const sa = run(a.p, a.clock, 1500, () => frame(hand(x, 0.7)));
  const sb = run(b.p, b.clock, 1500, () => frame(hand(x, 0.7)));
  ok("half the box is twice the travel",
    near(sb.x - 0.5, (sa.x - 0.5) * 2, 0.02), `${(sa.x - 0.5).toFixed(3)} → ${(sb.x - 0.5).toFixed(3)}`);
  ok("...about the same centre", sa.x > 0.5 && sb.x > 0.5);
  ok(
    "scene coordinates stay raw when UI reach scaling changes",
    sa.rawHand?.frameX === x && sb.rawHand?.frameX === x,
    `${sa.rawHand?.frameX} / ${sb.rawHand?.frameX}`,
  );

  const outside = run(a.p, a.clock, 1200, () => frame(hand(0.98, 0.7)));
  ok(
    "raw scene coordinates are not clamped with the screen cursor",
    outside.rawHand?.frameX === 0.98 && outside.liveX === 0,
    `raw ${outside.rawHand?.frameX}, cursor ${outside.liveX}`,
  );
}

{
  console.log("\nscene input is camera-aspect invariant");
  const physicalY = 0.3;
  ok(
    "the same physical vertical coordinate matches at 4:3 and 16:9",
    near(frameYInXUnits(physicalY * (4 / 3), 4 / 3), physicalY, 1e-9) &&
      near(frameYInXUnits(physicalY * (16 / 9), 16 / 9), physicalY, 1e-9),
  );

  const tiltedPalm = (aspect: number) => {
    const h = hand(0.5, 0.5);
    h.landmarks[5] = { x: 0.47, y: 0.5 - 0.02 * aspect, z: 0 };
    h.landmarks[17] = { x: 0.53, y: 0.5 + 0.02 * aspect, z: 0 };
    return h.landmarks;
  };
  const palm43 = palmWidthNorm(tiltedPalm(4 / 3), 4 / 3);
  const palm169 = palmWidthNorm(tiltedPalm(16 / 9), 16 / 9);
  ok(
    "a tilted palm has the same physical ruler at 4:3 and 16:9",
    near(palm43, palm169, 1e-9) && near(palm43, Math.hypot(0.06, 0.04), 1e-9),
    `${palm43.toFixed(6)} / ${palm169.toFixed(6)}`,
  );

  const p43 = new HandPointer({ ...DEFAULT_POINTER, enterMs: 0 });
  const p169 = new HandPointer({ ...DEFAULT_POINTER, enterMs: 0 });
  const raw43 = p43.update(frame(hand(0.5, physicalY * (4 / 3)), null), 4 / 3, 1_000);
  const raw169 = p169.update(frame(hand(0.5, physicalY * (16 / 9)), null), 16 / 9, 1_000);
  ok(
    "the pointer publishes equal raw scene y on both camera shapes",
    !!raw43.rawHand &&
      !!raw169.rawHand &&
      near(raw43.rawHand.frameY, raw169.rawHand.frameY, 1e-9),
    `${raw43.rawHand?.frameY.toFixed(6)} / ${raw169.rawHand?.frameY.toFixed(6)}`,
  );
}

{
  console.log("\na profile mapping change is an interaction boundary");
  const { p, clock } = fresh({ clickGesture: "fist" });
  run(p, clock, 900, () => frame(hand(0.46, 0.7)));
  p.drainEvents();
  const remappedBox = {
    ...DEFAULT_POINTER.box,
    widthFaces: DEFAULT_POINTER.box.widthFaces * 0.8,
  };
  p.configure({ box: remappedBox });
  const boundary = p.drainEvents();
  ok(
    "changing a live mapping emits a cancellation boundary",
    boundary.some((event) => event.type === "cancel" && event.reason === "mapping-changed"),
  );

  clock.t += STEP;
  const remapped = p.update(frame(hand(0.46, 0.7)), ASPECT, clock.t);
  const reference = fresh({ box: remappedBox, clickGesture: "fist", enterMs: 0 });
  reference.clock.t = clock.t - STEP;
  reference.clock.t += STEP;
  const expected = reference.p.update(frame(hand(0.46, 0.7)), ASPECT, reference.clock.t);
  ok(
    "the first new-profile sample starts in its own coordinate system without gliding",
    near(remapped.liveX, expected.liveX, 1e-6) && near(remapped.liveY, expected.liveY, 1e-6),
    `${remapped.liveX.toFixed(5)},${remapped.liveY.toFixed(5)} / ${expected.liveX.toFixed(5)},${expected.liveY.toFixed(5)}`,
  );
}

{
  console.log("\na held fist on a still hand is a still cursor");
  const { p, clock } = fresh({ clickGesture: "fist" });
  run(p, clock, 600, () => frame(hand(0.5, 0.7)));
  // Close the fist and hold it for a second and a half, with the landmark shiver a closed
  // hand actually produces: a few thousandths of the frame, every frame, in a random direction.
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5) * 2;
  let minX = Infinity;
  let maxX = -Infinity;
  let armMin = Infinity;
  let armMax = -Infinity;
  let pressed = false;
  for (let i = 0; i < 45; i += 1) {
    clock.t += STEP;
    const st = p.update(
      frame(hand(0.5 + rnd() * 0.006, 0.7 + rnd() * 0.006, 1.44, "Closed_Fist", 0.9)),
      ASPECT,
      clock.t,
    );
    if (st.pressed) pressed = true;
    if (st.rawHeld && !pressed) {
      // the 350ms between the hand closing and the press counting — where Enter shivered
      armMin = Math.min(armMin, st.x);
      armMax = Math.max(armMax, st.x);
    }
    if (pressed && clock.t > 900) {
      // well past the 180ms timed freeze — this is the part that used to shiver
      minX = Math.min(minX, st.x);
      maxX = Math.max(maxX, st.x);
    }
  }
  ok("the fist pressed", pressed);
  ok("the cursor was already pinned while the press was still arming", armMax - armMin === 0,
    `wandered ${((armMax - armMin) * 3840).toFixed(1)} px at 4K`);
  ok("the cursor did not move at all while it was held", maxX - minX === 0,
    `wandered ${((maxX - minX) * 3840).toFixed(1)} px at 4K`);
  // ...but a real drag is not a wobble: move the hand a long way and the cursor must follow.
  let followed = false;
  for (let i = 0; i < 20; i += 1) {
    clock.t += STEP;
    const st = p.update(frame(hand(0.5 - i * 0.01, 0.7, 1.44, "Closed_Fist", 0.9)), ASPECT, clock.t);
    if (Math.abs(st.x - st.liveX) < 0.02 && i > 10) followed = true;
  }
  ok("once the hand has genuinely moved, the cursor follows again", followed);
}

{
  console.log("\none visitor's cursor never becomes the next one's");
  const { p, clock } = fresh();
  run(p, clock, 600, () => frame(hand(0.66, 0.7)));
  const first = p.state.x;
  run(p, clock, 2000, () => frame(null, null));
  ok("the first visitor is gone", !p.state.present);

  // A different person, standing elsewhere, hand on the other side.
  const s = run(p, clock, 400, () => frame(hand(0.34, 0.7), face(0.5, 0.35)));
  ok(
    "the new cursor does not glide in from the old position",
    Math.abs(s.x - first) > 0.1,
    `old ${first.toFixed(3)}, new ${s.x.toFixed(3)}`,
  );

  const short = fresh();
  run(short.p, short.clock, 600, () => frame(hand(0.66, 0.7), face(0.65, 0.34)));
  const shortFirst = short.p.state.liveX;
  // Longer than the identity reservation but shorter than the old 1.2s presence grace: this
  // was the gap in which a new visitor could inherit the old filter and face anchor.
  run(short.p, short.clock, 330, () => frame(null, null));
  ok("owner expiry immediately closes the old identity epoch", !short.p.state.present);
  short.clock.t += STEP;
  const shortNext = short.p.update(
    frame(hand(0.34, 0.7), face(0.35, 0.34)),
    ASPECT,
    short.clock.t,
  );
  ok(
    "a new owner after a short gap starts from its own cursor and face",
    Math.abs(shortNext.liveX - shortFirst) > 0.08 && shortNext.face?.cx === 0.35,
    `old ${shortFirst.toFixed(3)}, new ${shortNext.liveX.toFixed(3)}, face ${shortNext.face?.cx}`,
  );
}

{
  console.log("\nthe fist path (for when a pinch cannot be seen)");
  const { p, clock } = fresh({ clickGesture: "fist" });
  run(p, clock, 600, () => frame(hand(0.5, 0.7)));
  ok("an open hand is not a click", !p.state.pinched);

  clock.t += STEP;
  const closing = p.update(
    frame(hand(0.5, 0.7, 1.44, "Closed_Fist", 0.9)),
    ASPECT,
    clock.t,
  );
  ok(
    "direct fist evidence publishes closed while the temporal latch is still arming",
    closing.posture === "closed" && !closing.pinched,
  );
  const n = countPresses(p, clock, 700, () => frame(hand(0.5, 0.7, 1.44, "Closed_Fist", 0.9)));
  ok("a fist emits one confirmed press edge", n === 1, `fired ${n}`);

  // Release hysteresis belongs to the fist latch. Neither the classifier nor the image-space
  // finger geometry is trustworthy enough for one frame to end an owned interaction.
  p.drainEvents();
  clock.t += STEP;
  p.update(frame(hand(0.5, 0.7, 1.44, "Open_Palm", 0.95)), ASPECT, clock.t);
  ok(
    "one Open_Palm glitch does not release a held fist",
    p.state.pinched && !p.drainEvents().some((event) => event.type === "release"),
  );
  clock.t += STEP;
  p.update(frame(hand(0.5, 0.7, 1.44, "Closed_Fist", 0.95)), ASPECT, clock.t);
  clock.t += STEP;
  p.update(frame(curledHand(0.5, 0.7, false)), ASPECT, clock.t);
  ok(
    "one three-finger/open-geometry glitch does not release a held fist",
    p.state.pinched && !p.drainEvents().some((event) => event.type === "release"),
  );
  const duplicate = countPresses(
    p,
    clock,
    300,
    () => frame(hand(0.5, 0.7, 1.44, "Closed_Fist", 0.95)),
  );
  ok("returning to the same held fist cannot create a second press", duplicate === 0);

  run(p, clock, 400, () => frame(hand(0.5, 0.7, 1.44, "Open_Palm", 0.9)));
  ok("opening releases it", !p.state.pinched);
  ok("a low-confidence label is ignored", !runFist(p, clock, 0.2));
  // The wall's most common complaint: the hand is closed and held, and the classifier hedges
  // at "None" for the whole hold. The geometry of a closed hand has to count on its own.
  run(p, clock, 400, () => frame(hand(0.5, 0.7, 1.44, "Open_Palm", 0.9)));
  const g = countPresses(p, clock, 700, () => frame(curledHand(0.5, 0.7, true)));
  ok("a fist the classifier missed still clicks, from its geometry", g === 1, `fired ${g}`);
  run(p, clock, 400, () => frame(curledHand(0.5, 0.7, false)));
  ok("straightening the fingers releases it", !p.state.pinched);
  ok("an open hand with a 'None' label is still not a fist", !countPresses(p, clock, 500, () => frame(curledHand(0.5, 0.7, false))));
}

{
  console.log("\nfist release accepts a sustained neutral hand");
  const { p, clock } = fresh({ clickGesture: "fist" });
  run(p, clock, 400, () => frame(hand(0.5, 0.7, 1.44, "Open_Palm", 0.95)));
  const first = countPresses(
    p,
    clock,
    700,
    () => frame(hand(0.5, 0.7, 0.35, "Closed_Fist", 0.95)),
  );
  ok("the first fist begins one click epoch", first === 1, `fired ${first}`);
  p.drainEvents();

  // A typical relaxed hand is labelled None. It has a wide thumb/index aperture but may not
  // have enough confidently extended fingers to satisfy Open_Palm geometry. It must be held
  // long enough to pass both the fist latch's off grace and the neutral release gate.
  run(p, clock, 150, () => frame(hand(0.5, 0.7, 1.44, "None", 0.9)));
  ok(
    "a brief neutral-classifier gap cannot release the fist",
    p.state.pinched && !p.drainEvents().some((event) => event.type === "release"),
  );
  run(p, clock, 300, () => frame(hand(0.5, 0.7, 1.44, "None", 0.9)));
  const neutralRelease = p.drainEvents().filter((event) => event.type === "release");
  ok(
    "a sustained relaxed hand ends the accepted fist",
    !p.state.pinched && p.state.posture === "open" && neutralRelease.length === 1,
  );

  const second = countPresses(
    p,
    clock,
    700,
    () => frame(hand(0.5, 0.7, 0.35, "Closed_Fist", 0.95)),
  );
  ok("the next fist can produce a new click", second === 1, `fired ${second}`);
}

{
  console.log("\na partly relaxed fist can release without becoming a textbook open palm");
  const { p, clock } = fresh({ clickGesture: "fist" });
  run(p, clock, 400, () => frame(curledHand(0.5, 0.7, false)));
  const first = countPresses(p, clock, 700, () => frame(curledHand(0.5, 0.7, true)));
  ok("the geometry fist begins one click epoch", first === 1 && p.state.pinched, `fired ${first}`);
  p.drainEvents();

  const halfway = partlyRelaxedFist(0.5, 0.7);
  ok(
    "the release fixture deliberately remains below the old geometry threshold",
    halfway.label === "None",
  );
  run(p, clock, 450, () => frame(partlyRelaxedFist(0.5, 0.7)));
  const released = p.drainEvents().filter((event) => event.type === "release");
  ok(
    "sustained relative finger uncurl ends the fist exactly once",
    !p.state.pinched && released.length === 1,
    `pinched=${p.state.pinched} releases=${released.length}`,
  );
}

{
  console.log("\nrelative fist release remains hysteretic and conservative");
  const aperture = fresh({ clickGesture: "fist" });
  run(
    aperture.p,
    aperture.clock,
    400,
    () => frame(hand(0.5, 0.7, 1.44, "Open_Palm", 0.95)),
  );
  countPresses(
    aperture.p,
    aperture.clock,
    700,
    () => frame(hand(0.5, 0.7, 0.35, "Closed_Fist", 0.95)),
  );
  aperture.p.drainEvents();
  run(aperture.p, aperture.clock, 450, () => frame(hand(0.5, 0.7, 0.65, "None", 0.2)));
  ok(
    "relative aperture relaxation releases below the old absolute 0.88 gate",
    !aperture.p.state.pinched &&
      aperture.p.drainEvents().filter((event) => event.type === "release").length === 1,
  );

  const spike = fresh({ clickGesture: "fist" });
  run(spike.p, spike.clock, 400, () => frame(curledHand(0.5, 0.7, false)));
  countPresses(spike.p, spike.clock, 700, () => frame(curledHand(0.5, 0.7, true)));
  spike.p.drainEvents();
  run(spike.p, spike.clock, 66, () => frame(partlyRelaxedFist(0.5, 0.7)));
  run(spike.p, spike.clock, 300, () => frame(curledHand(0.5, 0.7, true)));
  ok(
    "a one-to-two-frame uncurl spike cannot release or duplicate the geometry fist",
    spike.p.state.pinched &&
      !spike.p.drainEvents().some((event) => event.type === "release" || event.type === "press"),
  );

  run(
    spike.p,
    spike.clock,
    450,
    () => {
      const h = partlyRelaxedFist(0.5, 0.7);
      h.label = "Closed_Fist";
      h.score = 0.95;
      return frame(h);
    },
  );
  ok(
    "a confident Closed_Fist label vetoes relative relaxation",
    spike.p.state.pinched && !spike.p.drainEvents().some((event) => event.type === "release"),
  );

  const hedged = fresh({ clickGesture: "fist" });
  run(hedged.p, hedged.clock, 400, () => frame(curledHand(0.5, 0.7, false)));
  countPresses(hedged.p, hedged.clock, 700, () => frame(curledHand(0.5, 0.7, true)));
  hedged.p.drainEvents();
  run(hedged.p, hedged.clock, 500, () => {
    const h = curledHand(0.5, 0.7, false);
    h.label = "Closed_Fist";
    h.score = 0.41;
    return frame(h);
  });
  ok(
    "a threshold-level stale fist label cannot veto sustained multi-finger opening",
    !hedged.p.state.pinched &&
      hedged.p.drainEvents().filter((event) => event.type === "release").length === 1,
  );
}

{
  const { p, clock } = fresh({ clickGesture: "fist" });
  run(p, clock, 400, () => frame(hand(0.5, 0.7, 1.44, "Open_Palm", 0.95)));
  countPresses(
    p,
    clock,
    700,
    () => frame(hand(0.5, 0.7, 0.35, "Closed_Fist", 0.95)),
  );
  p.drainEvents();

  // If the fist classifier and geometry both temporarily hedge to None while the aperture is
  // still closed, this is not a release and must never manufacture a second click on recovery.
  run(p, clock, 500, () => frame(hand(0.5, 0.7, 0.35, "None", 0.3)));
  ok(
    "a closed-aperture classifier dropout keeps the click epoch held",
    p.state.pinched && !p.drainEvents().some((event) => event.type === "release"),
  );
  const duplicate = countPresses(
    p,
    clock,
    700,
    () => frame(hand(0.5, 0.7, 0.35, "Closed_Fist", 0.95)),
  );
  ok("classifier recovery cannot repeat the held fist", duplicate === 0, `fired ${duplicate}`);
}

{
  console.log("\nnothing produces a NaN cursor");
  const { p, clock } = fresh();
  const junk: VisionResult = {
    hand: null,
    hands: [
      {
        label: "None",
        score: Number.NaN,
        cx: Number.NaN,
        cy: Number.NaN,
        landmarks: [],
        world: [],
        handedness: "",
      },
    ],
    face: { cx: Number.NaN, cy: Number.NaN, w: 0, h: 0, score: 0 },
  };
  for (let i = 0; i < 30; i += 1) {
    clock.t += STEP;
    p.update(junk, ASPECT, clock.t);
  }
  const s = p.state;
  ok(
    "a malformed frame leaves the cursor finite and on screen",
    Number.isFinite(s.x) && Number.isFinite(s.y) && s.x >= 0 && s.x <= 1 && s.y >= 0 && s.y <= 1,
    `x=${s.x} y=${s.y}`,
  );
  ok("and claims no presence", !s.present);
}

{
  console.log("\nthe mapping points the right way");
  const { p, clock } = fresh();
  run(p, clock, 800, () => frame(hand(0.5, 0.7)));
  const box = p.state.box!;
  const left = run(p, clock, 800, () => frame(hand(box.x0 + 0.001, (box.y0 + box.y1) / 2)));
  ok("a hand at the LEFT of frame puts the cursor at the RIGHT of screen", left.x > 0.8, `x=${left.x.toFixed(2)}`);
  const right = run(p, clock, 800, () => frame(hand(box.x1 - 0.001, (box.y0 + box.y1) / 2)));
  ok("...and vice versa", right.x < 0.2, `x=${right.x.toFixed(2)}`);
  const top = run(p, clock, 800, () => frame(hand((box.x0 + box.x1) / 2, box.y0 + 0.001)));
  ok("a hand raised puts the cursor high", top.y < 0.2, `y=${top.y.toFixed(2)}`);
  ok("the cursor never leaves the screen", near(Math.min(1, Math.max(0, top.y)), top.y, 1e-9));
}

{
  console.log("\nthe face is the ruler, never the gate");
  const { p, clock } = fresh();
  // A visitor the face detector never finds: stood to one side, backlit, or simply occluded
  // by the hand doing the pointing. Presence used to require a box, and a box required a
  // face, so this person got no cursor at all while the tour played on.
  const s = run(p, clock, 800, () => frame(hand(0.5, 0.6), null));
  ok("a hand with no face at all still becomes present", s.present);
  ok("...with a box measured from the hand itself", !!s.box);
  ok("...and a cursor that is somewhere real", Number.isFinite(s.x) && s.x >= 0 && s.x <= 1);
  ok("...flagged as the degraded mapping it is", s.conf.reason === "no-face" && s.conf.value > 0);

  // `run` hands back the pointer's state OBJECT, which is mutated in place every frame — so
  // a position has to be copied out as a number before anything else can be compared to it.
  const before = s.x;
  const after = run(p, clock, 800, () => frame(hand(0.2, 0.6), null)).x;
  ok("and it still tracks movement", Math.abs(after - before) > 0.1, `${before} → ${after}`);

  ok("no hand and no face is still nothing", !fallbackBox(Number.NaN, 16 / 9));
}

{
  console.log("\nscene intent is an owned, fresh session");
  resetSceneInput();
  setSceneAvailability("loading");
  ok(
    "scene loading is user-visible but cannot authorize a grab",
    flightInput.availability === "loading" && !flightInput.ready,
  );
  ok(
    "a scene cannot be grabbed before its real camera pose is ready",
    !beginSceneGrab({ sessionId: 1, ownerId: 7, seq: 1, freshAt: 100, freshForMs: 120 }),
  );

  setSceneAvailability("failed");
  ok(
    "scene load failure stays distinguishable from loading",
    flightInput.availability === "failed" && !flightInput.ready,
  );
  setSceneReady(true);
  ok("automatic Explore is the production default mode", flightInput.mode === "explore");
  ok(
    "a confirmed scene grab starts the session",
    beginSceneGrab({ sessionId: 1, ownerId: 7, seq: 1, freshAt: 100, freshForMs: 120 }),
  );
  ok("mere hand presence is no longer part of scene authority", flightInput.active);
  ok("a live scene session locks its mode", !setSceneMode("move") && flightInput.mode === "explore");
  ok(
    "another hand cannot update the session",
    !updateSceneGrab({
      sessionId: 1,
      ownerId: 8,
      seq: 2,
      freshAt: 133,
      freshForMs: 120,
      dx: 1,
      dy: 1,
      vx: 1,
      vy: 1,
    }),
  );
  ok(
    "a fresh sample from the owner updates relative motion",
    updateSceneGrab({
      sessionId: 1,
      ownerId: 7,
      seq: 2,
      freshAt: 133,
      freshForMs: 120,
      dx: 0.4,
      dy: -0.2,
      vx: 2,
      vy: -1,
    }),
  );
  ok("the relative values are published", flightInput.dx === 0.4 && flightInput.dy === -0.2);
  ok(
    "the same decoded frame is never integrated twice",
    !updateSceneGrab({
      sessionId: 1,
      ownerId: 7,
      seq: 2,
      freshAt: 133,
      freshForMs: 120,
      dx: 1,
      dy: 1,
      vx: 1,
      vy: 1,
    }),
  );
  ok("a foreign release cannot end it", !endSceneGrab("released", { sessionId: 1, ownerId: 8 }));
  ok("the owner's explicit release ends it", endSceneGrab("released", { sessionId: 1, ownerId: 7 }));
  ok(
    "ending clears every movement component",
    !flightInput.active &&
      flightInput.dx === 0 &&
      flightInput.dy === 0 &&
      flightInput.vx === 0 &&
      flightInput.vy === 0,
  );
  ok("the next mode may be selected while idle", setSceneMode("move") && flightInput.mode === "move");
  ok(
    "a new session id may begin",
    beginSceneGrab({ sessionId: 2, ownerId: 7, seq: 3, freshAt: 166, freshForMs: 120 }),
  );
  ok("cancellation is distinct from release", cancelSceneGrab("stale") && flightInput.endReason === "stale");
  resetSceneInput();
}

{
  console.log("\nscrolling by leaning, not by dragging");

  ok("a hand that has not moved does not scroll", dragScrollVelocity(0) === 0);
  // The deadzone now matches the drag threshold, so anything past it is a scroll by
  // definition — a lean that is neither a tap nor a scroll is the outcome nobody can read.
  ok("nor does a wobble too small to be a drag", dragScrollVelocity(0.02) === 0);
  ok("but anything past the drag threshold does scroll", dragScrollVelocity(0.04) !== 0);
  // Touch semantics: the content follows the hand. Pushing up moves the page down.
  ok("a hand held above the grab scrolls the page down", dragScrollVelocity(-0.2) > 0);
  ok("below it, the page comes back up", dragScrollVelocity(0.2) < 0);
  ok(
    "and it is symmetric",
    Math.abs(dragScrollVelocity(0.2) + dragScrollVelocity(-0.2)) < 1e-9,
  );

  const slow = dragScrollVelocity(-0.1);
  const fast = dragScrollVelocity(-0.25);
  ok("further means faster", fast > slow && slow > 0, `${slow.toFixed(0)} → ${fast.toFixed(0)}`);
  ok("but it is capped", dragScrollVelocity(-5) === dragScrollVelocity(-0.28));

  // The failure that forced this design: dragging the page by displacement means the return
  // stroke un-scrolls the outward one exactly, and with a missed release the page just
  // oscillates under the hand. Leaning has no return stroke — coming back only stops.
  ok("coming back to the middle stops rather than rewinds", dragScrollVelocity(0.01) === 0);
}

{
  console.log("\nreplayed against real recorded hands");

  // The thresholds were FITTED to this data, so this is the test that stops them drifting
  // back to something invented. Six trials from the hand lab at 0.5 m, each with a known
  // answer: the visitor performed exactly N deliberate pinches, or none at all.
  const here = dirname(fileURLToPath(import.meta.url));
  const fx = JSON.parse(readFileSync(join(here, "fixtures/pinch-trials.json"), "utf8")) as {
    trials: Array<{ kind: string; id: number; expected: number; s: Array<[number, number | null]> }>;
  };

  const replay = (samples: Array<[number, number | null]>) => {
    const det = new PinchDetector();
    let since = 0;
    let held = false;
    let presses = 0;
    for (const [t, r] of samples) {
      const on = det.update(r === null ? Number.NaN : r, t);
      if (!on) {
        since = 0;
        held = false;
        continue;
      }
      if (!since) since = t;
      if (!held && t - since >= PRESS_DEBOUNCE_MS) {
        held = true;
        presses += 1;
      }
    }
    return presses;
  };

  let falseFires = 0;
  let caught = 0;
  let wanted = 0;
  for (const t of fx.trials) {
    const got = replay(t.s);
    if (t.expected === 0) {
      falseFires += got;
      ok(`${t.kind} #${t.id}: an idle hand fires nothing`, got === 0, `${got} clicks`);
    } else {
      caught += Math.min(got, t.expected);
      wanted += t.expected;
      // Deliberately NOT asserting all of them. A sweep of every possible threshold pair
      // showed the best any of them manages is 4/10 and 7/10 — a third to a half of real
      // pinches leave no detectable trace at this distance. This asserts the fit does not
      // silently get WORSE; the shortfall itself is a hardware finding, not a bug.
      ok(
        `${t.kind} #${t.id}: catches what is there (${got}/${t.expected})`,
        got >= Math.ceil(t.expected * 0.35),
        `${got}/${t.expected}`,
      );
    }
  }
  ok("no false clicks anywhere in the idle recordings", falseFires === 0, `${falseFires}`);
  console.log(
    `    → pinch alone recovers ${caught}/${wanted} of deliberate pinches on this camera.` +
      ` The fist path exists because of this number.`,
  );
}

// ---------------------------------------------------------------------------

function countPresses(
  p: HandPointer,
  clock: { t: number },
  ms: number,
  make: (t: number) => VisionResult,
): number {
  let n = 0;
  const end = clock.t + ms;
  while (clock.t < end) {
    clock.t += STEP;
    if (p.update(make(clock.t), ASPECT, clock.t).pressed) n += 1;
  }
  return n;
}

function countDwells(
  p: HandPointer,
  clock: { t: number },
  ms: number,
  make: (t: number) => VisionResult,
): number {
  let n = 0;
  const end = clock.t + ms;
  while (clock.t < end) {
    clock.t += STEP;
    if (p.update(make(clock.t), ASPECT, clock.t).dwellFired) n += 1;
  }
  return n;
}

/**
 * A hand with a real 3D skeleton, so the geometric fist can be exercised: every finger's tip
 * either folded back inside its middle joint (`closed`) or reaching well past it. The label is
 * "None" on purpose — this is the frame the classifier gave up on.
 */
function curledHand(x: number, y: number, closed: boolean): HandResult {
  const h = hand(x, y, 1.44, "None", 0.3);
  const w = h.world;
  const screen = h.landmarks;
  w[0] = { x: 0, y: 0.08, z: 0 }; // wrist, 8cm below the hand centre
  const fingers: Array<[number, number, number, number]> = [
    [5, 6, 7, 8],
    [9, 10, 11, 12],
    [13, 14, 15, 16],
    [17, 18, 19, 20],
  ];
  fingers.forEach(([mcp, pip, dip, tip], i) => {
    const fx = (i - 1.5) * 0.02;
    w[mcp] = { x: fx, y: 0, z: 0 };
    w[pip] = { x: fx, y: -0.03, z: 0 };
    // curled: the tip comes back toward the palm, well inside the PIP's reach from the wrist
    w[dip] = closed ? { x: fx, y: -0.02, z: 0.02 } : { x: fx, y: -0.055, z: 0 };
    w[tip] = closed ? { x: fx, y: 0.0, z: 0.03 } : { x: fx, y: -0.08, z: 0 };

    // Explicit-open evidence is intentionally read from image landmarks, independently of the
    // world-space fist fallback. Keep both coordinate sets honest in this fixture.
    const sx = x + (i - 1.5) * 0.02;
    screen[mcp] = { x: sx, y: y - 0.012, z: 0 };
    screen[pip] = { x: sx, y: y - 0.035, z: 0 };
    screen[dip] = { x: sx, y: closed ? y - 0.018 : y - 0.065, z: 0 };
    screen[tip] = { x: sx, y: closed ? y - 0.004 : y - 0.1, z: 0 };
  });
  return h;
}

/**
 * A release pose that is visibly looser than the press but still defeats every old absolute
 * gate: label=None, fewer than three image-space fingers extended, and all four world-space
 * fingertips still just inside their PIP distance (`fistFromGeometry` therefore remains true).
 */
function partlyRelaxedFist(x: number, y: number): HandResult {
  const h = curledHand(x, y, true);
  const wrist = h.world[0]!;
  const fingers: Array<[number, number]> = [
    [6, 8],
    [10, 12],
    [14, 16],
    [18, 20],
  ];
  fingers.forEach(([pip, tip]) => {
    const joint = h.world[pip]!;
    h.world[tip] = {
      x: wrist.x + (joint.x - wrist.x) * 0.94,
      y: wrist.y + (joint.y - wrist.y) * 0.94,
      z: wrist.z + (joint.z - wrist.z) * 0.94,
    };
    // Keep the 2D fallback deliberately ambiguous/curled.
    const screenJoint = h.landmarks[pip]!;
    h.landmarks[tip] = {
      x: screenJoint.x,
      y: screenJoint.y + 0.012,
      z: screenJoint.z,
    };
  });
  h.label = "None";
  h.score = 0.2;
  return h;
}

function runFist(p: HandPointer, clock: { t: number }, score: number): boolean {
  return countPresses(p, clock, 300, () => frame(hand(0.5, 0.7, 1.44, "Closed_Fist", score))) > 0;
}

{
  console.log("\ntime-consistent cursor and face stabilisation");

  const replayPointer = (fps: number) => {
    const filter = new PointerStabilizer();
    const durationMs = 3_000;
    const frames = Math.round((durationMs / 1000) * fps);
    let last = { x: 0.4, y: 0.5, radius: 0 };
    const trace: Array<{ x: number; y: number }> = [];
    for (let i = 0; i <= frames; i += 1) {
      const t = (i / fps) * 1000;
      // A deliberately slow 6%-of-screen move with continuous, sub-deadband camera noise.
      const progress = Math.max(0, Math.min(1, (t - 500) / 2_500));
      const x =
        0.4 + progress * 0.06 + Math.sin((t / 1000) * Math.PI * 6) * 0.0012;
      const y = 0.5 + Math.cos((t / 1000) * Math.PI * 4) * 0.0008;
      last = filter.filter(x, y, true, t);
      if (i % (fps / 15) === 0) trace.push({ x: last.x, y: last.y });
    }
    return { last, trace };
  };

  const rates = [15, 30, 60].map(replayPointer);
  const xs = rates.map((runResult) => runResult.last.x);
  const traceSpread = Math.max(
    ...rates[0]!.trace.map((_, i) => {
      const samples = rates.map((runResult) => runResult.trace[i]!);
      return Math.max(
        Math.max(...samples.map((sample) => sample.x)) -
          Math.min(...samples.map((sample) => sample.x)),
        Math.max(...samples.map((sample) => sample.y)) -
          Math.min(...samples.map((sample) => sample.y)),
      );
    }),
  );
  ok(
    "15/30/60fps pointer trajectories stay aligned throughout",
    traceSpread < 0.0025,
    `worst spread ${traceSpread.toFixed(4)}`,
  );
  ok(
    "a slow intentional move keeps the same small lag instead of becoming noise",
    Math.max(...xs) - Math.min(...xs) < 0.0025 &&
      rates.every((runResult) =>
        runResult.last.x > 0.447 && 0.46 - runResult.last.x < 0.013
      ),
    xs.map((x) => x.toFixed(4)).join(" / "),
  );

  const still = new PointerStabilizer();
  const stillOutput: number[] = [];
  const stillInput: number[] = [];
  for (let i = 0; i <= 240; i += 1) {
    const t = i * (1000 / 60);
    // Larger than the fixed minimum radius, so this exercises the adaptive estimate rather
    // than passing merely because the shipped floor happened to cover the fixture.
    const x = 0.5 + Math.sin((t / 1000) * Math.PI * 10) * 0.004;
    const output = still.filter(x, 0.5, true, t).x;
    if (i >= 120) {
      stillInput.push(x);
      stillOutput.push(output);
    }
  }
  const span = (values: number[]) => Math.max(...values) - Math.min(...values);
  ok(
    "stationary landmark noise is suppressed spatially",
    span(stillOutput) < span(stillInput) * 0.25,
    `${span(stillInput).toFixed(4)} input → ${span(stillOutput).toFixed(4)} output`,
  );

  still.filter(0.8, 0.2, true, 4_100);
  still.reset();
  const reset = still.filter(0.25, 0.75, true, 4_200);
  ok(
    "reset starts the next owner exactly at their own position",
    reset.x === 0.25 && reset.y === 0.75,
  );

  const replayFace = (fps: number) => {
    const anchor = new FaceAnchor();
    let result = anchor.update(face(0.4, 0.3, 0.08), 0)!;
    for (let i = 1; i <= fps; i += 1) {
      const t = (i / fps) * 1000;
      result = anchor.update(face(0.4 + t * 0.0001, 0.3, 0.08), t)!;
    }
    return result.cx;
  };
  const faceXs = [15, 30, 60].map(replayFace);
  ok(
    "15/30/60fps face anchors have the same lag",
    Math.max(...faceXs) - Math.min(...faceXs) < 0.0025,
    faceXs.map((x) => x.toFixed(4)).join(" / "),
  );
}

{
  console.log("\ncalibration: production-confirmed gesture proof");
  const attempt = fresh({ clickGesture: "fist" });
  run(attempt.p, attempt.clock, 600, () =>
    frame(hand(0.5, 0.7, 1.44, "Open_Palm", 0.95)),
  );
  let proof = { confirmedClosed: false, cycles: 0 };
  const observe = (state: ReturnType<HandPointer["update"]>) => {
    proof = advanceGestureProof(proof, state.pinched, state.posture);
  };
  // Long enough for the provisional fist latch, deliberately shorter than production's 350ms
  // press debounce. Setup used to credit this even though the kiosk could never click it.
  const shortEnd = attempt.clock.t + 200;
  let sawRawOnly = false;
  while (attempt.clock.t < shortEnd) {
    attempt.clock.t += STEP;
    const state = attempt.p.update(
      frame(hand(0.5, 0.7, 1.44, "Closed_Fist", 0.95)),
      ASPECT,
      attempt.clock.t,
    );
    sawRawOnly ||= state.rawHeld && !state.pinched;
    observe(state);
  }
  run(attempt.p, attempt.clock, 250, () => {
    const result = frame(hand(0.5, 0.7, 1.44, "Open_Palm", 0.95));
    return result;
  });
  observe(attempt.p.state);
  ok("a short raw fist pulse is visible to diagnostics", sawRawOnly);
  ok("a short raw fist pulse cannot pass calibration", proof.cycles === 0);

  const confirmedEnd = attempt.clock.t + PRESS_DEBOUNCE_MS + 200;
  while (attempt.clock.t < confirmedEnd) {
    attempt.clock.t += STEP;
    observe(
      attempt.p.update(
        frame(hand(0.5, 0.7, 1.44, "Closed_Fist", 0.95)),
        ASPECT,
        attempt.clock.t,
      ),
    );
  }
  const releaseEnd = attempt.clock.t + 250;
  while (attempt.clock.t < releaseEnd) {
    attempt.clock.t += STEP;
    observe(
      attempt.p.update(
        frame(hand(0.5, 0.7, 1.44, "Open_Palm", 0.95)),
        ASPECT,
        attempt.clock.t,
      ),
    );
  }
  ok("a production-confirmed close followed by explicit open passes once", proof.cycles === 1);
}

{
  console.log("\ncalibration: broad validation zones");
  ok("the broad center region validates", validationZone(0.62, 0.62) === "center");
  ok(
    "left and right validate without requiring corners",
    validationZone(0.1, 0.55) === "left" && validationZone(0.9, 0.45) === "right",
  );
  ok(
    "up and down validate without requiring corners",
    validationZone(0.45, 0.1) === "up" && validationZone(0.55, 0.9) === "down",
  );
  ok("a diagonal corner is deliberately not a target", validationZone(0.05, 0.05) === null);
  ok("overlap near the left/up boundary matches no direction", validationZone(0.2, 0.2) === null);
  ok(
    "the same diagonal point cannot advance a second direction",
    validationZone(0.2, 0.2, ["left"]) === null,
  );
  ok(
    "a completed region cannot be counted twice",
    validationZone(0.5, 0.5, ["center"]) === null,
  );
}

{
  console.log("\ncalibration: the reach fit");

  /**
   * A synthetic sweep. `reach` is how far the hand goes in face widths; `frameClip` optionally
   * cuts the recording at a frame edge, which is what really happens — the camera stops
   * returning a hand, so those frames are never recorded at all.
   */
  const sweep = (opts: {
    reach: number;
    faceW?: number;
    faceCy?: number;
    drop?: number;
    shift?: number;
    n?: number;
    clipBottomAt?: number;
  }): ReachSample[] => {
    const faceW = opts.faceW ?? 0.1;
    const faceCy = opts.faceCy ?? 0.35;
    const drop = opts.drop ?? 2.6;
    const shift = opts.shift ?? 0;
    const out: ReachSample[] = [];
    const n = opts.n ?? 300;
    for (let i = 0; i < n; i += 1) {
      const a = (i / n) * Math.PI * 2;
      // an ellipse in face-width units around the chest point
      const u = shift + Math.cos(a) * opts.reach;
      const v = drop * ASPECT + Math.sin(a) * opts.reach * 0.66;
      const x = 0.5 + u * faceW;
      const y = faceCy + v * faceW;
      if (opts.clipBottomAt !== undefined && y > opts.clipBottomAt) continue; // hand left the shot
      out.push({ u, v, x, y, faceW });
    }
    return out;
  };

  {
    // Far enough back that a full sweep genuinely fits in shot — the case the shipped default
    // was written for, and the only one where it is right.
    const fit = fitReach(sweep({ reach: 2.2, faceW: 0.075, faceCy: 0.3 }), ASPECT);
    ok("a clean sweep produces a box", !!fit);
    ok("...whose width is the reach it saw", !!fit && near(fit.box.widthFaces, 4.4, 0.25),
      String(fit?.box.widthFaces));
    ok("...and which nothing had to clip", !!fit && !Object.values(fit.clippedBy).some(Boolean),
      JSON.stringify(fit?.clippedBy));
    ok("...and which is a box we would ship", !!fit && isUsableBox(fit.box));
  }

  {
    // The real failure, reproduced: standing close, the sweep runs off the bottom of the frame.
    // Those frames do not exist, so a naive fit would still hand the screen's bottom edge to the
    // last row of pixels the camera managed to see.
    const clipped = sweep({ reach: 2.2, faceW: 0.16, faceCy: 0.22, drop: 2.0, clipBottomAt: 0.98 });
    const fit = fitReach(clipped, ASPECT);
    ok("a sweep cut off by the frame still fits", !!fit);
    ok("...and says the CAMERA was the limit, not the arm", fit?.clippedBy.bottom === true);
    if (fit) {
      const box = interactionBox(
        { cx: 0.5, cy: 0.22, w: 0.16, h: 0.2, score: 1 },
        ASPECT,
        fit.box,
      );
      ok(
        "...and the fitted box keeps clear of the frame edge",
        !!box && box.y1 <= 0.96,
        `bottom at ${box?.y1.toFixed(3)}`,
      );
      ok("...and so does the default now: no box edge is ever put on the frame edge", (() => {
        const d = interactionBox({ cx: 0.5, cy: 0.22, w: 0.16, h: 0.2, score: 1 }, ASPECT);
        return !!d && d.y1 <= 0.941 && d.shifted;
      })(), "the default box used to be pinned to the frame's bottom row at this distance");
    }
  }

  {
    // Reach is not symmetric — people favour a hand, and a camera is rarely on the centre line.
    const fit = fitReach(sweep({ reach: 2.0, shift: 1.1 }), ASPECT);
    ok("an off-centre sweep is not forced back to the middle",
      !!fit && near(fit.box.shiftFaces ?? 0, 1.1, 0.25), String(fit?.box.shiftFaces));
  }

  {
    // Four held corners. Built from the same face geometry as the sweep: a hand held at
    // (u, v) in face widths, at a comfortable extent, with the camera-frame position that
    // implies. Given in a scrambled order, because the fit must not care.
    const corner = (u: number, v: number, faceW = 0.1, faceCy = 0.35): ReachSample => ({
      u,
      v,
      x: 0.5 + u * faceW,
      y: faceCy + v * faceW,
      faceW,
    });
    const held = [corner(1.2, 5.2), corner(-1.4, 2.6), corner(-1.4, 5.2), corner(1.2, 2.6)];
    const fit = fitCorners(held, ASPECT);
    ok("four held corners produce a box", !!fit);
    // The targets sit 5% in from the screen edge, so the box is the held span over 0.9.
    ok("...whose width is the held span, grown to put the targets at 5% in",
      !!fit && near(fit.box.widthFaces, 2.6 / 0.9, 0.01), String(fit?.box.widthFaces));
    ok("...and whose centre is the centre of the four",
      !!fit && near(fit.box.shiftFaces ?? 0, -0.1, 1e-9) && near(fit.box.dropFaces, 3.9 / ASPECT, 1e-9),
      `${fit?.box.shiftFaces} / ${fit?.box.dropFaces}`);
    ok("...that nothing clipped", !!fit && !Object.values(fit.clippedBy).some(Boolean));
    ok("...and that we would ship", !!fit && isUsableBox(fit.box));

    // A corner held a shade short does not set the edge on its own: each edge is the mean of
    // its two corners.
    const short = [corner(1.2, 5.2), corner(-1.4, 2.6), corner(-1.0, 5.2), corner(1.2, 2.6)];
    const f2 = fitCorners(short, ASPECT)!;
    ok("one short corner moves the edge by half its shortfall",
      near(f2.box.widthFaces, (2.6 - 0.2) / 0.9, 0.01), String(f2.box.widthFaces));

    // A corner held at the edge of the picture is pulled back inside the fit's margin.
    const edge = [corner(1.2, 5.2), corner(-4.7, 2.6), corner(-4.7, 5.2), corner(1.2, 2.6)];
    const f3 = fitCorners(edge, ASPECT);
    ok("a corner at the frame edge is reported as the camera's limit", f3?.clippedBy.left === true);

    const axis = {
      center: corner(0, 3.9),
      left: corner(-1.4, 3.9),
      right: corner(1.4, 3.9),
      up: corner(0, 2.4),
      down: corner(0, 5.4),
    };
    const axisFit = fitAxisReach(axis, ASPECT);
    ok("axis holds fit when the neutral centre is inside their range", !!axisFit);
    ok(
      "axis holds reject directional samples that stayed too near centre",
      fitAxisReach(
        {
          center: corner(0, 3.9),
          left: corner(-0.2, 3.9),
          right: corner(0.2, 3.9),
          up: corner(0, 3.6),
          down: corner(0, 4.2),
        },
        ASPECT,
      ) === null,
    );
    ok(
      "axis holds reject a neutral centre outside the measured range",
      fitAxisReach({ ...axis, center: corner(2.0, 3.9) }, ASPECT) === null,
    );
    const axisEdge = fitAxisReach(
      { ...axis, left: { ...axis.left, x: 0.02 } },
      ASPECT,
    );
    ok(
      "an axis hold near the frame edge is clipped back to a safe box",
      axisEdge?.clippedBy.left === true &&
        !!axisFit &&
        axisEdge.box.widthFaces < axisFit.box.widthFaces,
    );

    ok("three corners are not enough", fitCorners(held.slice(0, 3), ASPECT) === null);
    ok("four corners on top of each other are refused",
      fitCorners([corner(0, 3), corner(0.1, 3), corner(0, 3.1), corner(0.1, 3.1)], ASPECT) === null);
  }

  ok("a sweep too short to mean anything is refused", fitReach(sweep({ reach: 2.2, n: 20 }), ASPECT) === null);
  ok("a hand that never moved is refused", fitReach(sweep({ reach: 0.05 }), ASPECT) === null);
  {
    // A sweep that leaves the picture on every side. There is no refusing this one — the frames
    // outside the shot were never recorded — so the guard has to bring it back to what the
    // camera could see rather than believe a reach of twelve face widths.
    const fit = fitReach(sweep({ reach: 12 }), ASPECT);
    ok("a sweep that runs off the frame is pulled back to what the camera saw",
      !!fit && fit.box.widthFaces <= 9.01 && fit.clippedBy.left && fit.clippedBy.right,
      `${fit?.box.widthFaces.toFixed(2)} faces`);
    ok("...and is still a box we would ship", !!fit && isUsableBox(fit.box));
  }
  {
    const fit = fitReach(sweep({ reach: 2.2 }), ASPECT)!;
    const small = shrinkBox(fit.box, 0.88);
    ok("shrinking gives up extent and keeps the centre",
      near(small.widthFaces, fit.box.widthFaces * 0.88, 1e-6) &&
        small.dropFaces === fit.box.dropFaces &&
        small.shiftFaces === fit.box.shiftFaces);
  }
}

{
  console.log("\nrecognition gates use elapsed sample time, not frame counts");

  const measureGates = (fps: number) => {
    const step = 1000 / fps;

    const pinch = new PinchDetector();
    let at = 0;
    let pinched = pinch.update(0.3, at);
    while (!pinched && at < 2_000) {
      at += step;
      pinched = pinch.update(0.3, at);
    }
    const settleAndOnMs = at;

    at += step;
    const missingAt = at;
    pinched = pinch.update(Number.NaN, at);
    while (pinched && at - missingAt < 2_000) {
      at += step;
      pinched = pinch.update(Number.NaN, at);
    }
    const graceMs = at - missingAt;

    const fist = new FistLatch();
    at = 0;
    let fisting = fist.update("Closed_Fist", 0.9, false, at);
    while (!fisting && at < 2_000) {
      at += step;
      fisting = fist.update("Closed_Fist", 0.9, false, at);
    }
    const fistOnMs = at;

    at += step;
    const openedAt = at;
    fisting = fist.update("Open_Palm", 0.9, false, at);
    while (fisting && at - openedAt < 2_000) {
      at += step;
      fisting = fist.update("Open_Palm", 0.9, false, at);
    }
    const fistOffMs = at - openedAt;

    return { fps, step, settleAndOnMs, graceMs, fistOnMs, fistOffMs };
  };

  const at30 = measureGates(30);
  const at15 = measureGates(15);
  const insideSampleWindow = (actual: number, target: number, step: number) =>
    actual >= target && actual < target + step + 1e-6;

  for (const measured of [at30, at15]) {
    ok(
      `pinch reacquisition + close proof stays ${PINCH_SETTLE_MS + PINCH_ON_MS}ms at ${measured.fps}fps`,
      insideSampleWindow(
        measured.settleAndOnMs,
        PINCH_SETTLE_MS + PINCH_ON_MS,
        measured.step,
      ),
      `${measured.settleAndOnMs.toFixed(1)}ms`,
    );
    ok(
      `pinch loss grace stays ${PINCH_GRACE_MS}ms at ${measured.fps}fps`,
      insideSampleWindow(measured.graceMs, PINCH_GRACE_MS, measured.step),
      `${measured.graceMs.toFixed(1)}ms`,
    );
    ok(
      `fist-on stays ${DEFAULT_GESTURE_TIMING.fistOnMs}ms at ${measured.fps}fps`,
      insideSampleWindow(
        measured.fistOnMs,
        DEFAULT_GESTURE_TIMING.fistOnMs,
        measured.step,
      ),
      `${measured.fistOnMs.toFixed(1)}ms`,
    );
    ok(
      `fist-off stays ${DEFAULT_GESTURE_TIMING.fistOffMs}ms at ${measured.fps}fps`,
      insideSampleWindow(
        measured.fistOffMs,
        DEFAULT_GESTURE_TIMING.fistOffMs,
        measured.step,
      ),
      `${measured.fistOffMs.toFixed(1)}ms`,
    );
  }

  const maxQuantisation = at15.step + 1e-6;
  for (const key of ["settleAndOnMs", "graceMs", "fistOnMs", "fistOffMs"] as const) {
    ok(
      `${key} agrees at 30fps and 15fps within one decoded sample`,
      Math.abs(at30[key] - at15[key]) <= maxQuantisation,
      `${at30[key].toFixed(1)}ms vs ${at15[key].toFixed(1)}ms`,
    );
  }
}

{
  console.log("\ncalibration: stored profiles fail closed");
  const valid = {
    version: PROFILE_VERSION,
    measuredAt: 1_700_000_000_000,
    camera: {
      deviceId: "camera-a",
      label: "Built-in camera",
      frameW: 1280,
      frameH: 720,
      fps: 30,
    },
    display: {
      width: 1920,
      height: 1080,
      availWidth: 1920,
      availHeight: 1040,
      left: 0,
      top: 0,
      dpr: 1,
      colorDepth: 24,
      orientation: "landscape-primary",
      slot: "",
    },
    box: { ...DEFAULT_POINTER.box },
    validated: true,
  };
  ok("a complete validated camera/display profile is accepted", isUsableProfile(valid));
  const sharedPrefix = "camera-with-a-long-browser-generated-prefix-".padEnd(80, "x");
  ok(
    "full camera identities cannot collide after a shared 64-character prefix",
    profileKey(`${sharedPrefix}a`, "Camera", valid.display) !==
      profileKey(`${sharedPrefix}b`, "Camera", valid.display),
  );
  ok(
    "camera labels remain part of an otherwise identical pairing key",
    profileKey(valid.camera.deviceId, "Camera A", valid.display) !==
      profileKey(valid.camera.deviceId, "Camera B", valid.display),
  );
  ok(
    "a valid blob cannot be reused from the wrong camera slot",
    !profileMatchesPair(valid, "camera-b", valid.camera.label, valid.display),
  );
  ok(
    "a valid blob cannot be reused from the wrong display slot",
    !profileMatchesPair(valid, valid.camera.deviceId, valid.camera.label, {
      ...valid.display,
      width: valid.display.width + 1,
    }),
  );
  ok(
    "a provisional profile is never restored as calibrated",
    !isUsableProfile({ ...valid, validated: false }),
  );
  ok(
    "a JSON-corrupted numeric measurement is rejected",
    !isUsableProfile({ ...valid, box: { ...valid.box, widthFaces: null } }),
  );
  ok(
    "a v3 visitor-specific profile is rejected instead of silently migrated",
    !isUsableProfile({ ...valid, version: 3 }),
  );
  ok(
    "an oversized or shifted box cannot enter the bounded v4 schema",
    !isUsableProfile({
      ...valid,
      box: { ...valid.box, widthFaces: valid.box.widthFaces * 1.2, shiftFaces: 0.2 },
    }),
  );
  const tinyMeasured = conservativeInstallationBox({
    widthFaces: 1.2,
    heightFaces: 0.8,
    dropFaces: -5,
    shiftFaces: 4,
  });
  ok(
    "an installation fit is bounded and drops one person's offsets",
    !!tinyMeasured &&
      near(tinyMeasured.widthFaces, DEFAULT_POINTER.box.widthFaces * 0.7, 1e-9) &&
      near(tinyMeasured.heightFaces, DEFAULT_POINTER.box.heightFaces * 0.7, 1e-9) &&
      tinyMeasured.dropFaces === DEFAULT_POINTER.box.dropFaces &&
      tinyMeasured.shiftFaces === 0 &&
      isInstallationBox(tinyMeasured),
  );
  const stored = JSON.stringify(valid);
  ok(
    "v4 persistence contains no visitor pinch, jitter, palm-size, or gesture policy",
    !["pinch", "jitter", "palmPx", "clickGesture"].some((field) => stored.includes(field)),
  );
  ok("a v4 profile survives a JSON round-trip", isUsableProfile(JSON.parse(stored)));
}

console.log(`\n${checks - failures}/${checks} passed\n`);
if (failures) process.exit(1);
