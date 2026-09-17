# Fault-isolation audit — archived baseline and measurement protocol

> **Status (2026-09-17): historical audit, not the current runtime contract.** The stage table,
> findings and wording such as “currently” below describe the instrumented pre-consolidation
> pipeline. The resulting defects have since driven the single production chain documented in
> `docs/gesture-input.md`: unique decoded frames, elapsed-time recognition, stable hand+face
> ownership, adaptive freshness, exclusive routing, a wrist pointer with per-owner stabilization,
> v4 installation-only calibration and explicit Showreel LOOK/MOVE. Do not use this file to infer
> current defaults or profile fields.

The recorded evidence remains useful for one unresolved experiment. It does **not** support the
old claim that a webcam metres away necessarily fails because it cannot resolve two fingertips.
At 0.5 m, a deliberately held pinch still failed to collapse the chosen 3D feature (§6), while no
1.0–2.5 m dataset existed. Production therefore defaults to **fist**; pinch remains an explicit
`?click=pinch` experiment until measurements justify changing that policy.

---

## 1 · The pipeline, stage by stage

Every stage, with the file and function that owns it. One camera, one MediaPipe, mounted once
in `App.tsx` (CLAUDE.md §4) — that invariant is intact and nothing here touches it.

| # | Stage | Where | Notes |
|---|-------|-------|-------|
| 1 | `getUserMedia` | `lib/vision/handPointer.ts` → `useHandPointer` | asks for `width/height: {ideal: 1280×720}`, `facingMode:"user"`. **`ideal` is a request, not a guarantee.** |
| 2 | video frame | `<video class="gt-hand-cam">` in `components/HandControl.tsx` | 1×1px, `opacity:0`, deliberately not `display:none`. The loop gates on `video.readyState < 2`. |
| 3 | MediaPipe | `lib/vision/mediapipe.ts` → `VisionEngine.process` | `GestureRecognizer.recognizeForVideo(video, ts)` **and** `FaceDetector.detectForVideo(video, ts)`, both every frame. Assets served from our own origin. |
| 4 | hand detection | `GestureRecognizer` options | `numHands: 2`, detection 0.7 / presence 0.7 / tracking 0.6. |
| 5 | landmarks | `mediapipe.ts` → `allHands` | 21 normalised points + 21 world points (metres) + handedness + canned gesture label. `hands[0]` is taken as *the* hand. |
| 6 | gesture features | `handPointer.ts` → `handRatio`; **new:** `lib/vision/features.ts` → `pinchFeatures` | production feature = `‖thumbTip−indexTip‖₃ / ‖indexMCP−pinkyMCP‖₃`, world space. |
| 7 | raw pinch classifier | `calibration.ts` → `PinchDetector.update` | fixed threshold + hysteresis, `ON 0.74` / `OFF 0.88`. |
| 7b | raw fist classifier | `handPointer.ts` → `FistLatch` | MediaPipe's own `Closed_Fist` label, `score ≥ 0.4`, 66ms on / 100ms off on decoded-sample time. |
| 8 | temporal filtering | see §4.3 | **none on the pinch signal itself.** The 1€ filter (`oneEuro.ts`) smooths *position* only. |
| 9 | gesture FSM | `handPointer.ts` → `HandPointer.update` | `PRESS_DEBOUNCE_MS = 350`, `MAX_HOLD_MS = 30000`, press-freeze 180ms with a 420ms look-back. |
| 10 | click / drag decision | `interactionRouter.ts` | confirmed close locks a pending control/scroll transaction; held movement past `DRAG_START = 0.025` becomes scroll, otherwise a valid open release clicks once. |
| 11 | target hit test | `HandControl` | `document.elementFromPoint(x, y)` locks the control at the frozen aim on press and revalidates the same target there on release. |
| 12 | DOM event | `HandControl.click()` | a synthesised, bubbling `MouseEvent("click")` — not `el.click()`, so SVG targets work. |

Mapping and mirroring sit alongside stages 5–6: `calibration.ts` builds the interaction box from
the (smoothed, coasting) face anchor, `mapToBox` converts a palm position into screen
coordinates **and applies the mirror, once, in that one place**.

---

## 2 · Failure taxonomy

Implemented in `lib/vision/trace.ts`, reported by the HUD and recorded into every run file. Each
reason names the exact code site that decides it, so the vocabulary cannot drift away from the
program.

| Layer | Reason | Decided at |
|---|---|---|
| acquisition | `HAND_NOT_FOUND` | `handPointer.update`, `res.hands[0]` null |
| acquisition | `NO_INTERACTION_BOX` | `interactionBox` **and** `fallbackBox` both null |
| acquisition | `HAND_TOO_SMALL` | palm span below `MIN_PALM_PX = 42`, measured on the **true** frame width |
| recognition | `LANDMARK_UNSTABLE` | `PinchDetector.settleMs` — 265ms of decoded-sample time after a tracking gap in which no new pinch may latch |
| recognition | `PINCH_SCORE_ABOVE_THRESHOLD` | `ratio ≥ PINCH_ON`, and only while the fingers are actually closing |
| recognition | `PINCH_TOO_SHORT` | raw posture ended inside `PRESS_DEBOUNCE_MS` |
| recognition | `PINCH_HELD_TOO_LONG` | `MAX_HOLD_MS` force-release |
| recognition | `PINCH_RELEASE_NOT_FOUND` | `releasedByLoss` — the press ended because the hand vanished |
| interaction | `RECLASSIFIED_AS_DRAG` | hand travelled past `DRAG_START` while held |
| interaction | `POINTER_MOTION_SUPPRESSED_CLICK` | …and there was something scrollable under the grab, so the click was dropped |
| interaction | `NO_CLICK_TARGET` | `elementFromPoint` returned null |
| interaction | `CLICK_ON_INERT_TARGET` | a click **was** dispatched, onto an element with no interactive ancestor |
| interaction | `CLICK_SUPPRESSED` | any other suppression |

The separation is the point. `RECLASSIFIED_AS_DRAG` and `POINTER_MOTION_SUPPRESSED_CLICK` are
split on purpose: "the hand wobbled" and "the wobble cost the click" must never become one
number.

---

## 3 · Camera input — what is verified, and what is not

### 3.1 Verified in code

- The request is `{ width: {ideal: 1280}, height: {ideal: 720} }`. `ideal` is advisory; a
  device is free to return anything.
- **Actual** values are now read at runtime and shown in the HUD and stamped into every run
  file: `video.videoWidth/videoHeight`, `track.getSettings().width/height/frameRate`,
  `track.label`, the element's CSS box, and the **measured** end-to-end frame rate.
- Reported resolution is never used as a stand-in for the requested one. The audit's pixel
  figures all derive from `videoWidth`.

### 3.2 Coordinate transforms — audited, and they are clean

- **CSS scaling is irrelevant.** The element is 1×1px with `object-fit: contain`, but MediaPipe
  reads `videoWidth/videoHeight`, not layout size. Verified at runtime: the HUD prints the CSS
  box beside the decoded size precisely so a future change here would be visible.
- **The mirror happens once**, in `calibration.mapToBox`, on the way out to screen space. The
  camera element carries no `transform`. Landmarks, the interaction box and the face box are
  all in raw un-mirrored frame coordinates throughout.
- **`aspect` is derived per frame** from `videoWidth/videoHeight` and is genuinely needed:
  `interactionBox` expresses vertical extents in face widths, which are x-units.
- **The face box is normalised correctly** — `largestFace` divides MediaPipe's pixel bounding
  box by `video.videoWidth/videoHeight`.
- No canvas sits between the camera and the model in production.

### 3.3 Findings

**F1 — a hard-coded 1280 in the confidence calculation. FIXED, Sep 2026** — `handPointer.update`
now reads the frame width off `VisionResult.frame` instead. The original finding follows.

 `handPointer.update` calls
`confidence(face, box, palmNorm * 1280)`. If the camera returns 640×480, every palm-pixel
figure the "too far" and "hand too small" verdicts are judged on is **exactly twice the truth**,
so the two warnings that exist for the distance problem can never fire on the camera that most
needs them. Left in place, marked in the source, and the true value is now measured into
`state.palmPx` beside it. ~~*Not fixed yet — fixing it changes on-screen behaviour, which this
phase does not do.*~~ Fixed once the calibration screen landed, since that phase changes
on-screen behaviour deliberately.

**F2 — `videoWidth === 0` was a silent, complete failure. FIXED, Sep 2026.** Observed in headless Chrome: the
track reports `readyState: "live"` and `getSettings()` returns a confident `1280×720`, while
`video.readyState` is 0 and `videoWidth` is 0 — not one frame ever decoded. The pointer loop
correctly skips (`readyState < 2`), so **nothing is tracked, and `handStatus` still reports
`running`**. On the wall this was a dead screen that believed it was working. The current source
has a first-frame timeout plus frozen/ended/hidden watchdog invalidation; the paragraph records
the observation that motivated it.

**F3 — display refresh used to repeat model work. FIXED; two models/two candidates remain.**
`FaceDetector` still runs alongside the recogniser and `numHands: 2` still supplies candidates,
but `requestVideoFrameCallback` now runs them once per unique decoded frame. Recognition gates are
elapsed milliseconds, and stable ownership consumes the candidates; the old `hands[0]`/frame-count
coupling described by this finding is gone.

**F4 — `hands[0]` had no stable owner. FIXED, Sep 2026.** The array is MediaPipe's, not sorted by us. In a public
corridor a bystander's hand or the visitor's second hand could take index 0 between frames, and
the pinch feature jumped with it. `StableHandOwner` now tracks by position/scale continuity,
`StableOwnerFace` associates its face ruler, and an owner boundary cancels rather than transfers
an interaction.

### 3.4 Still to measure at the wall

The actual resolution, actual frame rate, and actual palm pixel counts **cannot be obtained
here**: headless Chrome on this machine never decodes a camera frame (F2), and the fake-device
path synthesises whatever resolution it is asked for, so it cannot reproduce a mismatch. These
are the first three numbers the wall run produces.

---

## 4 · The pinch feature

### 4.1 Is it scale-normalised? Yes — and that is not the problem

```
ratio = ‖thumbTip − indexTip‖₃  /  ‖indexMCP − pinkyMCP‖₃     (world landmarks, metres)
```

Dividing by the palm span cancels distance from the lens **and** hand size, which is exactly
what a fixed threshold needs. The common accusation — "it isn't normalised, that's why it
breaks at distance" — is wrong.

### 4.2 What *is* suspect: the subscript

Both distances are taken in **three** dimensions, and z is the one axis MediaPipe does not
measure. It is regressed from a single view by a model carrying a strong prior that fingers do
not interpenetrate. Two fingertips genuinely in contact can still be handed back a centimetre
apart in depth — and the aperture then never collapses.

`features.ts` now computes, every frame, side by side:

| feature | definition | what it removes |
|---|---|---|
| `ratioWorld3D` | **ships today** | — |
| `ratioWorld2D` | same, z dropped | the inferred axis, keeping metric scale |
| `ratioPx` | `‖thumbTip−indexTip‖₂ / ‖indexMCP−pinkyMCP‖₂` in **camera pixels** | everything inferred: every quantity was seen by the sensor. **This is the normalised feature the audit asked for.** |
| `aperturePx` | fingertip separation in raw pixels | nothing — this is the quantity the *optics* limit applies to |
| `apertureZM` | how much of the 3D aperture is pure z | the diagnostic: large under a closed pinch is the smoking gun |

All five are in the HUD and in every recorded frame. **Production still thresholds
`ratioWorld3D` and only `ratioWorld3D`.** `vision-audit.mjs` reports the separation (Cohen's d)
of each between recognised and unrecognised attempts, which is the number that would justify a
switch.

### 4.3 Hysteresis and temporal filtering — the full inventory

| mechanism | value | acts on |
|---|---|---|
| `PINCH_ON` | 0.74 | the ratio |
| `PINCH_OFF` | 0.88 | the ratio (hysteresis band = 0.14) |
| `PINCH_GRACE_MS` | 165ms | how long a held pinch survives a lost hand |
| `PINCH_SETTLE_MS` | 265ms | **blocks any new latch** after a tracking gap |
| `FistLatch` | 66ms on / 100ms off, score ≥ 0.4 | the fist label |
| `PRESS_DEBOUNCE_MS` | 350 | the boolean posture, not the signal |
| `MAX_HOLD_MS` | 30000 | force-cancel backstop |
| `pressFreezeMs` / `pressLookbackMs` | 180 / 420 | cursor position at the press |
| `enterMs` / `leaveMs` | 250 / 1200 | presence |
| 1€ filter | `minCutoff 0.4`, `beta 10` | **position only** |
| dwell | `0` — off | — |

So: hysteresis **yes**, debounce **yes**, but **there is no smoothing of the pinch feature
itself**. A per-frame noisy signal goes raw into a threshold, and all the temporal robustness
lives downstream on the boolean. If the ratio is noisy at distance, that is a gap — and it is
cheap to test, because `ratioPx` and `ratioWorld2D` are already being logged frame by frame.

---

## 5 · Separating recognition from interaction

Four conditional rates, reported by `scripts/vision-audit.mjs`, each with its own denominator
supplied by the guided run's ground truth:

```
1  Hand Recall                     — did the camera find a hand?      → optics, placement, light
2  Pinch Recall | Hand Detected    — was the posture read?            → the feature
3  Press Recall | Pinch Detected   — did policy allow it?             → thresholds, debounce
4  Click Recall | Press            — did a click come out?            → drag / target policy
=  end to end                      — what a visitor experiences       → the least useful to fix
```

A physical pinch can therefore fail at one specific layer, and the HUD's three numbered blocks
mirror the same split live. Demonstrated end to end against the synthetic hand: a run that drove
three deep pinches and three shallow ones scored `Hand 6/6 · Pinch|Hand 2/6 · Press|Pinch 2/2 ·
Click|Press 1/2`, with `PINCH_SCORE_ABOVE_THRESHOLD` and `CLICK_ON_INERT_TARGET` named as the
two distinct causes. (That is a check of the *harness*, not of the camera — see
`scripts/usertest/README.md` on why the synthetic hand can never answer the optics question.)

---

## 6 · Evidence available offline — and the conclusion it overturns

Run it: `node scripts/vision-audit.mjs --fixture`

`scripts/fixtures/pinch-trials.json` is the archive the shipping thresholds were fitted to.

**E1 — every recorded trial is at 0.5 m.** There is *no* recorded data at 1.5–2.5 m, the range
the kiosk actually operates in and the range this task is about. The claim in `calibration.ts`
that "two fingertips two centimetres apart, seen from metres away, is a signal the size of the
noise" is a plausible piece of physics that **was never measured**.

**E2 — a closed, held pinch does not close the feature.** Trial #1 is a deliberate pinch held
for six seconds. The ratio stays between **0.702 and 0.799 for the entire recording**, median
0.761, and contains zero dips of any prominence. Two fingertips in contact should drive this
feature toward ~0.1. At half a metre this is not a resolution limit. **The feature refuses to
close, and the prime suspect is the z term.** This is also why `PINCH_ON` had to be dragged up
to 0.74 — a value sitting inside the closed-pinch distribution rather than in the gap below it.

**E3 — the thresholds were never the binding constraint.** The two ten-rep trials contain only
**4 and 7 excursions of any prominence**, and the shipping detector recovers exactly 4 and 7.
Widening the release threshold from 0.88 all the way to 1.2 changes nothing:

```
#3 (10 performed)   OFF=0.88:4  OFF=0.95:4  OFF=1.0:4  OFF=1.1:4  OFF=1.2:4
#4 (10 performed)   OFF=0.88:7  OFF=0.95:7  OFF=1.0:7  OFF=1.1:7  OFF=1.2:7
```

The standing conclusion — *"no threshold pair does better than 4/10 and 7/10, therefore roughly
a third to a half of real pinches leave no trace at this distance with this camera"* — draws an
**optics** verdict from a **feature** measurement, taken at a distance where optics was never in
question. The detector recovered 100% of what the feature contained. What the feature contained
was 4 and 7 events out of 20 performed.

**E4 — the archive cannot say why the other 13 vanished.** Nothing in the file timestamps intent,
so "never performed" and "performed and left no trace" are indistinguishable. That ambiguity is
precisely what the guided run removes.

**E5 — the open-hand reference is tight and far away.** Trial #2: 1.444 ± 0.015. The gap between
the open cloud and the closed cloud is enormous, and `PINCH_ON` sits at the very top edge of the
closed cloud rather than anywhere in that gap. That is worth revisiting **after** the feature
question is settled, not before — the arm-sweep trial (#5) already puts 13% of its frames below
0.74 with no pinch intended, which is what a loose threshold has to survive.

---

## 7 · Instrumentation added

Nothing below runs, renders or costs anything without an explicit URL flag.

| File | What |
|---|---|
| `lib/vision/features.ts` | **new** — all five candidate features, pure, per frame |
| `lib/vision/trace.ts` | **new** — the taxonomy, the layer map, the shared interaction trace |
| `lib/vision/visionLog.ts` | **new** — guided-run metronome, frame recorder, JSON export |
| `components/VisionDebug.tsx` + `.css` | **new** — the `?visionDebug=1` HUD and the run prompt |
| `experiments/roi/RoiExperiment.tsx` + `.css` | **new** — `?exp=roi`, §9 |
| `scripts/vision-audit.mjs` | **new** — offline metrics, and `--fixture` |
| `lib/vision/mediapipe.ts` | `VisionResult.frame` carries the true pixel size |
| `lib/vision/calibration.ts` | `PinchDetector.gates` getter; `MIN_PALM_PX` exported |
| `lib/vision/handPointer.ts` | audit fields on `PointerState`; rejection reporting; recorder tick |
| `components/HandControl.tsx` | interaction-layer trace writes, all behind `VISION_TRACE` |

**Flags.** `?visionDebug=1` HUD · `?visionLog=1` passive recording ·
`?run=pinch|fist|rest&dist=&n=&period=&leadIn=&note=` guided run · `?exp=roi` the ROI
experiment. Existing `?click=`, `?dwell=` untouched.

**Behaviour is unchanged**, and it is checked rather than asserted: `npm run check:pointer`
78/78 and `npm run usertest:home` (75-point coverage grid, both postures, all four seams) both
pass exactly as before.

---

## 8 · The measurement protocol — what still has to be done

At the wall, with the real camera, at **1.0 / 1.5 / 2.0 / 2.5 m**. Per distance:

```
/?enter=1&visionDebug=1&run=pinch&dist=2.0&n=20&note=<camera model>
/?enter=1&visionDebug=1&run=fist&dist=2.0&n=20&note=<camera model>
/?enter=1&visionDebug=1&run=rest&dist=2.0&n=10&note=<camera model>
```

Twelve runs, ~2 minutes each. The screen counts you in, prompts on a 3-second metronome, and
downloads one JSON per run. Then:

```
node scripts/vision-audit.mjs vision-*.json
```

Rules that make the numbers mean something:

- **Aim at a real target** before starting — a row on the home board. A run performed over the
  inert left column measures `CLICK_ON_INERT_TARGET`, not the pinch.
- **The `rest` runs are not optional.** Recall without a false-positive rate is half a result,
  and a rest window is the only place an FPR gets a denominator.
- **Record the camera** in `note=`. Half the open question is which sensor is on the wall.
- One posture per run. Mixing them destroys the conditional structure.
- Stand where a visitor stands, not where it works.

Each attempt yields: timestamp, distance label, camera resolution, hand bbox pixel size,
hand-present frames, the thumb/index trajectory, all five features frame by frame, every FSM
transition, whether the pinch was recognised, whether a click was emitted, and the failure
reason. Metrics out: Hand Recall, Pinch|Hand, Press|Pinch, Click|Press, end-to-end, FPR, and
median/p95 latency both from the cue (includes human reaction) and from the onset of closing
(the system's own share).

---

## 9 · Fixed-scene ROI — the experiment

`/?exp=roi` — records ~8s of the real camera, then replays **that one recording** twice through
one recogniser at a time: full frame, then cropped to a fixed interaction region at native
pixel size.

**The hypothesis.** MediaPipe does not see the 1280-pixel frame. It resizes whatever it is given
to a fixed model input a couple of hundred pixels on a side. So the number that decides
legibility is the palm's size **at the model input** — sensor size × (model input / frame width).
A palm spanning 60px of a 1280-wide frame reaches the model about 10px across. Crop first to a
320-wide region and the *same untouched sensor pixels* arrive about 42px across: four times the
linear detail, no better camera, no lost optics. If the pinch is being lost there, this is the
largest software lever available.

**Two implementation facts worth knowing.**

- `ImageProcessingOptions.regionOfInterest` exists in the API and **throws** for this task. No
  vision task in the pinned `@mediapipe/tasks-vision` build sets the internal
  `supportsRegionOfInterest` flag — verified against the bundle. The crop must go through a
  canvas.
- **The remap is where an ROI optimisation ships as a pointing bug.** Landmarks come back
  normalised to whatever was handed in, so an ROI result is normalised to the *crop*. The
  experiment remaps to full-frame coordinates and then reports **palm-centre agreement** between
  the two passes as its own correctness check: a large number there means the transform is
  wrong and nothing else in the table can be trusted.

The ROI includes the head on purpose. The whole cursor mapping is anchored to the face
(`calibration.ts`), so cropping the face away would trade a readable pinch for an unusable
pointer.

The experiment is not a production change and never runs beside the kiosk — `?exp=` replaces the
app entirely, and it holds one recogniser at a time. The single-instance rule is intact.

---

## 10 · Likely failure stages, ranked

1. **Stage 6, the feature (highest confidence).** E2 is direct evidence: a held, closed pinch at
   0.5 m produces 0.70–0.80, not ~0.1. The z term is the prime suspect and the alternative
   features are already being logged.
2. **Stage 1–2, the camera (unmeasured, plausible, and cheap to rule in or out).** F1 means the
   distance warnings may have been structurally unable to fire. F2 means a dead pipeline can
   report itself healthy. Neither has been observed on the real hardware yet.
3. **Stage 3–4, effective resolution at the model input (untested, large potential).** §9.
4. **Stage 7's settle gate (real, invisible, probably small).** 265ms of decoded-sample time
   after every tracking blink in which no pinch can latch, however deliberate. It was
   never visible anywhere until this audit; now it has a name and a counter.
5. **Stage 10, the drag reclassification (real, bounded).** Already known and already mitigated
   by `canScroll`. The instrumentation now separates "wobbled" from "wobble cost the click", so
   its true size is measurable rather than assumed.
6. **Stage 12, inert targets (real, cheap to find).** A click dispatched onto a plain div is a
   complete success everywhere inside the pipeline and nothing at all in front of the screen.

---

## 11 · Recommended fixes, ranked by expected impact

**None of these should be applied before the §8 runs.** They are ranked by expected impact, and
each names the measurement that would justify it.

| # | Fix | Justified by | Effort |
|---|---|---|---|
| 1 | Switch the pinch feature to `ratioPx` or `ratioWorld2D` | `minRatioPx` separating the recognised from the unrecognised with a larger Cohen's d than `minRatio3` | small — one function, thresholds refitted on the new run data |
| 2 | Crop to a fixed interaction ROI before MediaPipe | `?exp=roi` showing a materially higher palm-at-model figure **and** a deeper `ratio3D` minimum, with palm-centre agreement near zero | medium — plus the coordinate remap, and the face must stay inside the ROI |
| 3 | Fix F1 (the hard-coded 1280) | trivially correct on its own; matters most if the wall camera is not 1280 wide | trivial |
| 4 | Guard F2 (`videoWidth === 0` → an error state, not `running`) | any wall run reporting `0×0` | trivial |
| 5 | Smooth the pinch feature (a 1€ or short median filter on the ratio) | frame-to-frame ratio noise at 2m+ visible in the run files | small |
| 6 | Re-fit `PINCH_ON`/`PINCH_OFF` | **only after 1**, on data from the distance the kiosk actually runs at | small |
| 7 | Pin `hands[0]` to a tracked identity | the HUD's two-hand warning firing during real runs | small |
| 8 | Drop `numHands` to 1, or run the face detector every N frames | measured fps materially below 30 | small |

Note the ordering. Re-fitting thresholds is **sixth**, and only after the feature question is
settled — refitting first is how the last round of tuning produced numbers that were correct for
a feature that does not work.

---

## 12 · Software-fixable vs. camera / optics

**Software-fixable, on the current hardware:**

- The feature not closing on a genuine pinch (E2) — a 0.5 m failure, so not optical.
- Effective resolution at the model input (§9) — a framing decision, not a lens.
- The 1280 assumption, the `videoWidth === 0` blind spot, the unsmoothed feature, the
  `hands[0]` ownership, the frame-rate cost of two models and two hands.
- Every interaction-layer loss: drag reclassification, inert targets, the settle gate.

**Fundamentally optics, and no amount of code recovers it:**

- Sensor pixels on the hand at a given distance. A 1280-wide webcam is usable to ~1.5 m and
  degrades past 2 m (CLAUDE.md §7); 1080p or 4K pushes that to 2–3 m. Cropping redistributes the
  detail that was captured; it cannot create detail that was not.
- Depth from a single view. `world` z is inferred, always, at every distance. If E2's diagnosis
  holds, the fix is not a better estimate of z but **not using z** — which is a software fix to
  an optical impossibility, and the cheapest kind of win available here.
- Motion blur and low light in a corridor, which degrade the landmarks upstream of everything.

**Not yet classifiable** — and this is the honest state of the main question. The distance
curve from 1.0 m to 2.5 m has never been measured. §8 measures it. Until then, "the camera
cannot see a pinch at 2 m" remains a hypothesis, and the recorded evidence we do have points
somewhere else.
