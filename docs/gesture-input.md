# Hand-gesture input — how it works today

A self-contained technical description of the Groundtruth kiosk's gesture recognition, written
so it can be handed to someone (or something) with no access to this repository. Every number
here is the value in the shipping source, with the file that owns it. Where a number is a
guess rather than a measurement, it says so.

Companion documents: `docs/vision-audit.md` (fault isolation, the measurement protocol, and
what the recorded evidence actually supports) and `CLAUDE.md` §5 rule 4 (one camera, one
pipeline).

---

## 0 · The problem this input solves

A large display sits at the entrance to a university research group's offices, **behind
glass**. There is no touchscreen, no keyboard, no phone, and no server — the site is a static
build running in one browser tab. The only sensor is a **single RGB webcam** pointed at a
public corridor.

Constraints that shaped every decision below:

- **No calibration step.** A passer-by will not stand on a mark, hold a pose, or wait through a
  setup wizard. Whatever adaptation happens must happen invisibly, within the first second.
- **No enrolment, no identity.** Nothing is recorded and nothing is uploaded. The face detector
  is used only for its bounding **box**, as a physical ruler (§4).
- **Anyone, any distance, any height.** Working assumption 1.0–2.5 m — see §9, this is the
  single biggest unmeasured quantity in the system.
- **Client-side only.** MediaPipe WASM in the page, ~30 fps shared with a WebGL gaussian-splat
  renderer on the same GPU. No cloud inference, no training.
- **Failure must be legible.** A screen in a hallway that silently stops responding is worse
  than one that says it cannot see you.

The interaction grammar is Apple visionOS's, minus the half a webcam cannot provide. Apple's
primary model is *eyes aim, hand confirms*; with no eye tracking that is unavailable, so this
implements Apple's own documented second input — **Pointer Control** (a hand drives an ordinary
cursor, a pinch clicks) with **Dwell Control** as the fallback.

```
move a hand         →  move the cursor       (indirect pointing, hand anywhere in reach)
pinch OR fist       →  click                 ("pinch is the new click")
pinch-and-lean      →  scroll
rest on a target    →  click after a delay   (Dwell — implemented, currently disabled)
```

---

## 1 · Stack

| | |
|---|---|
| Models | `@mediapipe/tasks-vision` 0.10.35 — **GestureRecognizer** (21-point hand landmarker + the canned gesture classifier) and **FaceDetector** (BlazeFace short-range) |
| Delegate | GPU, `runningMode: "VIDEO"` (silently falls back to CPU inside the WASM runtime) |
| Hosting | WASM runtime and both `.task`/`.tflite` files are served **from the kiosk's own origin**, copied out of `node_modules` at build time (`scripts/fetch-mediapipe.mjs`). Not a CDN: a throttled CDN on a university network does not fail loudly, it just means no hand is ever tracked. |
| Camera | `getUserMedia({ video: { width: {ideal:1280}, height: {ideal:720}, facingMode: "user" } })` |
| Detector thresholds | `numHands: 2`, detection 0.7 / presence 0.7 / tracking 0.6 — raised so a face or a background object cannot register as a phantom hand |
| Loop | one `requestAnimationFrame` loop; both models run on **every** frame; `<video>` is 1×1 px at `opacity:0` (deliberately not `display:none`) |

There is exactly **one** `getUserMedia` stream and **one** `VisionEngine` in the whole
application, mounted once in `App.tsx`. This is an enforced project rule: a second pipeline
roughly halves the frame rate, and because every downstream constant is tuned in real time
(350 ms debounce, 8-frame settle, an adaptive filter), a halved frame rate does not present as
an error — it presents as an interaction that feels bad for no visible reason.

---

## 2 · Pipeline, stage by stage

| # | Stage | Owner | Output |
|---|---|---|---|
| 1 | camera | `lib/vision/handPointer.ts` → `useHandPointer` | `MediaStream` |
| 2 | inference | `lib/vision/mediapipe.ts` → `VisionEngine.process(video, ts)` | per frame: up to 2 hands (21 normalised landmarks + 21 **world** landmarks in metres + handedness + canned gesture label & score), largest face box, true frame pixel size |
| 3 | scale + mapping | `lib/vision/calibration.ts` | face-anchored interaction box → screen-space `u,v` (§4) |
| 4 | smoothing | `lib/vision/oneEuro.ts` | jitter-free cursor (§5) |
| 5 | click detection | `calibration.ts` `PinchDetector` + `handPointer.ts` `FistLatch` | raw boolean "hand is closed" (§6) |
| 6 | gesture FSM | `handPointer.ts` → `HandPointer.update` | debounced press / release / drag-origin / dwell (§6.3) |
| 7 | interaction | `components/HandControl.tsx` | hover, tap, scroll, and the showreel's flight intent (§7, §8) |
| 8 | DOM | `HandControl.click()` | `elementFromPoint` + a synthesised bubbling `MouseEvent("click")` |

`HandPointer` is framework-free and camera-free: feed it one vision result per frame and read
its state. The kiosk, the offline test harness and a synthetic-hand driver all run the identical
code, so a number that looks good in one cannot differ in another.

---

## 3 · Where the hand *is*: the palm, never the fingertip

Cursor position comes from the **palm triangle** — the centroid of wrist (0), index MCP (5) and
pinky MCP (17).

The fingertip is the intuitive choice and the wrong one: the fingers are what perform the click,
so a cursor tied to them lurches at the exact moment of selection. (This is the failure Vogel &
Balakrishnan designed ThumbTrigger around for large displays.) The palm triangle is rigid, moves
only when the whole hand moves, and is the most reliably tracked part of the skeleton.

Scale reference for everything else: **palm width** = ‖indexMCP − pinkyMCP‖ in frame units.

---

## 4 · Auto-calibration: the face is the ruler

This is the least obvious part of the design and the one most worth reviewing.

A fixed mapping from "where the hand is in frame" to "where the cursor is on screen" is wrong
for everyone except the person it was tuned for. Stand closer and a comfortable arm sweep leaves
the frame entirely; stand further and the same sweep moves the cursor a few centimetres; be
shorter and the whole mapping sits too high.

Rather than measure distance, the mapping is defined so that **distance cancels out**:

1. **Scale comes from the visitor's own face.** Adult face width is near enough a physical
   constant (~15 cm), so its width in frame *is* the scale of everything else at that distance —
   a ruler that walks in with every visitor and never has to be asked for. No distance is
   measured and none needs to be.
2. **The interaction box is expressed in face widths and anchored to the face**, so it travels
   with the person and rescales itself as they move. A hand halfway across the box points
   halfway across the screen whether the visitor is at 1 m or 3 m, tall or short, centred or off
   to one side.
3. **The pinch threshold is normalised by palm width**, so hand size stops mattering too (§6.1).

### 4.1 The box

```
faceW  = face bounding-box width, normalised to frame x          ("one ruler unit")
halfW  = widthFaces  * faceW / 2
halfH  = heightFaces * faceW * aspect / 2        aspect = videoWidth / videoHeight
centre = (face.cx,  face.cy + dropFaces * faceW * aspect)

DEFAULT_BOX = { widthFaces: 4.5, heightFaces: 3.0, dropFaces: 2.6 }
```

Taking a face as ~15 cm that is a region roughly **68 × 45 cm, centred ~39 cm below the eyes** —
about chest height, and about what a standing person's hand covers without leaning or reaching.

`aspect` is genuinely needed: normalised coordinates are not isotropic, so a box specified in
face widths comes out squashed on any non-square frame.

**Fitting to the frame:** if the box hangs over an edge it is **slid** back inside; it is only
**cut** if it is genuinely larger than the frame. The order matters — the box size *is* the gain
of the mapping, so cutting silently changes how far the cursor travels per centimetre of hand,
and it collapses whichever axis overflowed (which is how a perfectly good mapping ends up sliding
only sideways). Sliding keeps the gain exact and gives up only the chest-height anchor. A cut box
sets `clamped`, which is the "visitor is too close" signal.

### 4.2 Losing the face

Two mechanisms, because the face is occluded constantly — by the very hand doing the pointing:

- **`FaceAnchor`** smooths the detection (per-frame ease 0.15 — a head is slow, so this is nearly
  free) and **coasts on the last anchor for 2000 ms** when the face is lost. Without the
  smoothing, a detection that jitters by a few pixels moves the *mapping* under a perfectly still
  hand — cursor jitter that no amount of filtering on the hand can reach, because the hand is not
  what moved.
- **`fallbackBox`** — with no face at all, the hand becomes its own ruler
  (`faceW = palmWidth / 0.62`) and the box is centred on the frame. Ergonomically worse, and
  enormously better than nothing: presence used to require a box, a box required a face, so a
  visitor standing off to one side or backlit got no cursor and no explanation.

### 4.3 Mapping out

```
u = 1 - clamp01((palm.x - box.x0) / box.w)      ← the mirror happens HERE, once
v =     clamp01((palm.y - box.y0) / box.h)
```

Everything upstream — landmarks, face box, interaction box — stays in raw un-mirrored camera
coordinates. Mixing the two conventions mid-pipeline is the classic source of a cursor that moves
the wrong way for one input only.

**Absolute, not relative.** The cursor is wherever the hand is inside the box, not an
accumulation of movement. Relative pointing is what a mouse does and it needs *clutching* — lift,
reposition, put down — a concept a passer-by has no reason to know and no affordance to discover.
Absolute mapping costs precision; the answer to that is large targets.

---

## 5 · Smoothing: the 1€ filter

`OneEuroPoint`, applied to `u,v` only (never to the gesture signal). Casiez, Roussel & Vogel,
CHI 2012 — heavy smoothing when the hand is still, cutoff opened right up when it moves, because
jitter is only objectionable at rest and lag is only objectionable in motion.

```
minCutoff = 0.4 Hz      beta = 10      dCutoff = 1.0 Hz
```

**`beta = 10` is not the published default and the difference matters.** The paper's 0.007
assumes an input in pixels or centimetres, where a brisk move has a speed in the hundreds. This
filter is fed positions normalised to 0..1 of the screen, where the same move has a speed near
1.7 — so 0.007 contributes essentially nothing and the adaptive half of the filter is silently
disconnected, leaving a plain low-pass that drags. Measured by replaying recorded hand data on a
fast half-screen sweep: **0.007 left the cursor 1299 px behind at 4K; 10 left it 59 px behind**,
at identical jitter (a still hand has no speed for beta to act on).

Filter state is **reset when a visitor leaves**, or the next person's cursor glides in from where
the last one left it.

---

## 6 · The click

Two completely independent detectors run in parallel; `clickGesture` selects which are trusted
(`"pinch" | "fist" | "either"`, default **`"either"`**, overridable at the wall with `?click=`).

### 6.1 Pinch — a normalised aperture with hysteresis

```
ratio = ‖thumbTip − indexTip‖₃ / ‖indexMCP − pinkyMCP‖₃      (WORLD landmarks, metres)

PINCH_ON  = 0.74     latch closed below this
PINCH_OFF = 0.88     release above this        (hysteresis band 0.14)
graceFrames  = 5     a held pinch survives this many hand-less frames (~165 ms @30fps)
settleFrames = 8     NO new pinch may latch for this many frames after a tracking gap (~265 ms)
```

Dividing by the palm span cancels distance from the lens **and** hand size, which is exactly what
a fixed threshold needs. Shape-wise this is what every vendor converges on — Ultraleap and Meta
both expose a normalised pinch *strength* with separate activate/deactivate distances. A
continuous `strength(ratio)` (0 = open, 1 = closed, calibrated against a measured open hand of
1.44) is computed for the UI but **decides nothing**.

`settleFrames` was expensive to learn: the first frames after a hand is reacquired are the least
trustworthy the model ever produces — a half-formed skeleton reads as a closed hand. Replaying a
recorded arm sweep, this alone accounted for **five phantom clicks in ten seconds**; merely moving
the cursor was firing it.

The thresholds are **fitted to recorded data**, not chosen: six trials (two runs of ten deliberate
pinches, plus stills, a sweep, and an empty room). Measured open hand 1.44 ± 0.015. 0.74 rather
than 0.72 for a measured reason — a *closed and held* pinch sits at about 0.758, so 0.72 sat just
inside it and a held pinch registered only if it happened to wobble across the line.

**An earlier adaptive version was removed and should not be reintroduced naively.** It tracked a
rolling estimate of how open this particular hand had recently been and set thresholds as
fractions of it. It deadlocked: the estimate rose fast and fell slowly, so an estimate that
started too high could never come down; a hand whose open posture read below threshold was
classified as pinched from the first frame, and escaping required a value it could never produce.
The click stuck down permanently — taking taps with it (they fire on release), dwell (it requires
no pinch) and the showreel steering (it holds still while pinched). One adaptive estimate, four
dead interactions.

### 6.2 Fist — the trained classifier, not geometry

```
label == "Closed_Fist" && score >= 0.5,  latched 2 frames on / 3 frames off
```

Deliberately **not** reconstructed from landmark geometry: "are the fingers curled" fails in
exactly the situations a trained classifier handles — a hand seen edge-on, at an angle, or partly
self-occluded. The label already arrives with every frame, so using it costs nothing. Frame counts
rather than a score threshold do the hysteresis, because the classifier's confidence flickers
frame to frame even when the posture is unambiguous to a human.

The fist exists because the pinch is unreliable (§9). It is a whole-hand posture, unmistakable
from any angle. Less elegant, much more reliable.

### 6.3 The state machine

```
raw posture      = pinch OR fist                       (per config)
press            = raw held continuously for PRESS_DEBOUNCE_MS = 350 ms
force-release    = MAX_HOLD_MS = 3000 ms backstop, then suppressed until the hand opens
tap              = fires ON RELEASE, not on press
releasedByLoss   = the press ended because the hand vanished  →  NOT a tap
```

- **350 ms debounce is fitted, not chosen.** Replaying the recorded trials at every value from 120
  to 600 ms, the number of real pinches detected does not move at all (4, 7 and 1 at every
  setting) while false clicks fall from three to zero. Real pinches are *held*; the false ones are
  momentary artefacts of a hand being reacquired mid-movement. An arm sweep — just moving the
  cursor — was firing clicks.
- **Tap on release** is the same rule as touch and as visionOS. A press cannot know yet whether it
  is the start of a tap or of a drag, and guessing "tap" means every attempt to scroll also
  activates whatever was underneath.
- **`MAX_HOLD_MS` sets a suppression flag only** and deliberately does *not* reset the detectors:
  resetting makes the posture read as absent for a few frames, which clears the very flag meant to
  hold the release, and the click latches straight back on.

### 6.4 Press-freeze: the cursor stops moving as a click lands

```
pressFreezeMs    = 180    hold the cursor still for this long after a press
pressLookbackMs  = 420    ...at the position it had this far BACK in time
                          clamped to `settledAt` — never reach back past the moment the hand stopped
```

Even taken from the palm, a pinch disturbs the whole hand enough to move the cursor several pixels
while the press registers. Worse, closing a pinch takes ~0.2 s and the threshold is crossed at the
*end* of that movement, so the position captured on the press edge is the position *after* the
disturbance, not the one the visitor aimed with. Reaching back past the gesture recovers the aim.

The clamp to `settledAt` (the last moment the cursor moved more than 0.004/frame) is also
measured: applied blindly, the lookback reaches into the travel that *brought* the cursor here, so
pinching the instant you arrive delivered the click to where you came **from**. Pinching
immediately did nothing; waiting 200 ms worked.

Consequence: the state carries **two positions**. `x/y` is the frozen aim (where a click lands);
`liveX/liveY` is where the hand actually is (the only honest way to ask "is this becoming a
drag?" — measuring drag against the frozen aim counts the freeze itself as movement, and every tap
gets thrown away as a drag).

### 6.5 Dwell — implemented, and switched off

Rest on a target for `dwellMs` and it activates. This is Apple's own documented fallback and was
carried here for visitors whose pinch a single webcam cannot read. **In use it was worse than the
problem**: a cursor that selects things simply by stopping means a visitor cannot pause to *read*
without activating whatever they paused over, and a hand-driven cursor stops constantly. Every
accidental trigger is a page the visitor did not ask for.

`dwellMs: 0` ships. The code stays (the accessibility case is real, and the trade may look
different on a better camera) and `?dwell=900` turns it back on at the wall. It carries a re-arm
factor of 2.5× the hold radius and a 700 ms refractory period, both because a hand held perfectly
still fired **twice** — the smoothing keeps creeping toward its final value long after the dwell
completes, and that creep alone drifted past the hold radius, re-armed, and fired again.

---

## 7 · Tap vs drag vs scroll

```
DRAG_START      = 0.025    in unit screen coords, measured from liveX/liveY at the press
SCROLL_DEADZONE = 0.025    SCROLL_FULL = 0.28    SCROLL_MAX_SPEED = 2400 px/s
scroll velocity = sign(offset) · t² · MAX,   t = (|offset| − DEADZONE) / (FULL − DEADZONE)
```

**Scrolling is a velocity, not a displacement.** Dragging the page directly — the obvious mapping,
and the one a touchscreen uses — does not survive being done in mid-air. An arm has perhaps 40 cm
of comfortable travel, so reaching the bottom of a long page means release, reposition, re-grab:
the clutch a finger performs effortlessly by lifting off glass. Mid-air there is nothing to lift
off, **the release is the least reliable part of the gesture**, and when it is missed the hand
travelling back up un-scrolls exactly what it just scrolled. The page oscillates under the hand.
Leaning removes the clutch entirely: hold, move away from where you grabbed, and the surface keeps
going for as long as you stay there.

`DRAG_START` and `SCROLL_DEADZONE` are **deliberately equal**. When the scroll deadzone was the
larger of the two there was a band between them where a lean was too big to count as a tap and too
small to scroll anything — and a hesitant lean in that band arrived as a **click** on whatever was
underneath (measured on a content page: lean 0.04, release, and the page changed). Matched, every
lean does exactly one of the two.

A drag only eats the click if there was **something scrollable under the grab** (`canScroll`,
decided once at press time). On a non-scrolling page a 20 px wobble otherwise produced no click,
no scroll, and no feedback at all.

Delivery is `document.elementFromPoint(x, y)` at the frozen aim, then a **synthesised bubbling
`MouseEvent("click")`** — not `el.click()`, which is an `HTMLElement` method that SVG elements do
not have. That bug gave every SVG icon button a dead 23 px centre inside a 64 px target, while
still lighting up on hover, so it read as tracking failure rather than as a broken button.

---

## 8 · Presence, and steering the idle showreel

```
enterMs = 250 ms      a hand must persist this long to count as a visitor
leaveMs = 1200 ms     ...and be gone this long before the cursor does
IDLE_RETURN_MS = 45 s  no hand for this long → the kiosk drops back to its showreel, on home
```

The idle screen is a continuous camera flight through a 1.8 M-splat gaussian scan of the campus
(Spark renderer), resting 5 s on each of five hand-picked viewpoints. **The tour hands the camera
over the moment a hand is seen** — not once some grip is discovered: a screen that keeps playing
its own loop while somebody stands in front of it waving reads as a screen that cannot see them.

Steering, `lib/vision/flightInput.ts`:

```
steer(x, y, { holdStill }):
    yaw   = latch(prev, x - 0.5)       hand left/right  → turn
    dolly = latch(prev, 0.5 - y)       hand high/low    → fly forward / pull back

latch(prev, off) = sign(off)  if |off| > FLY_ON  (0.18)
                 = 0          if |off| < FLY_OFF (0.12)
                 = prev       otherwise                    ← hysteresis, so a hand near the
                                                              boundary does not chatter
holdStill = the cursor is over a control ([data-no-fly] or any hoverable) OR a click is held
```

The camera loop integrates that intent:

```
HAND_YAW_RATE    = 0.5 rad/s     HAND_DOLLY_SPEED = 1.0 world-units/s   (1 unit ≈ 3 m)
HAND_ACCEL       = 0.35 s        v += (want − v) · min(1, dt/HAND_ACCEL)
HAND_RANGE       = 12 units      how far a visitor may get from the tour's composed pose
HAND_RELEASE     = 1.2 /s        decay back to the tour's framing once the hand leaves
```

Movement is also collision-tested per world axis against a precomputed **roam volume** (the open
air connected to the tour's stops, inside the model), so pushing into a building *slides* along it
rather than stopping dead — refusing the whole step reads as the controls having died.

The output contract is **intent, never position**: directions the camera loop integrates. That is
what keeps a dropped frame meaning "stop" instead of "jump".

> There is a second, richer grammar in the tree — `lib/vision/useHandFlight.ts`: ☝ one finger =
> slide, ✌ two fingers = turn + fly, 🖐 palm = stop. **It is not what production runs.** It is
> reachable only on the `/?exp=spark` developer page, and it opens its own camera. The kiosk uses
> the global pointer path described above.

---

## 9 · What is measured, and what is only assumed

An August 2026 fault-isolation audit instrumented the whole pipeline (`docs/vision-audit.md`).
Its findings are the honest state of the system:

**The pinch feature does not close, at any distance.** A deliberate pinch **held for six seconds
at 0.5 m** keeps `ratio` between 0.702 and 0.799 (median 0.761) for the entire recording, with no
dips of any prominence. Two fingertips in contact should drive this toward ~0.1. This is not a
resolution limit — it is why `PINCH_ON` had to be dragged up to 0.74, a value sitting *inside* the
closed-pinch distribution rather than in the gap below it.

**The prime suspect is the z term.** Both distances in `ratio` are taken in **three** dimensions,
and z is the one axis MediaPipe does not measure — it is regressed from a single view with a
strong prior that fingers do not interpenetrate. Two fingertips genuinely touching can still be
handed back a centimetre apart in depth, and the aperture then never collapses. Four alternative
features are now computed side by side every frame and logged, but **production still thresholds
the 3D world ratio and only that**:

| feature | what it removes |
|---|---|
| `ratioWorld3D` | — (ships today) |
| `ratioWorld2D` | the inferred axis, keeping metric scale |
| `ratioPx` | everything inferred — both quantities in raw camera pixels |
| `aperturePx` | nothing — this is the quantity an *optics* limit would apply to |
| `apertureZM` | diagnostic: how much of the 3D aperture is pure z |

**The distance claim in the source is unverified.** Every recorded trial in the archive was taken
at **0.5 m**. There is no data at 1.0–2.5 m, which is the range the kiosk actually operates in.
The comment asserting that "two fingertips two centimetres apart, seen from metres away, is a
signal the size of the noise" is plausible physics that was **never measured**, and the standing
conclusion drawn from it ("a third to a half of real pinches leave no trace at this distance")
draws an *optics* verdict from a *feature* measurement taken where optics was never in question.
The detector recovered 100% of what the feature contained; what the feature contained was 4 and 7
events out of 20 performed.

**Known code faults, left in place until the measurement run:**

- ~~`confidence()` is fed `palmNorm * 1280` — a **hard-coded assumption** about camera width.~~
  **FIXED (Sep 2026).** It now uses the frame width the browser actually decoded, which arrives on
  `VisionResult.frame`. On a 640-wide camera every palm-pixel figure the "too far" and "hand too
  small" warnings were judged on had been exactly twice the truth, so neither could fire on the one
  camera that most needed them.
- `videoWidth === 0` is a **silent total failure**: the track reports `readyState: "live"` and a
  confident `1280×720` while not one frame ever decodes. The loop correctly skips, and status still
  reports `running` — a dead screen that believes it is working.
- **`hands[0]` has no stable owner.** The array is MediaPipe's, unsorted. A bystander's hand or the
  visitor's second hand can take index 0 between frames, and the gesture feature jumps with it.
- Two models and two hands run on **every** frame, and everything downstream is tuned in real time,
  so frame rate is a parameter, not a comfort metric.

**No temporal filtering on the gesture signal itself.** Hysteresis yes, debounce yes — but a
per-frame noisy `ratio` goes raw into a threshold, and all the temporal robustness lives downstream
on the resulting boolean.

---

## 9b · Calibration — measuring the room instead of guessing it

**Added Sep 2026** (`components/Calibration.tsx`, `lib/vision/reachFit.ts`, `lib/vision/profile.ts`).

Everything in §4–§6 was fitted honestly against **one camera, at one distance, on one pair of
hands**. That is a defensible default and a bad law, and it produces one specific, measurable
failure: with the shipped box, at 0.5–1.0 m, the bottom edge of the *screen* maps onto the bottom
edge of the camera *frame*.

```
dist    faceW   box x        box y        verdict
0.5 m   0.200   0.05..0.95   0.00..1.00   CUT — the box is wider than the frame
0.8 m   0.130   0.21..0.79   0.31..1.00   bottom pinned to the frame edge
1.0 m   0.100   0.28..0.72   0.47..1.00   bottom pinned to the frame edge
1.5 m   0.068   0.35..0.65   0.48..0.85   fits
```

So reaching for anything along the bottom of the display puts the palm half out of shot, tracking
stops, and the pointer freezes. The corner is not hard to hit — it is unreachable, and nothing on
screen says so.

A ~20-second flow, run **once per camera** (keyed by `deviceId` in `localStorage`), measures four
things and replaces four sets of constants:

| Step | Measures | Replaces |
|---|---|---|
| sweep a hand around | the region this camera can actually track, in face widths | the hand-tuned `BoxConfig` (4.5 × 3.0, drop 2.6) |
| hold it still | the noise floor, by replaying the **real** 1€ filter over the recording and taking the highest cutoff that stays under 0.3% drift | `minCutoff 0.4`, `dwellRadius 0.035` |
| open the hand, then pinch a few times | this person's open and closed clouds, and thresholds landed in the gap between them | `PINCH_ON 0.74` / `PINCH_OFF 0.88` — and if the clouds overlap, `clickGesture` switches to `fist` |
| touch four corners | proof, with the calibrated pointer. A corner that cannot be held shrinks the box and retries | — |

Also recorded: the true frame size, the measured frame rate (used to re-derive the frame-counted
gates of §6.1 as durations), and the palm width in real pixels.

Per-camera and not per-visitor on purpose: what it measures is mostly a fact about the
installation — this lens, this mounting height, this angle — while the per-visitor part (distance,
hand size) is already handled by the face-width ruler the box is expressed in. Asking every
passer-by to calibrate would destroy the premise in §0.

`?calibrate=1` re-runs it, `?calibrate=0` skips the screen but still applies what was stored.

---

## 10 · Instrumentation and tests

Nothing below runs or costs anything without an explicit URL flag.

| | |
|---|---|
| `?visionDebug=1` | live HUD: true frame size, measured fps, all five candidate features, palm px, FSM phase, gate states, per-layer recall counters, and the named reason no click came out of this frame |
| `?visionLog=1` | passive frame-by-frame recording, exported as JSON |
| `?run=pinch\|fist\|rest&dist=&n=` | guided trial: the screen counts you in, prompts on a metronome, and downloads one JSON per run — this is what supplies ground truth for conditional recall |
| `?click=pinch\|fist\|either`, `?dwell=` | change the answer at the wall without a rebuild |
| `npm run check:pointer` | 78 offline tests driving the real state machine with synthetic vision results on a virtual clock — every failure mode ever hit is pinned as a test |
| `npm run usertest:home` | 75-point coverage grid, both postures, all four screen seams |
| `scripts/vision-audit.mjs` | offline metrics from recorded runs; reports Cohen's d between recognised and unrecognised attempts for each candidate feature |

Failures are classified rather than counted, at three layers — acquisition
(`HAND_NOT_FOUND`, `HAND_TOO_SMALL`, `NO_INTERACTION_BOX`), recognition (`LANDMARK_UNSTABLE`,
`PINCH_SCORE_ABOVE_THRESHOLD`, `PINCH_TOO_SHORT`, `PINCH_HELD_TOO_LONG`,
`PINCH_RELEASE_NOT_FOUND`) and interaction (`RECLASSIFIED_AS_DRAG`,
`POINTER_MOTION_SUPPRESSED_CLICK`, `NO_CLICK_TARGET`, `CLICK_ON_INERT_TARGET`). The split is the
point: "the hand wobbled" and "the wobble cost the click" must never become one number.

The four conditional rates, each with its own denominator:

```
1  Hand Recall                    — did the camera find a hand?   → optics, placement, light
2  Pinch Recall | Hand Detected   — was the posture read?         → the feature
3  Press Recall | Pinch Detected  — did policy allow it?          → thresholds, debounce
4  Click Recall | Press           — did a click come out?          → drag / target policy
```

---

## 11 · Open problems

These are the live questions. Outside opinions are wanted on all three.

**A · The camera-controlled flight feels mechanical.** Because it is: `latch()` quantises a
continuous hand position to −1/0/+1, so past the deadzone the camera always moves at exactly one
speed, and there is no third speed between "full" and "stopped". The original argument for this
was real — mapping offset to speed proportionally means the only way to creep is to hold a hand
hovering exactly at the edge of a deadzone, which nobody can do steadily; holding a key does not
work that way. But that argument was made about *raw frame coordinates*, and `steer()` is now fed
a calibrated, 1€-filtered position that is far steadier.

**B · Waving the hand back and forth makes the model judder.** Direct consequence of position-as-
direction: a left–right fan is an alternating stream of opposite commands, and every crossing of
the deadzone boundary is another reversal. The interaction people reach for — *make a fist and
sweep, and the model spins and coasts to a stop* — is a displacement-plus-inertia grammar
(grab / drag / release with friction), which the current position-as-velocity model cannot
express. Note the conflict to resolve: a fist is currently a **click**.

**C · The pinch (§9).** Whether to switch the shipped feature from `ratioWorld3D` to `ratioPx` or
`ratioWorld2D`, whether to add temporal filtering to the feature rather than only to the boolean,
and whether the distance hypothesis survives an actual measurement at 1.0–2.5 m. The camera
purchase for the wall is blocked on that measurement.

Constraints any proposal has to respect: one camera and one MediaPipe instance, no per-visitor
calibration step, no enrolment or recording, browser-only inference sharing a GPU with a gaussian-
splat renderer, and a passer-by who will be told the grammar in **one line of on-screen text** and
nothing else.
