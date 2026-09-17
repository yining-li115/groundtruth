/** Pure safety checks for GestureSession/InteractionRouter (`npm run check:interaction`). */
import {
  InteractionRouter,
  type InteractionAction,
  type RouterContext,
  type RouterGestureEdge,
  type RouterHit,
  type RouterSample,
} from "../apps/kiosk/src/lib/vision/interactionRouter";

type Target = { id: string };
type Scroll = { id: string };

let checks = 0;
let failures = 0;
function ok(label: string, value: boolean, detail = ""): void {
  checks += 1;
  if (value) console.log(`  ✓ ${label}`);
  else {
    failures += 1;
    console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

const showreel: RouterContext = { environment: "showreel", sceneReady: true };
const site: RouterContext = { environment: "site", sceneReady: false };
const calibration: RouterContext = { environment: "calibration", sceneReady: false };
const button: Target = { id: "enter" };
const page: Scroll = { id: "page" };

function sample(
  seq: number,
  at: number,
  patch: Partial<RouterSample> = {},
): RouterSample {
  return {
    seq,
    at,
    ownerId: 1,
    sourceFresh: true,
    ownerVisible: true,
    fresh: true,
    freshForMs: 120,
    posture: "open",
    pointer: { x: 0.5, y: 0.5 },
    live: { x: 0.5, y: 0.5 },
    rawHand: { frameX: 0.5, frameY: 0.5, palmSpan: 0.1 },
    hands: [],
    ...patch,
  };
}

function edge(
  type: "press" | "release",
  seq: number,
  at: number,
  patch: Partial<RouterGestureEdge> = {},
): RouterGestureEdge {
  return {
    type,
    seq,
    at,
    ownerId: 1,
    aim: { x: 0.5, y: 0.5 },
    live: { x: 0.5, y: 0.5 },
    rawHand: { frameX: 0.5, frameY: 0.5, palmSpan: 0.1 },
    freshForMs: 120,
    ...patch,
  } as RouterGestureEdge;
}

const sceneHit: RouterHit<Target, Scroll> = {
  clickTarget: null,
  scrollTarget: null,
  canScroll: false,
  scene: true,
};
const buttonHit: RouterHit<Target, Scroll> = {
  clickTarget: button,
  scrollTarget: null,
  canScroll: false,
  scene: false,
};
const scrollHit: RouterHit<Target, Scroll> = {
  clickTarget: null,
  scrollTarget: page,
  canScroll: true,
  scene: false,
};

function actionsOf(
  actions: InteractionAction<Target>[],
  type: InteractionAction<Target>["type"],
): InteractionAction<Target>[] {
  return actions.filter((action) => action.type === type);
}

function prime(
  router: InteractionRouter<Target, Scroll>,
  context: RouterContext,
  seq = 1,
  at = 1_000,
): void {
  router.observe(sample(seq, at), context);
}

console.log("\ninteraction router — exclusive gesture sessions\n");

{
  console.log("calibration owns input exclusively");
  const router = new InteractionRouter<Target, Scroll>();
  prime(router, calibration);
  const a = router.handleEdge(edge("press", 2, 1_010), calibration, buttonHit);
  ok("a press during calibration emits no UI or scene effect", a.length === 0);
  ok("the router remains in CALIBRATION", router.snapshot().kind === "CALIBRATION");

  router.syncContext(showreel, 1_020);
  const closed = sample(2, 1_030, { posture: "closed" });
  router.observe(closed, showreel);
  const leaked = router.handleEdge(edge("press", 2, 1_030), showreel, sceneHit);
  ok("a closed hand cannot leak through when calibration closes", leaked.length === 0);
  router.observe(sample(3, 1_060), showreel);
  ok("a fresh OPEN neutral pose re-arms interaction", router.snapshot().armed);
}

{
  console.log("presence is pointing, not scene authority");
  const router = new InteractionRouter<Target, Scroll>();
  prime(router, showreel);
  ok("an open visible hand is only POINTING", router.snapshot().kind === "POINTING");
  ok("it emitted no scene takeover", !router.snapshot().sessionId);
  router.tick(1_200, showreel);
  ok("an idle pointing sample still loses authority when it becomes stale", !router.snapshot().armed && router.snapshot().kind === "NONE");
  const stalePress = router.handleEdge(edge("press", 2, 1_220), showreel, sceneHit);
  ok("resuming directly closed cannot inherit the old neutral gate", actionsOf(stalePress, "scene-begin").length === 0);

  const router2 = new InteractionRouter<Target, Scroll>();
  prime(router2, showreel);
  router2.handleEdge(
    { ...edge("press", 2, 1_010), type: "cancel", reason: "stale" },
    showreel,
  );
  ok("a source cancel revokes arming even with no active session", !router2.snapshot().armed);
  router2.observe(sample(3, 1_040, { posture: "unknown" }), showreel);
  ok("ambiguous neutral cannot rearm an idle hard-cancel boundary", !router2.snapshot().armed);
  router2.observe(sample(4, 1_070, { posture: "open" }), showreel);
  ok("positive OPEN rearms after an idle hard cancel", router2.snapshot().armed);

  const stalledArm = new InteractionRouter<Target, Scroll>();
  prime(stalledArm, site);
  const pressAfterIdleStall = stalledArm.handleEdge(
    edge("press", 2, 1_400),
    site,
    buttonHit,
    true,
    1_400,
  );
  ok(
    "a press edge cannot bypass an expired idle neutral lease when rAF stalled",
    actionsOf(pressAfterIdleStall, "click").length === 0 &&
      stalledArm.snapshot().sessionId === 0 &&
      !stalledArm.snapshot().armed,
  );

  const slow = new InteractionRouter<Target, Scroll>();
  slow.observe(sample(1, 1_000, { freshForMs: 360 }), showreel);
  slow.handleEdge(edge("press", 2, 1_020, { freshForMs: 360 }), showreel, sceneHit);
  ok(
    "a measured slow-laptop window keeps a live scene session past the old 120ms cutoff",
    slow.tick(1_250, showreel).length === 0 && slow.snapshot().kind === "SCENE_GRAB",
  );
  const slowExpired = slow.tick(1_381, showreel);
  ok(
    "the same bounded adaptive window still cancels when no new result arrives",
    actionsOf(slowExpired, "scene-end").some(
      (action) => action.type === "scene-end" && action.reason === "stale",
    ),
  );

  const delayedConsumer = new InteractionRouter<Target, Scroll>();
  delayedConsumer.observe(sample(1, 1_000, { freshForMs: 415 }), showreel);
  const delayedBegin = delayedConsumer.handleEdge(
    edge("press", 2, 1_020, { freshForMs: 415 }),
    showreel,
    sceneHit,
    true,
    1_400,
  );
  ok(
    "slow inference consumes the capture-age budget instead of starting a second lease",
    actionsOf(delayedBegin, "scene-begin").length === 1 &&
      actionsOf(delayedConsumer.tick(1_436, showreel), "scene-end").some(
        (action) => action.type === "scene-end" && action.reason === "stale",
      ),
  );

  const tooLate = new InteractionRouter<Target, Scroll>();
  tooLate.observe(sample(1, 1_000, { freshForMs: 415 }), showreel);
  const rejectedAfterInference = tooLate.handleEdge(
    edge("press", 2, 1_020, { freshForMs: 415 }),
    showreel,
    sceneHit,
    true,
    1_450,
  );
  ok(
    "a completed inference cannot renew an already expired capture",
    actionsOf(rejectedAfterInference, "scene-begin").length === 0,
  );
}

{
  console.log("a close/open cycle activates a control exactly once");
  const onset = new InteractionRouter<Target, Scroll>();
  prime(onset, showreel);
  onset.observe(sample(2, 1_010, { posture: "closed" }), showreel);
  ok(
    "direct close evidence does not revoke an already neutral-armed pointer",
    onset.snapshot().armed && onset.snapshot().kind === "POINTING",
  );

  const router = new InteractionRouter<Target, Scroll>();
  prime(router, showreel);
  const pressed = router.handleEdge(edge("press", 2, 1_020), showreel, buttonHit);
  ok("closing over a control does not click yet", actionsOf(pressed, "click").length === 0);
  ok(
    "the confirmed close locks one pending UI press",
    router.snapshot().kind === "UI_PRESS" &&
      router.snapshot().clickTarget === button &&
      !router.snapshot().armed,
  );
  const duplicatePress = router.handleEdge(edge("press", 2, 1_020), showreel, buttonHit);
  ok("the same closed epoch cannot create another session", duplicatePress.length === 0);
  router.observe(sample(2, 1_020, { posture: "closed", live: { x: 0.51, y: 0.5 } }), showreel);
  const releaseActions = router.handleEdge(edge("release", 3, 1_060), showreel, undefined, true);
  const click = actionsOf(releaseActions, "click")[0];
  ok("opening commits exactly one click", actionsOf(releaseActions, "click").length === 1);
  ok("the locked press target receives it", click?.type === "click" && click.target === button);
  const repeated = router.handleEdge(edge("release", 3, 1_060), showreel, undefined, true);
  ok("the same release cannot double-click", actionsOf(repeated, "click").length === 0);
  const replayedPress = router.handleEdge(edge("press", 2, 1_020), showreel, buttonHit);
  ok("a pre-release press edge cannot replay after re-arming", replayedPress.length === 0);
}

{
  console.log("natural fist release remains a valid pending click");
  const router = new InteractionRouter<Target, Scroll>();
  prime(router, site);
  router.handleEdge(edge("press", 2, 1_020), site, buttonHit);
  router.observe(sample(2, 1_030, { posture: "closed" }), site);
  router.observe(sample(3, 1_100, { posture: "unknown" }), site);
  router.observe(sample(4, 1_170, { posture: "unknown" }), site);
  router.observe(sample(5, 1_240, { posture: "unknown" }), site);
  ok(
    "the bounded None/unknown release gate keeps the UI press alive and fresh",
    router.snapshot().kind === "UI_PRESS" && router.snapshot().freshAt === 1_240,
  );
  const released = router.handleEdge(edge("release", 6, 1_260), site, undefined, true);
  ok(
    "the natural release commits the pending click exactly once",
    actionsOf(released, "click").length === 1,
  );

  const scroller = new InteractionRouter<Target, Scroll>();
  prime(scroller, site);
  scroller.handleEdge(
    edge("press", 2, 1_020),
    site,
    { ...buttonHit, scrollTarget: page, canScroll: true },
  );
  scroller.observe(
    sample(2, 1_040, { posture: "closed", live: { x: 0.5, y: 0.62 } }),
    site,
  );
  scroller.observe(
    sample(3, 1_100, { posture: "unknown", live: { x: 0.5, y: 0.62 } }),
    site,
  );
  ok(
    "unknown during scroll holds the session but stops its velocity",
    scroller.snapshot().kind === "UI_SCROLL" &&
      scroller.snapshot().scrollDx === 0 &&
      scroller.snapshot().scrollDy === 0,
  );
  const scrollRelease = scroller.handleEdge(
    edge("release", 4, 1_130, { live: { x: 0.5, y: 0.62 } }),
    site,
    undefined,
    true,
  );
  ok("opening after that scroll cannot click", actionsOf(scrollRelease, "click").length === 0);

  const lost = new InteractionRouter<Target, Scroll>();
  prime(lost, site);
  lost.handleEdge(edge("press", 2, 1_020), site, buttonHit);
  const cancelled = lost.observe(
    sample(2, 1_050, { ownerId: null, fresh: false, posture: "unknown" }),
    site,
  );
  const lateRelease = lost.handleEdge(edge("release", 3, 1_070), site, undefined, true);
  ok(
    "hand loss and its late release never complete a pending click",
    actionsOf(cancelled, "click").length === 0 &&
      actionsOf(lateRelease, "click").length === 0 &&
      !lost.snapshot().armed,
  );

  const invalidated = new InteractionRouter<Target, Scroll>();
  prime(invalidated, site);
  invalidated.handleEdge(edge("press", 2, 1_020), site, buttonHit);
  const invalidRelease = invalidated.handleEdge(
    edge("release", 3, 1_060),
    site,
    undefined,
    false,
  );
  ok(
    "a detached, disabled, or covered locked target cannot click on release",
    actionsOf(invalidRelease, "click").length === 0 &&
      invalidated.snapshot().sessionId === 0 &&
      invalidated.snapshot().endReason === "invalid-target",
  );
}

{
  console.log("brief camera dropouts preserve one owned UI transaction");
  const router = new InteractionRouter<Target, Scroll>();
  prime(router, site);
  router.handleEdge(edge("press", 2, 1_020), site, buttonHit);
  router.observe(sample(2, 1_040, { posture: "closed" }), site);

  const blink = router.observe(
    sample(3, 1_073, {
      ownerId: 1,
      fresh: false,
      posture: "unknown",
      rawHand: null,
      hands: [],
    }),
    site,
  );
  ok(
    "one missing result from the reserved owner does not cancel a pending click",
    blink.length === 0 && router.snapshot().kind === "UI_PRESS",
  );

  // HandControl publishes the newest safety sample first, then accepts its same-sequence durable
  // release edge exactly once. This keeps the recovery path compatible with sample-first routing.
  router.observe(sample(4, 1_106, { posture: "open" }), site);
  const recoveredRelease = router.handleEdge(
    edge("release", 4, 1_106),
    site,
    undefined,
    true,
    1_106,
  );
  ok(
    "a fresh same-owner release immediately after that blink commits once",
    actionsOf(recoveredRelease, "click").length === 1,
  );

  const scroller = new InteractionRouter<Target, Scroll>();
  prime(scroller, site);
  scroller.handleEdge(edge("press", 2, 1_020), site, scrollHit);
  scroller.observe(
    sample(2, 1_040, { posture: "closed", live: { x: 0.5, y: 0.64 } }),
    site,
  );
  ok("the owned transaction became a scroll before the blink", scroller.snapshot().kind === "UI_SCROLL");
  scroller.observe(
    sample(3, 1_073, {
      ownerId: 1,
      fresh: false,
      posture: "unknown",
      rawHand: null,
      hands: [],
    }),
    site,
  );
  ok(
    "a blink pauses scroll velocity without destroying the scroll session",
    scroller.snapshot().kind === "UI_SCROLL" &&
      scroller.snapshot().scrollDx === 0 &&
      scroller.snapshot().scrollDy === 0,
  );
  scroller.observe(
    sample(4, 1_106, { posture: "open", live: { x: 0.5, y: 0.64 } }),
    site,
  );
  const scrollRelease = scroller.handleEdge(
    edge("release", 4, 1_106, { live: { x: 0.5, y: 0.64 } }),
    site,
    undefined,
    true,
    1_106,
  );
  ok(
    "recovery after a paused scroll still cannot click",
    actionsOf(scrollRelease, "click").length === 0 &&
      scroller.snapshot().endReason === "moved",
  );
}

{
  console.log("camera grace has a hard deadline and identity boundary");
  const expired = new InteractionRouter<Target, Scroll>();
  prime(expired, site);
  expired.handleEdge(edge("press", 2, 1_020), site, buttonHit);
  expired.observe(
    sample(3, 1_100, {
      ownerId: 1,
      fresh: false,
      posture: "unknown",
      rawHand: null,
      hands: [],
    }),
    site,
  );
  const afterDeadline = expired.handleEdge(
    edge("release", 4, 1_401),
    site,
    undefined,
    true,
    1_401,
  );
  ok(
    "a release arriving after the continuity deadline cannot race the watchdog",
    actionsOf(afterDeadline, "click").length === 0 &&
      expired.snapshot().sessionId === 0 &&
      !expired.snapshot().armed &&
      expired.snapshot().endReason === "stale",
  );

  const changed = new InteractionRouter<Target, Scroll>();
  prime(changed, site);
  changed.handleEdge(edge("press", 2, 1_020), site, buttonHit);
  changed.observe(sample(3, 1_050, { ownerId: 2, posture: "closed" }), site);
  const foreignRelease = changed.handleEdge(
    edge("release", 4, 1_080, { ownerId: 1 }),
    site,
    undefined,
    true,
    1_080,
  );
  ok(
    "a replacement owner cannot inherit or release the previous owner's click",
    actionsOf(foreignRelease, "click").length === 0 && !changed.snapshot().armed,
  );
  changed.observe(sample(5, 1_110, { ownerId: 2, posture: "unknown" }), site);
  ok("ambiguous neutral cannot rearm after an owner boundary", !changed.snapshot().armed);
  changed.observe(sample(6, 1_140, { ownerId: 2, posture: "open" }), site);
  ok("positive open evidence rearms after that hard boundary", changed.snapshot().armed);

  const batchedBoundary = new InteractionRouter<Target, Scroll>();
  prime(batchedBoundary, site);
  batchedBoundary.handleEdge(edge("press", 2, 1_020), site, buttonHit);
  batchedBoundary.observe(sample(2, 1_020, { posture: "closed" }), site);
  // The release was produced first by the camera, but the newest sample says that owner is gone.
  // Production observes this hard boundary before draining the durable edge batch.
  batchedBoundary.observe(
    sample(4, 1_070, {
      ownerId: null,
      ownerVisible: false,
      fresh: false,
      posture: "unknown",
      rawHand: null,
      hands: [],
    }),
    site,
  );
  const invalidatedBatchRelease = batchedBoundary.handleEdge(
    edge("release", 3, 1_060),
    site,
    undefined,
    true,
    1_070,
  );
  ok(
    "a newer owner-loss boundary invalidates an older release in the same display batch",
    actionsOf(invalidatedBatchRelease, "click").length === 0 &&
      batchedBoundary.snapshot().sessionId === 0 &&
      !batchedBoundary.snapshot().armed,
  );

  const sameSeqWatchdog = new InteractionRouter<Target, Scroll>();
  prime(sameSeqWatchdog, site);
  sameSeqWatchdog.handleEdge(edge("press", 2, 1_020), site, scrollHit);
  sameSeqWatchdog.observe(
    sample(2, 1_040, { posture: "closed", live: { x: 0.5, y: 0.64 } }),
    site,
  );
  sameSeqWatchdog.handleEdge(
    { ...edge("press", 2, 1_040), type: "cancel", reason: "stale" },
    site,
  );
  ok(
    "a source-watchdog cancel can override a consumed press on the same camera seq",
    sameSeqWatchdog.snapshot().sessionId === 0 &&
      sameSeqWatchdog.snapshot().kind === "POINTING" &&
      !sameSeqWatchdog.snapshot().armed &&
      sameSeqWatchdog.snapshot().endReason === "stale",
  );
}

{
  console.log("a visible neutral hand can arm without a textbook Open_Palm label");
  const router = new InteractionRouter<Target, Scroll>();
  router.observe(sample(1, 1_000, { posture: "unknown" }), site);
  ok(
    "fresh same-owner non-closed evidence arms the first gesture",
    router.snapshot().armed && router.snapshot().kind === "POINTING",
  );
  const press = router.handleEdge(edge("press", 2, 1_050), site, buttonHit, true, 1_050);
  ok(
    "a fist after that neutral None frame is not silently discarded",
    press.length === 0 && router.snapshot().kind === "UI_PRESS",
  );
}

{
  console.log("adaptive freshness and tracking grace have separate jobs");
  const loaded = new InteractionRouter<Target, Scroll>();
  loaded.observe(sample(1, 1_000, { freshForMs: 800 }), site);
  loaded.handleEdge(
    edge("press", 2, 1_010, { freshForMs: 800 }),
    site,
    buttonHit,
    true,
    1_420,
  );
  const betweenLoadedResults = loaded.tick(1_850, site);
  ok(
    "a loaded 420ms inference cadence does not cancel UI_PRESS between consecutive results",
    betweenLoadedResults.length === 0 && loaded.snapshot().kind === "UI_PRESS",
  );
  loaded.observe(
    sample(2, 1_430, { posture: "closed", freshForMs: 800 }),
    site,
  );
  ok("the next loaded result renews that same transaction", loaded.snapshot().kind === "UI_PRESS");

  const delayedRecovery = new InteractionRouter<Target, Scroll>();
  delayedRecovery.observe(sample(1, 1_000, { freshForMs: 800 }), site);
  delayedRecovery.handleEdge(
    edge("press", 2, 1_010, { freshForMs: 800 }),
    site,
    buttonHit,
    true,
    1_420,
  );
  const delayedRelease = delayedRecovery.handleEdge(
    edge("release", 3, 2_100, { freshForMs: 800 }),
    site,
    undefined,
    true,
    2_500,
  );
  ok(
    "a fresh recovery release captured inside grace survives later display consumption",
    actionsOf(delayedRelease, "click").length === 1,
  );

  const pausedScroll = new InteractionRouter<Target, Scroll>();
  prime(pausedScroll, site);
  pausedScroll.handleEdge(edge("press", 2, 1_020), site, scrollHit);
  pausedScroll.observe(
    sample(2, 1_050, { posture: "closed", live: { x: 0.5, y: 0.64 } }),
    site,
  );
  pausedScroll.tick(1_200, site);
  ok(
    "an unobserved decoder stall pauses scroll at freshness expiry but keeps its grace session",
    pausedScroll.snapshot().kind === "UI_SCROLL" &&
      pausedScroll.snapshot().scrollDx === 0 &&
      pausedScroll.snapshot().scrollDy === 0,
  );
}

{
  console.log("controls and scrolling have an unambiguous spatial split");
  const router = new InteractionRouter<Target, Scroll>();
  prime(router, site);
  const control = router.handleEdge(
    edge("press", 2, 1_020),
    site,
    { ...buttonHit, scrollTarget: page, canScroll: true },
  );
  ok("a control over a scrollable page stays pending while held", actionsOf(control, "click").length === 0 && router.snapshot().kind === "UI_PRESS");
  router.observe(sample(2, 1_020, { posture: "closed", live: { x: 0.6, y: 0.5 } }), site);
  ok("moving from a control can become page scroll", router.snapshot().kind === "UI_SCROLL");
  const release = router.handleEdge(edge("release", 3, 1_060), site, undefined, true);
  ok("releasing that scroll never activates the original control", actionsOf(release, "click").length === 0);

  const router2 = new InteractionRouter<Target, Scroll>();
  prime(router2, site);
  router2.handleEdge(edge("press", 2, 1_020), site, scrollHit);
  router2.observe(sample(2, 1_020, { posture: "closed", live: { x: 0.5, y: 0.62 } }), site);
  const s = router2.snapshot();
  ok("the same motion over a scrollable surface becomes UI_SCROLL", s.kind === "UI_SCROLL");
  ok("the scroll recipient is locked", s.scrollTarget === page);
  const scrollRelease = router2.handleEdge(edge("release", 3, 1_060), site, buttonHit);
  ok("releasing a scroll never clicks what is underneath", actionsOf(scrollRelease, "click").length === 0);

  const router3 = new InteractionRouter<Target, Scroll>();
  prime(router3, site);
  router3.handleEdge(edge("press", 2, 1_020), site, scrollHit);
  // No observe call in between: this models camera press+release edges queued before the next
  // display rAF, the exact case that one-frame booleans used to lose.
  const fastRelease = router3.handleEdge(
    edge("release", 3, 1_050, { live: { x: 0.5, y: 0.7 } }),
    site,
  );
  ok("a fast scroll wholly between display frames cannot become a click", actionsOf(fastRelease, "click").length === 0);
  ok("the skipped motion is still recorded as moved", router3.snapshot().endReason === "moved");

  const router4 = new InteractionRouter<Target, Scroll>();
  prime(router4, site);
  router4.handleEdge(edge("press", 2, 1_020), site, scrollHit);
  router4.observe(
    sample(2, 1_030, { posture: "closed", live: { x: 0.52, y: 0.52 } }),
    site,
  );
  ok(
    "diagonal noise below both scroll-axis deadzones remains a pending content grab",
    router4.snapshot().kind === "UI_PRESS" && !router4.snapshot().moved,
  );
  const diagonalRelease = router4.handleEdge(
    edge("release", 3, 1_060, { live: { x: 0.52, y: 0.52 } }),
    site,
  );
  ok(
    "releasing a content grab never invents a click",
    actionsOf(diagonalRelease, "click").length === 0,
  );

  const router5 = new InteractionRouter<Target, Scroll>();
  prime(router5, site);
  router5.handleEdge(
    edge("press", 2, 1_020),
    site,
    { ...buttonHit, scrollTarget: page, canScroll: true },
  );
  router5.observe(
    sample(2, 1_030, { posture: "closed", live: { x: 0.52, y: 0.52 } }),
    site,
  );
  const quietRelease = router5.handleEdge(
    edge("release", 3, 1_060, { live: { x: 0.52, y: 0.52 } }),
    site,
    undefined,
    true,
  );
  ok(
    "sub-deadzone wobble on a control still clicks only when opened",
    actionsOf(quietRelease, "click").length === 1,
  );

  const stalled = new InteractionRouter<Target, Scroll>();
  prime(stalled, site);
  const latePress = stalled.handleEdge(edge("press", 2, 1_020), site, buttonHit, true, 2_020);
  const lateRelease = stalled.handleEdge(edge("release", 3, 1_060), site, undefined, true, 2_020);
  ok(
    "a complete tap queued across a one-second display stall is discarded",
    actionsOf(latePress, "click").length === 0 &&
      actionsOf(lateRelease, "click").length === 0 &&
      !stalled.snapshot().armed,
  );
}

{
  console.log("scene grab is relative, owned, and fresh");
  const router = new InteractionRouter<Target, Scroll>();
  prime(router, showreel);
  const begin = router.handleEdge(edge("press", 2, 1_020), showreel, sceneHit);
  ok("a fist on ready scene begins exactly one scene session", actionsOf(begin, "scene-begin").length === 1);
  const session = router.snapshot().sessionId;
  const moved = sample(2, 1_050, {
    posture: "closed",
    rawHand: { frameX: 0.45, frameY: 0.4, palmSpan: 0.1 },
  });
  const updates = router.observe(moved, showreel);
  const update = actionsOf(updates, "scene-update")[0];
  ok(
    "camera-frame left/up becomes visitor-right/up delta",
    update?.type === "scene-update" && Math.abs(update.dx - 0.5) < 1e-9 && Math.abs(update.dy - 1) < 1e-9,
  );
  ok("scene updates keep the original session", update?.type === "scene-update" && update.sessionId === session);
  ok("moving over UI cannot reroute a scene grab", router.snapshot().kind === "SCENE_GRAB");
  const duplicate = router.observe(moved, showreel);
  ok("the same camera seq is never integrated twice", actionsOf(duplicate, "scene-update").length === 0);
  const ended = router.handleEdge(edge("release", 3, 1_090), showreel, buttonHit);
  const end = actionsOf(ended, "scene-end")[0];
  ok("an explicit open ends the scene normally", end?.type === "scene-end" && end.reason === "released");
  ok("scene release cannot click UI", actionsOf(ended, "click").length === 0);
}

{
  console.log("every uncertain end cancels, never commits");
  const reasons = [
    "hand-lost",
    "stale",
    "owner-changed",
    "timeout",
    "mode-changed",
    "unknown-posture",
    "unmount",
  ] as const;
  for (const reason of reasons) {
    const router = new InteractionRouter<Target, Scroll>();
    prime(router, showreel);
    router.handleEdge(edge("press", 2, 1_020), showreel, sceneHit);
    let a: InteractionAction<Target>[];
    if (reason === "stale") a = router.tick(1_200, showreel);
    else if (reason === "owner-changed") {
      a = router.observe(sample(2, 1_030, { ownerId: 2, posture: "closed" }), showreel);
    } else if (reason === "unknown-posture") {
      a = router.observe(sample(2, 1_030, { posture: "unknown" }), showreel);
    } else if (reason === "mode-changed") {
      a = router.syncContext(site, 1_030);
    } else if (reason === "unmount") {
      a = router.dispose(1_030);
    } else {
      a = router.handleEdge(
        {
          ...edge("press", 3, 1_030),
          type: "cancel",
          reason,
        },
        showreel,
      );
    }
    const ended = actionsOf(a, "scene-end");
    ok(`${reason} ends scene once`, ended.length === 1);
    ok(`${reason} produces no click`, actionsOf(a, "click").length === 0);
    ok(`${reason} disarms until neutral OPEN`, !router.snapshot().armed);
  }
}

{
  console.log("ready, owner, and target gates fail closed");
  const router = new InteractionRouter<Target, Scroll>();
  const loading = { ...showreel, sceneReady: false };
  prime(router, loading);
  const refused = router.handleEdge(edge("press", 2, 1_020), loading, sceneHit);
  ok("a scene that is not ready cannot capture a camera pose", actionsOf(refused, "scene-begin").length === 0);
  const readyWithoutOpen = router.syncContext(showreel, 1_030);
  ok("becoming ready does not reuse the old closed gesture", actionsOf(readyWithoutOpen, "scene-begin").length === 0);

  const router2 = new InteractionRouter<Target, Scroll>();
  prime(router2, site);
  const invalid = router2.handleEdge(edge("press", 2, 1_020), site, buttonHit, false);
  ok("a detached/disabled target is not clicked on press", actionsOf(invalid, "click").length === 0);
  ok("an invalid target cannot create a held UI session", router2.snapshot().kind === "POINTING" && !router2.snapshot().sessionId);

  const router3 = new InteractionRouter<Target, Scroll>();
  prime(router3, showreel);
  router3.handleEdge(edge("press", 2, 1_020), showreel, sceneHit);
  const foreign = router3.handleEdge(edge("release", 3, 1_040, { ownerId: 2 }), showreel);
  ok("another hand cannot release the active owner's scene", foreign.length === 0 && router3.snapshot().kind === "SCENE_GRAB");

  const router4 = new InteractionRouter<Target, Scroll>();
  prime(router4, site);
  const invalidPress = router4.handleEdge(
    edge("press", 2, 1_020, { aim: { x: Number.NaN, y: 0.5 } }),
    site,
    buttonHit,
  );
  ok("non-finite coordinates cannot start a UI session", invalidPress.length === 0 && !router4.snapshot().sessionId);

  const router5 = new InteractionRouter<Target, Scroll>();
  prime(router5, site);
  router5.handleEdge(edge("press", 2, 1_020), site, buttonHit);
  const invalidRelease = router5.handleEdge(
    edge("release", 3, 1_040, { live: { x: Number.NaN, y: 0.5 } }),
    site,
  );
  ok("a corrupt release cancels instead of clicking", actionsOf(invalidRelease, "click").length === 0 && !router5.snapshot().armed);
}

console.log(`\n${checks - failures}/${checks} passed`);
if (failures) process.exitCode = 1;
