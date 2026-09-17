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

- **No per-visitor calibration.** A passer-by will not stand on a mark, hold a pose, or wait
  through a setup wizard. An operator calibrates each **camera + display pairing** once; later
  visitors inherit that validated profile, while face- and palm-relative measurements adapt at
  runtime to their distance and hand size.
- **No enrolment, no identity.** Nothing is recorded and nothing is uploaded. The face detector
  is used only for its bounding **box**, as a physical ruler (§4).
- **Anyone, any distance, any height.** Working assumption 1.0–2.5 m — see §9, this is the
  single biggest unmeasured quantity in the system.
- **Client-side only.** MediaPipe WASM in the page, ~30 fps shared with a WebGL gaussian-splat
  renderer on the same GPU. No cloud inference, no training.
- **Failure must be legible.** A screen in a hallway that silently stops responding is worse
  than one that says it cannot see you.

The interaction grammar borrows the useful part of visionOS but cannot borrow its eye tracking.
Here the wrist aims an ordinary cursor and a complete close→open cycle confirms the action. A fist is the
production default because it is legible to both the visitor and a distant monocular camera;
pinch/either remain explicit operator experiments through `?click=`. Dwell remains implemented as
an accessibility experiment, but is off by default.

```
move a hand         →  move the cursor       (indirect pointing, hand anywhere in reach)
make a fist         →  click on open         (production default; policy, not calibration data)
close-and-lean      →  scroll                (the same configured close posture)
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
| Vision clock | `requestVideoFrameCallback` runs inference exactly once per newly decoded camera frame; the compatibility fallback deduplicates `video.currentTime`. A separate watchdog invalidates frozen, ended and backgrounded sources. Rendering remains on `requestAnimationFrame`. |

There is exactly **one** `getUserMedia` stream and **one** `VisionEngine` in the whole
application, mounted once in `App.tsx`. This is an enforced project rule: a second pipeline
roughly halves the frame rate. Recognition gates are wall-clock durations on unique decoded
samples, while control freshness adapts to the laptop's measured result cadence and inference
time. A slower machine may feel less immediate, but it cannot silently double frame-counted
gesture thresholds because there are no production frame-counted gates left.

---

## 2 · Pipeline, stage by stage

| # | Stage | Owner | Output |
|---|---|---|---|
| 1 | camera + decoded-frame clock | `handPointer.ts` + `videoFrameSource.ts` | one `MediaStream`; one monotonic sample `seq` per unique decoded frame; explicit stale/lifecycle events |
| 2 | inference | `mediapipe.ts` → `VisionEngine.process(video, ts)` | up to 2 hands (21 normalised landmarks + 21 **world** landmarks + handedness + gesture label/score), candidate face boxes, true decoded frame size |
| 3 | stable owner | `handOwner.ts` + `faceOwner.ts` | one temporary hand `ownerId`, selected by spatial/scale continuity rather than MediaPipe array order; one face associated with that owner rather than whichever face is largest |
| 4 | scale + mapping | `calibration.ts`, `reachFit.ts`, `profile.ts` | face-anchored box from the active camera/display profile → UI `u,v`; the same calibrated live coordinates centre production Explore on every device |
| 5 | smoothing + posture | `oneEuro.ts`, `pointerStabilizer.ts`, `PinchDetector`, `FistLatch` | responsive UI motion followed by an owner-scoped stationary deadband; explicit `open | closed | unknown` posture |
| 6 | gesture edges | `handPointer.ts` → `HandPointer.update` | durable queued `press`, `release` and `cancel` edges carrying owner, sample and frozen aim |
| 7 | exclusive routing | `interactionRouter.ts` + Showreel takeover in `HandControl.tsx` | calibration, automatic open-hand Explore, UI press and UI scroll are mutually exclusive; UI/closed/unknown always hold the scene |
| 8 | effects | `components/HandControl.tsx` + `flightInput.ts` | locked DOM click/scroll recipients or a session-scoped scene intent (§7, §8) |

The `HandPointer`, owner tracker and router cores are framework-free: feed them decoded-frame
observations and read state/actions. The kiosk, offline harnesses and synthetic-hand driver run
the same code. `HandControl` is the sole production consumer that turns those actions into DOM,
scroll and Gaussian-scene effects.

---

## 3 · Where the hand *is*: the wrist, never the fingertip

Cursor position comes from the **wrist landmark (0)**. `?point=palm` restores the older centroid
of wrist, index MCP (5) and pinky MCP (17) only for an operator comparison; it is not the default.

The fingertip is the intuitive choice and the wrong one: the fingers are what perform the click,
so a cursor tied to them lurches at the exact moment of selection. (This is the failure Vogel &
Balakrishnan designed ThumbTrigger around for large displays.) The first implementation used the
palm triangle on the assumption that it was rigid. In practice a fist cups the palm and makes both
knuckles move and re-estimate noisily. The wrist sits at the hand/arm boundary and changes least
when the fingers close, so both pointing and calibration use it through the same `palmCenter()`
function.

Scale reference for everything else: **palm width** = ‖indexMCP − pinkyMCP‖ in frame-x units.
MediaPipe normalises x by frame width and y by frame height, so vertical components are divided
by the camera aspect ratio before this distance is taken. Raw Showreel y uses the same units;
identical physical motion therefore has identical gain on 4:3 and 16:9 cameras.

---

## 4 · Runtime mapping: the face is the ruler

This is the least obvious part of the design and the one most worth reviewing.

A fixed mapping from "where the hand is in frame" to "where the cursor is on screen" is wrong
for everyone except the person it was tuned for. Stand closer and a comfortable arm sweep leaves
the frame entirely; stand further and the same sweep moves the cursor a few centimetres; be
shorter and the whole mapping sits too high.

The installation calibration in §9b measures a comfortable box for the current camera/display
pair. At runtime that box is still expressed in face widths, so distance adaptation remains
automatic. Rather than measure distance, the mapping is defined so that **distance cancels out**:

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

DEFAULT_BOX = { widthFaces: 2.7, heightFaces: 1.8, dropFaces: 2.2, shiftFaces: 0 }
```

Taking a face as ~15 cm, the fallback is a region roughly **41 × 27 cm, centred ~33 cm below
the eyes**. The deliberately compact region keeps the usable mapping inside a laptop camera's
field of view instead of placing screen edges at a person's maximum arm reach. A validated v4
profile may make width/height smaller, but only within **70–100%** of these defaults. It never
persists one installer's body offset: `dropFaces` stays 2.2 and `shiftFaces` stays 0.

`aspect` is genuinely needed: normalised coordinates are not isotropic, so a box specified in
face widths comes out squashed on any non-square frame.

**Fitting to the frame:** if the box hangs over an edge it is **slid** back inside; it is only
**cut** if it is genuinely larger than the frame. The order matters — the box size *is* the gain
of the mapping, so cutting silently changes how far the cursor travels per centimetre of hand,
and it collapses whichever axis overflowed (which is how a perfectly good mapping ends up sliding
only sideways). Sliding keeps the gain exact and gives up only the chest-height anchor. A cut box
sets `clamped`, which is the "visitor is too close" signal.

### 4.2 Losing the face

Three mechanisms, because the face is occluded constantly — sometimes by the hand doing the
pointing — and because a bystander's face must not become somebody else's ruler:

- **`StableOwnerFace`** first associates a face with the stable hand owner by proximity and
  plausible scale, then follows that same face across detector reordering and a short dropout.
  The largest visible face has no automatic authority.

- **`FaceAnchor`** smooths the detection (the historical 0.15 response at 30 fps is converted to
  a wall-clock time constant, so 15 and 30 fps have the same response) and **coasts on the last
  anchor for 2000 ms** when the face is lost. Without the
  smoothing, a detection that jitters by a few pixels moves the *mapping* under a perfectly still
  hand — cursor jitter that no amount of filtering on the hand can reach, because the hand is not
  what moved.
- **`fallbackBox`** — with no face at all, the hand becomes its own ruler
  (`faceW = palmWidth / 0.62`) and the box is centred on the frame. Ergonomically worse, and
  enormously better than nothing: presence used to require a box, a box required a face, so a
  visitor standing off to one side or backlit got no cursor and no explanation.

### 4.3 Mapping out

```
u = 1 - clamp01((wrist.x - box.x0) / box.w)      ← the mirror happens HERE, once
v =     clamp01((wrist.y - box.y0) / box.h)
```

Everything upstream — landmarks, face box, interaction box — stays in raw un-mirrored camera
coordinates. Mixing the two conventions mid-pipeline is the classic source of a cursor that moves
the wrong way for one input only.

**Absolute, not relative.** The cursor is wherever the hand is inside the box, not an
accumulation of movement. Relative pointing is what a mouse does and it needs *clutching* — lift,
reposition, put down — a concept a passer-by has no reason to know and no affordance to discover.
Absolute mapping costs precision; the answer to that is large targets.

---

## 5 · Smoothing: motion filter plus stationary stabilizer

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

One Euro alone cannot eliminate the last few pixels of a stationary landmark without also making
slow intentional motion viscous. `PointerStabilizer` therefore runs after it, but only while the
owner is visibly open and no press is active. It learns a residual-noise envelope against a
constant-velocity predictor, clamps the resulting deadband to `0.0025..0.01` screen units, and
subtracts the radius when movement exits the band rather than jumping across it. Slow coherent
travel remains motion; random stationary variation is held in place.

Both layers use decoded-sample timestamps. The stabilizer is session state, not calibration data:
it resets at an owner boundary/tracking reset and never crosses visitors. Production Showreel
Explore reads the calibrated, unfrozen live pointer coordinates, so the comfortable calibration
centre is its joystick centre on every camera/display pairing. `rawHand` remains available for
the isolated LOOK/MOVE authoring paths and router diagnostics; it is not the production Showreel
grammar.

---

## 6 · The click

Two independent detectors exist; one runtime policy selects which are trusted (`"pinch" |
"fist" | "either"`). The production default is **`"fist"`**. `?click=pinch|fist|either` is an
explicit operator override, and the same runtime source drives recognition and every instruction
shown by Calibration, Home, Showreel and the gesture hint. A stored profile cannot change it.

### 6.1 Pinch — a normalised aperture with hysteresis

```
ratio = ‖thumbTip − indexTip‖₃ / ‖indexMCP − pinkyMCP‖₃      (WORLD landmarks, metres)

PINCH_ON  = 0.74     latch closed below this
PINCH_OFF = 0.88     release above this        (hysteresis band 0.14)
PINCH_GRACE_MS  = 165     a held pinch survives a short landmark gap
PINCH_SETTLE_MS = 265     NO new pinch may latch during this interval after a gap
PINCH_ON_MS     = 100     continuous below-threshold evidence before latching
PINCH_OFF_MS    = 100     continuous above-threshold evidence before releasing
```

All temporal gates use the timestamp of each unique decoded sample. They therefore retain the same
wall-clock duration if the Gaussian renderer lowers inference from 30fps to 15fps; camera
calibration no longer stores or derives recognition timing.

Dividing by the palm span cancels distance from the lens **and** hand size, which is exactly what
a fixed threshold needs. Shape-wise this is what every vendor converges on — Ultraleap and Meta
both expose a normalised pinch *strength* with separate activate/deactivate distances. A
continuous `strength(ratio)` (0 = open, 1 = closed, calibrated against a measured open hand of
1.44) is computed for the UI but **decides nothing**.

`PINCH_SETTLE_MS` was expensive to learn: the first samples after a hand is reacquired are the least
trustworthy the model ever produces — a half-formed skeleton reads as a closed hand. Replaying a
recorded arm sweep, this alone accounted for **five phantom clicks in ten seconds**; merely moving
the cursor was firing it. The symmetric 100 ms close/open evidence prevents an isolated landmark
spike on either side from becoming a press or release; recorded idle and sweep trials are replayed
in `check:pointer` to keep their false-click count at zero.

The thresholds are **fitted to recorded data**, not chosen: six trials (two runs of ten deliberate
pinches, plus stills, a sweep, and an empty room). Measured open hand 1.44 ± 0.015. 0.74 rather
than 0.72 for a measured reason — a *closed and held* pinch sits at about 0.758, so 0.72 sat just
inside it and a held pinch registered only if it happened to wobble across the line.

**An earlier adaptive version was removed and should not be reintroduced naively.** It tracked a
rolling estimate of how open this particular hand had recently been and set thresholds as
fractions of it. It deadlocked: the estimate rose fast and fell slowly, so an estimate that
started too high could never come down; a hand whose open posture read below threshold was
classified as pinched from the first frame, and escaping required a value it could never produce.
The click stuck down permanently — preventing every later press epoch, dwell (it requires no
active close) and the showreel steering (it holds still while closed). One adaptive estimate,
four dead interactions.

### 6.2 Fist — trained classifier plus 3D geometry

```
(label == "Closed_Fist" && score >= 0.4) OR world-landmark fingers curled
latched after 66 ms closed / fist evidence clears after 100 ms not-closed
```

The classifier remains the first signal, but the production detector also checks curled fingers
in MediaPipe's 3D world landmarks. The fallback was added because a clearly held fist can remain
labelled `None`; using world rather than projected 2D landmarks avoids treating a finger pointed
at the lens as curled merely because it is foreshortened. Either signal may close the latch.
Decoded-sample timestamps provide the hysteresis, independently of the measured frame rate.

The fist is the production default because the pinch is unreliable (§9). It is a whole-hand
posture with more visual evidence at laptop distance. It is not literally unmistakable from every
angle, which is why release is also elapsed-time evidence rather than a single classifier frame.
An explicit `Open_Palm` releases after the fist latch clears. The common relaxed-hand result
`None` is accepted too: the press locks a conservative 240 ms shape baseline, then sustained
relative relaxation may prove the release even when the hand never becomes a textbook flat palm.
If geometry is already non-fist, thumb/index aperture may grow by 0.25 palm widths; if the old
geometry rule still calls it a fist, at least two non-thumb fingers must visibly uncurl. This only
starts the existing 100 ms latch-off plus 180 ms neutral proof; a one-frame label, aperture or
finger glitch still cannot submit a click.
The low 0.4 classifier threshold is used only to acquire difficult fists. During an owned release,
a stale `Closed_Fist` vote below 0.75 may be overruled by that sustained relative multi-finger
opening; a high-confidence fist still vetoes it. In `either` mode, releasing the primary detector
while the secondary detector remains closed suppresses the rest of that combined epoch, so one
physical gesture cannot become a fist click followed immediately by a pinch click.

### 6.3 The state machine

```
raw posture      = fist                                (default; pinch/either only by runtime override)
press            = raw held continuously for PRESS_DEBOUNCE_MS = 350 ms
fist release     = explicit open, or sustained non-fist + relative shape relaxation
force-cancel     = MAX_HOLD_MS = 30000 ms backstop, then suppressed until the hand opens
control click    = confirmed close locks the target; a valid open release fires once if unmoved
continuous grab  = page scroll only; Showreel Explore requires an open hand and holds on close
short dropout    = adaptive 120–800 ms live lease + 350 ms owned grace; never release
loss/stale/swap  = after that bound (or any owner change), explicit CANCEL, never release
```

- **350 ms debounce is fitted, not chosen.** Replaying the recorded trials at every value from 120
  to 600 ms, the number of real pinches detected does not move at all (4, 7 and 1 at every
  setting) while false clicks fall from three to zero. Real pinches are *held*; the false ones are
  momentary artefacts of a hand being reacquired mid-movement. An arm sweep — just moving the
  cursor — was firing clicks.
- **Control versus scroll is decided while held and committed on release.** A confirmed close
  locks the control and any scroll recipient beneath it, but does not click yet. Crossing either
  drag axis threshold permanently turns the transaction into `UI_SCROLL`; returning to the origin
  cannot restore click eligibility. If it never moved, a canonical open release revalidates the
  locked control at the frozen aim and clicks exactly once. The full ring means "close accepted";
  the release pulse means "click committed".
- **Tracking grace preserves the transaction, not stale motion.** The per-device 120–800 ms live
  lease is measured from capture; an already-owned UI transaction then gets 350 ms to bridge the
  fist-shaped landmark hole. `UI_SCROLL` velocity is zeroed as soon as the live lease expires and
  resumes only from a new same-owner closed sample. Missing evidence can never release or click.
- **`MAX_HOLD_MS` cancels and suppresses without pretending the hand opened**, and deliberately
  does *not* reset the detectors:
  resetting makes the posture read as absent for a few frames, which clears the very flag meant to
  hold the release, and the click latches straight back on.
- Press/release/cancel edges live in a durable queue until `InteractionRouter` consumes them. A
  complete close→move→open sequence between two display refreshes therefore cannot disappear or
  be misread as an unmoved tap.

### 6.4 Press-freeze: the cursor stays still while a click is pending

```
pressFreezeMs    = 180    hold the cursor still for this long after a press
pressLookbackMs  = 420    ...at the position it had this far BACK in time
                          clamped to `settledAt` — never reach back past the moment the hand stopped
```

Even taken from the wrist, closing the hand and the model's landmark re-estimation can move the
cursor several pixels while the press registers. The threshold is crossed at the *end* of that
movement, so the position captured on the press edge would otherwise be the position after the
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

## 7 · Control activation vs drag vs scroll

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

`DRAG_START` and `SCROLL_DEADZONE` are **deliberately equal**. A content grab crosses into
`UI_SCROLL` on exactly the same axis threshold at which non-zero scrolling becomes possible, so
there is no dead band that cancels movement while leaving the page still.

The press-frame hit test locks both the possible click target and the scroll recipient. Crossing
`DRAG_START` makes the held transaction `UI_SCROLL`, even if it began over a control, and returning
to the origin can never reinterpret it as a click. Without movement, only a fresh same-owner open
release may commit the locked control.

The recipient is found with `document.elementFromPoint(x, y)` at the frozen aim when the close is
confirmed, then revalidated at that same point on release. Delivery is a **synthesised bubbling
`MouseEvent("click")`** — not `el.click()`, which is an `HTMLElement` method that SVG elements do
not have. That bug gave every SVG icon button a dead 23 px centre inside a 64 px target, while
still lighting up on hover, so it read as tracking failure rather than as a broken button.

---

## 8 · Presence, and controlling the idle showreel

```
enterMs = 250 ms      a hand must persist this long to count as a visitor
leaveMs = 1200 ms     ...and be gone this long before the cursor does
IDLE_RETURN_MS = 45 s  no hand for this long → the kiosk drops back to its showreel, on home
```

The idle screen is a continuous camera flight through a 1.8 M-splat Gaussian scan of the campus
(Spark renderer), resting 5 s on each of five hand-picked viewpoints while the associated news
cards cycle. **No hand means attract mode.** As soon as one stable hand is present, the tour/news
clock freezes and the card steps aside; the visitor is never asked to choose LOOK or MOVE and
never has to grip the Gaussian background.

Production has one automatic `explore` grammar:

```
fresh stable OPEN hand, away from UI
  calibrated live x relative to comfortable centre → continuous yaw rate
  calibrated live y relative to comfortable centre → forward/back velocity
  hand in the centre deadzone                     → hold

UI underneath / fist / pinch / unknown posture    → hold immediately
hand lost, stale, owner changed or leaves frame    → cancel, breadcrumb return, resume tour/news
```

`sceneExploreAxes()` maps the calibrated live pointer position to bounded `[-1, 1]` axes, with
right and up positive. Reusing the calibration mapping is deliberate: the joystick centre and
reachable range follow the current camera/display pairing rather than raw laptop-camera pixels.
`SceneNavigationController` applies a dead-zoned response curve, real-time acceleration and
bounded physics substeps. Holding the hand to one side therefore turns continuously; holding it
high/low travels along the current horizontal heading. The visitor can stop by returning to the
comfortable centre without learning another pose.

There is still one camera and one recognition pipeline. Presence controls only the Showreel
lifecycle (freeze/hold/resume); motion still requires a fresh owner-matched scene session with a
monotonic `sessionId` and decoded-frame `seq`. `HandControl` starts or updates that session only
while the posture is explicitly open, the router is neutral-armed, the real scene is ready, and
no button/link/`data-no-fly`/`data-scene-ui` element is underneath. UI always wins. A closed or
unknown hand ends Explore and holds the current camera, so making a fist over Enter cannot also
move the Gaussian model. The production path no longer creates a background-fist `SCENE_GRAB`.

`lib/vision/flightInput.ts` is the scene-session boundary. It carries `sessionId`, stable
`ownerId`, decoded-frame `seq`, `freshAt`, `freshForMs`, `mode="explore"`, bounded `dx/dy`, velocity
and an `endReason`. `active` — not presence by itself — remains camera authority. Freshness is
measured from camera capture (so inference consumes, rather than renews, the lease): the rolling budget
follows the actual result cadence and inference time, is clamped to **120–800 ms**, and rejects a
result whose inference alone took more than 500 ms. The Spark consumer applies the greater of its
180 ms floor and that per-sample budget, so a healthy slower laptop is usable without allowing a
frozen camera to steer forever.

Movement is collision-tested per world axis against the precomputed **roam volume** (open air
connected to the tour stops). A rejected axis clears its stored velocity instead of charging up
against a wall. UI hover or a non-open posture holds the visitor's current view for as long as the
stable hand remains present. Only after the hand leaves does the camera retrace accepted
breadcrumbs at bounded speed; it never takes the old exponential straight-line shortcut through
a building. Quaternion return uses the shortest rotation, and the tour/news clock resumes only at
the exact composed pose.

The authored tour stops keep their exact pose and framing, while `safeTour.ts` inserts routing
vias through that same occupancy grid. The resulting production Catmull-Rom curve is sampled by
arc length at no more than one quarter-cell intervals and must be entirely roamable. Production
and the invariant call the same `buildProductionTourCurve()` constructor, so spline type or
tension cannot drift between them; the render loop additionally checks every displayed automatic
tour pose and fails closed on the last safe pose if one ever leaves the roam volume. This makes
"take over on any automatic-tour frame" an enforced invariant instead of a timing accident.
Loading and failure are published separately: Explore stays paused until the real camera pose
exists. Loading and failure remain visibly labelled even before a hand appears; neither state
claims that Explore is usable. A page-level error boundary keeps Enter usable even when WebGL,
Spark, the model asset or the lazy scene chunk cannot initialise on a particular laptop.

`look` and `move` remain internal modes for the Spark authoring tool and deterministic camera
tests. They are not displayed or selectable in production. Any earlier documentation describing
two public LOOK/MOVE buttons or a fist-on-background `SCENE_GRAB` records an abandoned
intermediate implementation, not the shipped interaction contract.

The old production showreel, its private webcam hook, and the separate one-finger/two-finger
flight grammar have been removed. `/?exp=cv` remains an isolated diagnostic experiment; it is not
mounted with the kiosk and cannot create a second production stream.

---

## 9 · What is measured, and what is only assumed

An August 2026 fault-isolation audit instrumented the whole pipeline (`docs/vision-audit.md`).
Its pinch findings remain useful diagnostic evidence, not the production click policy: fist is now
the default and pinch must be explicitly selected.

**The recorded pinch feature failed to close even at 0.5 m.** A deliberate pinch **held for six
seconds at 0.5 m** keeps `ratio` between 0.702 and 0.799 (median 0.761), with no
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

**Code faults identified by that audit and now closed:**

- The old `confidence()` path multiplied by a hard-coded 1280. It now uses the frame width the
  browser actually decoded, carried on
  `VisionResult.frame`. On a 640-wide camera every palm-pixel figure the "too far" and "hand too
  small" warnings were judged on had been exactly twice the truth, so neither could fire on the one
  camera that most needed them.
- A live track with no decoded video is no longer reported as running: startup has an explicit
  timeout, and the decoded-frame watchdog invalidates a frozen, ended or backgrounded source.
- Production no longer reads `hands[0]`. `StableHandOwner` selects one hand by spatial and scale
  continuity, reserves it through a short gap, and gives each acquisition an ephemeral `ownerId`.
  `StableOwnerFace` binds the scale ruler to that hand instead of taking the largest face. Owner
  change cancels an active interaction and resets filter/stabilizer state instead of transferring
  either motion or authority.
- Display refresh no longer clocks inference. `requestVideoFrameCallback` (or a deduplicated
  fallback) assigns one monotonic `seq` to each unique decoded camera frame, and downstream
  consumers refuse duplicates and stale samples.

Both models still run on each **unique decoded camera frame**, so GPU contention remains something
to measure on the final device. The pinch feature itself also has no continuous temporal filter:
hysteresis and debounce operate after the raw ratio crosses a threshold. That remains an explicit
measurement question rather than a hidden architectural fault.

---

## 9b · Calibration — measuring the room instead of guessing it

**Added Sep 2026** (`components/Calibration.tsx`, `lib/vision/reachFit.ts`, `lib/vision/profile.ts`).

The first mapping used a 4.5 × 3.0-face box centred 2.6 faces below the eyes. On close laptop
cameras that mapped parts of the screen to positions at, or beyond, the camera frame edge. The
current generic box is already a safer **2.7 × 1.8 faces, drop 2.2**, but lens, camera mounting and
display geometry are installation facts that still deserve a one-time proof.

A setup flow therefore runs **once per camera + display pairing**, never once per visitor. v4 is
deliberately an installation profile, not a biometric or a bag of learned thresholds. Its complete
persisted payload is:

```
version + measuredAt
camera  = deviceId, label, actual decoded frameW/frameH, measured fps
display = full/available width+height, origin, DPR, colour depth, orientation, optional slot
box     = bounded widthFaces/heightFaces plus the fixed default drop/shift
validated = true
```

It does **not** store pinch thresholds, click gesture, palm size, a visitor's jitter, filter
parameters, dwell settings or gesture timing. Recognition policy comes from code plus explicit URL
overrides; stationary noise is handled by the per-owner runtime stabilizer. This prevents the
person who installed the kiosk from silently defining every later visitor's physiology.

The three calibration stages are:

| Stage | Evidence | Acceptance rule |
|---|---|---|
| 1 · comfortable reach | hold **centre, left, right, up, down** while the whole hand remains inside the camera picture | fit horizontal/vertical reach independently in face widths; never ask for a diagonal or screen corner |
| 2 · configured gesture | close, then open or naturally relax the runtime selection gesture three times (normally a fist) | three real close→release cycles from the locked owner; `Open_Palm` is accepted, while `None` needs sustained non-fist plus open-aperture evidence; a lost hand cannot manufacture a release |
| 3 · mapped validation | revisit broad mapped **centre, left, right, up, down** screen zones | validate the provisional mapping's output, not proximity to five camera-space points; again, no corner target |

The fitted width and height are clamped to **70–100% of `DEFAULT_BOX`**. A tiny reach from one
operator therefore cannot create an arbitrarily high-gain pointer for everyone else, and a wide
reach cannot restore the old out-of-frame mapping. Installer-specific `drop`/`shift` are discarded.
The final broad-zone proof is what decides whether that conservative answer actually covers the UI.

Storage is keyed by the resolved camera identity plus a full display signature: screen and
available geometry, display origin, DPR, colour depth, orientation and optional `?display=<slot>`
for otherwise indistinguishable same-spec monitors. Moving between a laptop panel and external
display cannot silently reuse a mapping. A camera/display change during setup discards the
in-flight evidence and restarts resolution for the new pairing. Camera identity also carries a
monotonic revision and display resize/orientation events carry an installation revision, so a
fast A → B → A round-trip cannot hide behind an equal final signature and mix evidence.

Every hold consumes only a new decoded-frame `seq`, uses decoded-sample elapsed time, locks a
stable owner and clears contiguous evidence when the source stalls. A faster display cannot count
the same camera image twice. The flow is transactional: its provisional box may drive stage 3,
but nothing is persisted before all mapped zones pass. Restart/skip restores the previous
known-good profile. `?calibrate=1` forces a rerun; `?calibrate=0` waits for the real camera
identity and restores only that pairing. While resolving or calibrating, the Gaussian scene is
not mounted and the router remains in `CALIBRATION`, so setup has exclusive control authority.

---

## 10 · Instrumentation and tests

Nothing below runs or costs anything without an explicit URL flag.

| | |
|---|---|
| `?visionDebug=1` | live HUD: true frame size, measured fps, all five candidate features, palm px, FSM phase, gate states, per-layer recall counters, and the named reason no click came out of this frame |
| `?visionLog=1` | passive frame-by-frame recording, exported as JSON |
| `?run=pinch\|fist\|rest&dist=&n=` | guided trial: the screen counts you in, prompts on a metronome, and downloads one JSON per run — this is what supplies ground truth for conditional recall |
| `?click=pinch\|fist\|either`, `?dwell=` | change the answer at the wall without a rebuild |
| `npm run check:pointer` | offline tests driving the real state machine with synthetic vision results on a virtual clock — every failure mode ever hit is pinned as a test |
| `npm run check:interaction` | deterministic router tests: exclusive ownership, locked targets, durable fast edges, neutral re-arm, owner/stale/loss cancellation |
| `npm run check:scene` | **34 deterministic checks**: centred Explore deadzone, continuous turn/travel, 30/120Hz equivalence, stale rejection, collision, bounded breadcrumb return, internal LOOK/MOVE math and full-tour takeover safety |
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

## 11 · Remaining measurement work

The mechanical quantised flight and click/scene conflict are resolved by the routed, relative
scene sessions in §8. The remaining work needs measurements on real installations rather than
another hidden grammar or guessed threshold.

**A · Explore tuning.** Turn rate, travel speed, centre deadzone, acceleration and return timing
have URL overrides. Run the same task set on the intended camera distances and record completion
time, overshoot, cancellations and input-to-camera latency before changing their defaults. The
internal LOOK/MOVE modes are not candidates for restoring a production mode selector.

**B · The pinch (§9).** Whether to switch the shipped feature from `ratioWorld3D` to `ratioPx` or
`ratioWorld2D`, whether to add temporal filtering to the feature rather than only to the boolean,
and whether the distance hypothesis survives an actual measurement at 1.0–2.5 m. The camera
purchase for the wall is blocked on that measurement.

Constraints any proposal has to respect: one camera and one MediaPipe instance, no per-visitor
calibration step, no enrolment or recording, browser-only inference sharing a GPU with a gaussian-
splat renderer, and a passer-by who will be told the grammar in **one line of on-screen text** and
nothing else.
