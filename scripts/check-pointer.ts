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
  HandPointer,
  DEFAULT_POINTER,
  type PointerConfig,
} from "../apps/kiosk/src/lib/vision/handPointer";
import type { FaceResult, HandResult, Landmark, VisionResult } from "../apps/kiosk/src/lib/vision/mediapipe";
import { flightInput, steer, stopFlight } from "../apps/kiosk/src/lib/vision/flightInput";
import { fallbackBox } from "../apps/kiosk/src/lib/vision/calibration";
import { dragScrollVelocity } from "../apps/kiosk/src/lib/scrollGesture";
import { PinchDetector } from "../apps/kiosk/src/lib/vision/calibration";
import { PRESS_DEBOUNCE_MS } from "../apps/kiosk/src/lib/vision/handPointer";
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

function frame(h: HandResult | null, f: FaceResult | null = face()): VisionResult {
  return { hand: h, hands: h ? [h] : [], face: f };
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
  console.log("presence");
  const { p, clock } = fresh();
  run(p, clock, 100, () => frame(hand(0.5, 0.7)));
  ok("a hand that has only just appeared is not trusted yet", !p.state.present);
  run(p, clock, 300, () => frame(hand(0.5, 0.7)));
  ok("...and is, once it persists past enterMs", p.state.present);

  run(p, clock, 300, () => frame(null));
  ok("a brief disappearance does not end the session", p.state.present);
  run(p, clock, 1500, () => frame(null));
  ok("a long one does", !p.state.present);
}

{
  console.log("\nthe click never sticks");
  const { p, clock } = fresh();
  run(p, clock, 500, () => frame(hand(0.5, 0.7)));
  run(p, clock, 600, () => frame(hand(0.5, 0.7, 0.3)));
  ok("a pinch registers once it has been held", p.state.pinched);

  // The hand vanishes while still pinched — the worst case, because a held click on an
  // unsteerable cursor is a mouse button nobody can lift.
  run(p, clock, 66, () => frame(null));
  ok("one or two lost frames hold the press (no double click)", p.state.pinched);
  run(p, clock, 400, () => frame(null));
  ok("a genuinely lost hand releases it", !p.state.pinched);

  const before = countPresses(p, clock, 400, () => frame(hand(0.5, 0.7)));
  ok("an open hand returning does not fire a phantom click", before === 0);
}

{
  console.log("\nthe click can never stick down");
  const { p, clock } = fresh();

  ok("dwell is off by default — resting must not select", DEFAULT_POINTER.dwellMs === 0);

  // A hand whose open posture reads BELOW the seeded threshold. This is the failure that got
  // shipped: the reference is judged too high, so an open hand is read as pinched from the
  // first frame, and releasing needs a ratio it can never produce. The click sticks down —
  // and with it, taps (they fire on release) and dwell (it requires no pinch).
  const s = run(p, clock, 900, () => frame(hand(0.5, 0.7, 0.8)));
  ok("an unusual open hand is not mistaken for a held pinch", !s.pinched, `ratio 0.8`);

  // ...and if one is somehow latched, holding it far past any real click clears it.
  const { p: p2, clock: c2 } = fresh();
  run(p2, c2, 600, () => frame(hand(0.5, 0.7)));
  run(p2, c2, 800, () => frame(hand(0.5, 0.7, 0.3)));
  ok("a real pinch is held while it lasts", p2.state.pinched);
  run(p2, c2, 3500, () => frame(hand(0.5, 0.7, 0.3)));
  ok("but a click held for seconds lets go by itself", !p2.state.pinched);
}

{
  console.log("\nnoise is not a click, and it must not kill dwell");
  const { p, clock } = fresh({ dwellMs: 600, dwellRadius: 0.04 });
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
  const { p: p2, clock: c2 } = fresh();
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
  console.log("\nthe face may be covered — by the pointing hand, constantly");
  const { p, clock } = fresh();
  run(p, clock, 600, () => frame(hand(0.5, 0.7)));
  const boxBefore = p.state.box;
  ok("a box exists while the face is visible", !!boxBefore);

  const s = run(p, clock, 900, () => frame(hand(0.55, 0.7), null));
  ok("the box survives the face being covered", !!s.box);
  ok("...and says it is coasting", s.faceHeld);
  ok("the cursor keeps tracking through it", Number.isFinite(s.x) && s.present);

  const s2 = run(p, clock, 2500, () => frame(hand(0.55, 0.7), null));
  ok("but it does not coast on that face forever", !s2.faceHeld);
  // It does not go dark either: past the hold, the hand measures itself and the mapping
  // degrades to a frame-centred one, which is reported rather than silently pretended.
  ok("...it falls back instead of dying", !!s2.box && s2.conf.reason === "no-face");
  ok("...and the visitor is still being tracked", s2.present);
}

{
  console.log("\na press keeps the aim it was made with");
  const { p, clock } = fresh();
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
  const { p, clock } = fresh();
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
}

{
  console.log("\nthe fist path (for when a pinch cannot be seen)");
  const { p, clock } = fresh({ clickGesture: "fist" });
  run(p, clock, 600, () => frame(hand(0.5, 0.7)));
  ok("an open hand is not a click", !p.state.pinched);

  const n = countPresses(p, clock, 700, () => frame(hand(0.5, 0.7, 1.44, "Closed_Fist", 0.9)));
  ok("a fist clicks once", n === 1, `fired ${n}`);
  run(p, clock, 400, () => frame(hand(0.5, 0.7, 1.44, "Open_Palm", 0.9)));
  ok("opening releases it", !p.state.pinched);
  ok("a low-confidence label is ignored", !runFist(p, clock, 0.2));
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
  console.log("\nflying the showreel");
  stopFlight();

  steer(0.5, 0.5);
  ok("the tour hands over as soon as a hand is seen", flightInput.present);
  ok(
    "...but a hand held in the middle does not move the camera",
    flightInput.yaw === 0 && flightInput.dolly === 0,
  );

  steer(0.95, 0.5);
  ok("a hand to the right turns right", flightInput.yaw === 1);
  steer(0.05, 0.5);
  ok("a hand to the left turns left", flightInput.yaw === -1);
  steer(0.5, 0.05);
  ok("a hand held high flies forward", flightInput.dolly === 1);
  steer(0.5, 0.95);
  ok("a hand held low pulls back", flightInput.dolly === -1);

  // Hysteresis: coming back only part-way must not stop it, or a hand hovering near the
  // boundary makes the camera stutter in and out of motion.
  steer(0.95, 0.5);
  steer(0.66, 0.5);
  ok("drifting back part-way keeps flying", flightInput.yaw === 1);
  steer(0.55, 0.5);
  ok("returning to the middle stops", flightInput.yaw === 0);

  steer(0.95, 0.05);
  steer(0.95, 0.05, { holdStill: true });
  ok(
    "aiming at a control holds the camera still",
    flightInput.yaw === 0 && flightInput.dolly === 0,
  );
  ok("...while still keeping the tour handed over", flightInput.present);

  steer(0.95, 0.05);
  stopFlight();
  ok(
    "a hand that leaves stops the camera dead",
    !flightInput.present && flightInput.yaw === 0 && flightInput.dolly === 0,
  );

  steer(Number.NaN, Number.NaN);
  ok("garbage never becomes movement", flightInput.yaw === 0 && flightInput.dolly === 0);
  stopFlight();
}

{
  console.log("\nscrolling by leaning, not by dragging");

  ok("a hand that has not moved does not scroll", dragScrollVelocity(0) === 0);
  // The deadzone now matches the drag threshold, so anything past it is a scroll by
  // definition — a lean that is neither a tap nor a scroll is the outcome nobody can read.
  ok("nor does a wobble too small to be a drag", dragScrollVelocity(0.02) === 0);
  ok("but anything past the drag threshold does scroll", dragScrollVelocity(0.04) > 0);
  ok("below the hand scrolls down", dragScrollVelocity(0.2) > 0);
  ok("above it scrolls up", dragScrollVelocity(-0.2) < 0);
  ok(
    "and it is symmetric",
    Math.abs(dragScrollVelocity(0.2) + dragScrollVelocity(-0.2)) < 1e-9,
  );

  const slow = dragScrollVelocity(0.1);
  const fast = dragScrollVelocity(0.25);
  ok("further means faster", fast > slow && slow > 0, `${slow.toFixed(0)} → ${fast.toFixed(0)}`);
  ok("but it is capped", dragScrollVelocity(5) === dragScrollVelocity(0.28));

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
      const on = det.update(r === null ? Number.NaN : r);
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

function runFist(p: HandPointer, clock: { t: number }, score: number): boolean {
  return countPresses(p, clock, 300, () => frame(hand(0.5, 0.7, 1.44, "Closed_Fist", score))) > 0;
}

console.log(`\n${checks - failures}/${checks} passed\n`);
if (failures) process.exit(1);
