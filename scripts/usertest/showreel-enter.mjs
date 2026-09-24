#!/usr/bin/env node
/**
 * Browser regression for the kiosk's front door.
 *
 * This drives the production pointer/router/DOM path across the showreel's two mutually
 * exclusive interactions:
 *
 *   - an open hand over the scene owns Explore;
 *   - UI hover or a closed hand releases Explore;
 *   - a confirmed fist on Enter stays pending until the hand opens, then clicks exactly once;
 *   - a confirmed fist on scene background never becomes a legacy scene grab.
 *   - relaxing that fist to MediaPipe's ordinary `None` result releases the gesture, so the
 *     same visitor can click Home, Back, and another Home row in consecutive epochs.
 *
 * Scene readiness is injected through the real flight-input module. The regression therefore
 * exercises HandControl without waiting for the multi-hundred-megabyte Gaussian asset or a
 * usable WebGL renderer on CI/laptops.
 *
 * Run with the kiosk dev server up:
 *   npm run usertest:enter
 */
import { openKiosk, sleep } from "./driver.mjs";

const BASE = (process.env.KIOSK_URL ?? "http://localhost:5173").replace(/\/+$/, "");
let failures = 0;

function ok(label, condition, detail = "") {
  if (condition) console.log(`  ✓ ${label}`);
  else {
    failures += 1;
    console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

async function waitUntil(read, predicate, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  let value;
  do {
    value = await read();
    if (predicate(value)) return value;
    await sleep(50);
  } while (Date.now() < deadline);
  return value;
}

const flightSnapshot = (kiosk) =>
  kiosk.evaluate(`(() => {
    const f = window.__flightTest?.flightInput;
    return f ? {
      availability: f.availability,
      ready: f.ready,
      active: f.active,
      sessionId: f.sessionId,
      ownerId: f.ownerId,
      seq: f.seq,
      mode: f.mode,
      dx: f.dx,
      dy: f.dy,
      endReason: f.endReason,
    } : null;
  })()`);

const viewSnapshot = (kiosk) =>
  kiosk.evaluate(`(() => ({
    home: !!document.querySelector(".hb"),
    people: !!document.querySelector(".ppl"),
    research: !!document.querySelector(".rsl"),
  }))()`);

/**
 * Close on an already-instrumented control, prove that holding never clicks it, then open
 * exactly as MediaPipe commonly reports a relaxed hand: `None`, not a textbook `Open_Palm`
 * pose. That release — and only that release — must commit the click.
 */
async function fistClickEpoch(kiosk, target, counter, label) {
  await kiosk.aimPx(target.x, target.y);
  const hit = await kiosk.evaluate(`(() => {
    const s = window.__handState();
    return document.elementFromPoint(s.x * innerWidth, s.y * innerHeight)?.closest(
      ${JSON.stringify(target.selector)}
    ) !== null;
  })()`);
  ok(`${label} is under the stabilized cursor`, hit === true);

  await kiosk.evaluate(`window.__handSim.label = "Closed_Fist"`);
  const heldReady = await waitUntil(
    () =>
      kiosk.evaluate(`({
        clicks: window.__siteGestureClicks?.[${JSON.stringify(counter)}] ?? 0,
        stillClosed: window.__handState().pinched,
        phase: window.__handState().phase,
      })`),
    (state) => state?.stillClosed === true,
    2500,
  );
  ok(
    `${label} is pending, not clicked, when the fist is confirmed`,
    heldReady?.clicks === 0 && heldReady?.stillClosed === true,
    JSON.stringify(heldReady),
  );

  // The pose most likely to disappear from MediaPipe is the closed fist itself. Reproduce a
  // two-to-four-frame landmark blink after confirmation; the same reserved owner and pending
  // target must survive, while the gap itself may neither release nor click.
  await kiosk.evaluate(`window.__handSim.present = false`);
  await sleep(90);
  const duringBlink = await kiosk.evaluate(`({
    clicks: window.__siteGestureClicks?.[${JSON.stringify(counter)}] ?? 0,
    pinched: window.__handState().pinched,
    ownerId: window.__handState().owner.id,
    ownerVisible: window.__handState().owner.visible,
  })`);
  ok(
    `${label} survives a brief closed-hand tracking blink without clicking`,
    duringBlink?.clicks === 0 &&
      duringBlink?.pinched === true &&
      duringBlink?.ownerId !== null &&
      duringBlink?.ownerVisible === false,
    JSON.stringify(duringBlink),
  );
  await kiosk.evaluate(`window.__handSim.present = true`);
  const afterBlink = await waitUntil(
    () =>
      kiosk.evaluate(`({
        clicks: window.__siteGestureClicks?.[${JSON.stringify(counter)}] ?? 0,
        pinched: window.__handState().pinched,
        ownerVisible: window.__handState().owner.visible,
      })`),
    (state) => state?.ownerVisible === true && state?.pinched === true,
    1500,
  );
  ok(
    `${label} resumes the same held epoch after the blink`,
    afterBlink?.clicks === 0 && afterBlink?.pinched === true,
    JSON.stringify(afterBlink),
  );

  await sleep(500);
  const held = await kiosk.evaluate(
    `window.__siteGestureClicks?.[${JSON.stringify(counter)}] ?? 0`,
  );
  ok(`${label} remains unclicked while the fist stays held`, held === 0, `${held}`);

  await kiosk.evaluate(`window.__handSim.label = "None"`);
  const released = await waitUntil(
    () =>
      kiosk.evaluate(`({
        clicks: window.__siteGestureClicks?.[${JSON.stringify(counter)}] ?? 0,
        pinched: window.__handState().pinched,
        phase: window.__handState().phase,
      })`),
    (state) => state?.pinched === false && state?.clicks === 1,
    3000,
  );
  ok(
    `${label} clicks exactly once when a stable neutral hand releases it`,
    released?.clicks === 1 && released?.pinched === false,
    JSON.stringify(released),
  );
  await sleep(250);
  const afterRelease = await kiosk.evaluate(
    `window.__siteGestureClicks?.[${JSON.stringify(counter)}] ?? 0`,
  );
  ok(`${label} cannot repeat after release`, afterRelease === 1, `${afterRelease}`);
}

const kiosk = await openKiosk({ url: `${BASE}/?calibrate=0&click=fist` });
try {
  // StrictMode/source restart deliberately starts disarmed. Supply the same positive neutral
  // evidence calibration requires before testing a new close epoch.
  await kiosk.evaluate(`window.__handSim.label = "Open_Palm"`);
  await sleep(350);

  // Keep readiness independent of the renderer. HandControl exposes the exact singleton it
  // imported only when this DEV synthetic hand is active; using that hook avoids a second Vite
  // module instance after HMR. The short-lived lease restores readiness on the next frame.
  const hasFlightHook = await waitUntil(
    () => kiosk.evaluate(`!!window.__flightTest?.flightInput`),
    Boolean,
  );
  if (!hasFlightHook) throw new Error("HandControl did not expose its synthetic-hand flight hook");
  await kiosk.evaluate(`(() => {
    const input = window.__flightTest.flightInput;
    clearInterval(window.__flightReadyLease);
    window.__flightReadyLease = setInterval(() => {
      input.availability = "ready";
      input.ready = true;
    }, 16);
    input.availability = "ready";
    input.ready = true;
  })()`);

  const background = await kiosk.evaluate(`(() => {
    const blocked = '[data-hover], button, a, [role="button"], input, label, [data-no-fly], [data-scene-ui]';
    const candidates = [
      { u: 0.76, v: 0.44 },
      { u: 0.68, v: 0.32 },
      { u: 0.84, v: 0.58 },
      { u: 0.32, v: 0.38 },
    ];
    return candidates.find(({ u, v }) => {
      const el = document.elementFromPoint(u * innerWidth, v * innerHeight);
      return el && !el.closest(blocked);
    }) ?? null;
  })()`);
  ok("showreel exposes non-UI scene background", !!background);

  let firstExplore = null;
  if (background) {
    await kiosk.aim(background.u, background.v);
    firstExplore = await waitUntil(
      () => flightSnapshot(kiosk),
      (f) => f?.active === true && f?.mode === "explore" && f?.ownerId !== null,
    );
    ok(
      "an open hand over scene background takes Explore authority",
      firstExplore?.active === true && firstExplore?.mode === "explore",
      JSON.stringify(firstExplore),
    );

    // Move within background and prove that this is a live presence session rather than merely
    // the attract-mode pause. A new camera sample must advance and publish non-zero axes.
    const moved = {
      u: Math.max(0.1, background.u - 0.12),
      v: Math.max(0.1, background.v - 0.09),
    };
    await kiosk.aim(moved.u, moved.v);
    const updatedExplore = await waitUntil(
      () => flightSnapshot(kiosk),
      (f) =>
        f?.active === true &&
        f?.sessionId === firstExplore?.sessionId &&
        f?.seq > (firstExplore?.seq ?? Number.MAX_SAFE_INTEGER) &&
        (Math.abs(f?.dx ?? 0) > 0.05 || Math.abs(f?.dy ?? 0) > 0.05),
    );
    ok(
      "open-hand movement updates the same Explore session",
      updatedExplore?.active === true &&
        updatedExplore?.sessionId === firstExplore?.sessionId &&
        updatedExplore?.seq > firstExplore?.seq,
      JSON.stringify(updatedExplore),
    );
  }

  const target = await kiosk.evaluate(`(() => {
    const button = document.querySelector(".sf-enter__btn");
    if (!button) return null;
    const r = button.getBoundingClientRect();
    window.__enterGestureClicks = 0;
    button.addEventListener("click", () => { window.__enterGestureClicks += 1; }, true);
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  })()`);
  ok("Enter is available to a tracked hand", !!target);

  if (target && background) {
    // Merely moving an open hand onto UI must synchronously give camera authority back. It must
    // not require a fist or a release and must not click the button.
    await kiosk.aimPx(target.x, target.y);
    const uiHold = await waitUntil(
      () => flightSnapshot(kiosk),
      (f) => f?.active === false,
    );
    const hoverClicks = await kiosk.evaluate(`window.__enterGestureClicks`);
    ok(
      "open-hand UI hover cancels Explore",
      uiHold?.active === false && uiHold?.endReason === "cancelled",
      JSON.stringify(uiHold),
    );
    ok("UI hover alone never clicks Enter", hoverClicks === 0, `${hoverClicks}`);

    // Leaving UI with the same open hand is a fresh presence takeover. Closing on background
    // must cancel it and stay inactive after the confirmation threshold: this catches any
    // accidental reintroduction of Router SCENE_GRAB beneath the presence grammar.
    await kiosk.aim(background.u, background.v);
    const resumedExplore = await waitUntil(
      () => flightSnapshot(kiosk),
      (f) => f?.active === true && f?.sessionId > (firstExplore?.sessionId ?? 0),
    );
    ok(
      "leaving UI resumes Explore as a new session",
      resumedExplore?.active === true &&
        resumedExplore?.sessionId > (firstExplore?.sessionId ?? 0),
      JSON.stringify(resumedExplore),
    );

    await kiosk.evaluate(`window.__handSim.label = "Closed_Fist"`);
    const backgroundFist = await waitUntil(
      () =>
        kiosk.evaluate(`(() => {
          const f = window.__flightTest?.flightInput;
          const s = window.__handState();
          return f ? {
            availability: f.availability,
            ready: f.ready,
            active: f.active,
            sessionId: f.sessionId,
            ownerId: f.ownerId,
            endReason: f.endReason,
            confirmedClosed: s.pinched,
            phase: s.phase,
          } : null;
        })()`),
      (state) => state?.confirmedClosed === true && state?.active === false,
      2500,
    );
    ok(
      "a confirmed background fist cannot start SCENE_GRAB",
      backgroundFist?.confirmedClosed === true &&
        backgroundFist?.active === false &&
        backgroundFist?.ownerId === null,
      JSON.stringify(backgroundFist),
    );
    ok(
      "a background fist does not click Enter",
      (await kiosk.evaluate(`window.__enterGestureClicks`)) === 0,
    );
  }

  if (target) {
    // Re-open to arm a new close epoch and move onto Enter. Confirmation must only lock the
    // target; the natural open below is what commits it.
    await kiosk.evaluate(`window.__handSim.label = "Open_Palm"`);
    await sleep(350);
    await kiosk.aimPx(target.x, target.y);
    const hit = await kiosk.evaluate(`(() => {
      const s = window.__handState();
      return document.elementFromPoint(s.x * innerWidth, s.y * innerHeight)?.closest(".sf-enter__btn") !== null;
    })()`);
    ok("the stabilized cursor hit-tests to Enter", hit === true);

    await kiosk.evaluate(`window.__handSim.label = "Closed_Fist"`);
    const enterHeld = await waitUntil(
      () =>
        kiosk.evaluate(`({
          clicks: window.__enterGestureClicks,
          entered: !document.querySelector(".sf-enter__btn") && !!document.querySelector(".hb"),
          stillClosed: window.__handState().pinched,
          phase: window.__handState().phase,
        })`),
      (state) => state?.stillClosed === true,
      2500,
    );
    ok(
      "the completed fist leaves Enter pending until release",
      enterHeld?.clicks === 0 && enterHeld?.entered === false && enterHeld?.stillClosed === true,
      JSON.stringify(enterHeld),
    );

    await kiosk.evaluate(`window.__handSim.present = false`);
    await sleep(90);
    const enterBlink = await kiosk.evaluate(`({
      clicks: window.__enterGestureClicks,
      pinched: window.__handState().pinched,
      ownerId: window.__handState().owner.id,
      ownerVisible: window.__handState().owner.visible,
      entered: !document.querySelector(".sf-enter__btn"),
    })`);
    ok(
      "Enter remains pending through a brief closed-fist tracking blink",
      enterBlink?.clicks === 0 &&
        enterBlink?.pinched === true &&
        enterBlink?.ownerId !== null &&
        enterBlink?.ownerVisible === false &&
        enterBlink?.entered === false,
      JSON.stringify(enterBlink),
    );
    await kiosk.evaluate(`window.__handSim.present = true`);
    const enterRecovered = await waitUntil(
      () => kiosk.evaluate(`({
        clicks: window.__enterGestureClicks,
        pinched: window.__handState().pinched,
        ownerVisible: window.__handState().owner.visible,
      })`),
      (state) => state?.ownerVisible === true && state?.pinched === true,
      1500,
    );
    ok(
      "Enter resumes the same held epoch after tracking returns",
      enterRecovered?.clicks === 0 && enterRecovered?.pinched === true,
      JSON.stringify(enterRecovered),
    );

    await sleep(500);
    const heldClicks = await kiosk.evaluate(`window.__enterGestureClicks`);
    ok("continuing to hold cannot activate Enter", heldClicks === 0, `${heldClicks}`);

    // Do not help the interaction by manufacturing an Open_Palm label here. A real visitor
    // normally just relaxes their fist, and MediaPipe commonly reports that as `None`. This is
    // the exact transition that once left HandPointer's first activePress stuck forever even
    // though its public posture and the router had both returned to open/armed.
    await kiosk.evaluate(`window.__handSim.label = "None"`);
    const releasedEnter = await waitUntil(
      () =>
        kiosk.evaluate(`({
          clicks: window.__enterGestureClicks,
          pinched: window.__handState().pinched,
          phase: window.__handState().phase,
        })`),
      (state) => state?.pinched === false && state?.clicks === 1,
      3000,
    );
    ok(
      "Enter clicks exactly once on a stable neutral-hand release",
      releasedEnter?.clicks === 1 && releasedEnter?.pinched === false,
      JSON.stringify(releasedEnter),
    );

    const enteredView = await waitUntil(
      () => viewSnapshot(kiosk),
      (view) => view?.home === true,
      3000,
    );
    ok("the Enter release opens Home", enteredView?.home === true, JSON.stringify(enteredView));

    await kiosk.evaluate(`window.__siteGestureClicks = { people: 0, home: 0, research: 0 }`);

    // Second fist: the first site-page control after Enter. This is the regression's essential
    // seam — testing Enter alone cannot reveal that its active press poisoned every later page.
    const peopleTarget = await kiosk.evaluate(`(() => {
      const button = document.querySelectorAll(".hb-row")[1];
      if (!button) return null;
      button.addEventListener("click", () => { window.__siteGestureClicks.people += 1; }, true);
      const r = button.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2, selector: ".hb-row" };
    })()`);
    ok("Home exposes the People row after Enter", !!peopleTarget);
    if (peopleTarget) {
      await fistClickEpoch(kiosk, peopleTarget, "people", "the second fist on Home / People");
      const peopleView = await waitUntil(
        () => viewSnapshot(kiosk),
        (view) => view?.people === true,
      );
      ok("the second fist opens People", peopleView?.people === true, JSON.stringify(peopleView));
    }

    // Third fist: the section header's persistent Home control must work after the same release.
    const homeTarget = await kiosk.evaluate(`(() => {
      const button = document.querySelector("[data-section-home]");
      if (!button) return null;
      button.addEventListener("click", () => { window.__siteGestureClicks.home += 1; }, true);
      const r = button.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2, selector: "[data-section-home]" };
    })()`);
    ok("People exposes the shared Home header", !!homeTarget);
    if (homeTarget) {
      await fistClickEpoch(kiosk, homeTarget, "home", "the third fist on Home");
      const homeView = await waitUntil(
        () => viewSnapshot(kiosk),
        (view) => view?.home === true,
      );
      ok("the third fist returns Home", homeView?.home === true, JSON.stringify(homeView));
    }

    // Fourth fist: prove this was not a one-off recovery. A second Home destination must still
    // accept another close → neutral epoch after navigating away and back.
    const researchTarget = await kiosk.evaluate(`(() => {
      const button = document.querySelectorAll(".hb-row")[0];
      if (!button) return null;
      button.addEventListener("click", () => { window.__siteGestureClicks.research += 1; }, true);
      const r = button.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2, selector: ".hb-row" };
    })()`);
    ok("Home is interactive again after returning from People", !!researchTarget);
    if (researchTarget) {
      await fistClickEpoch(kiosk, researchTarget, "research", "the fourth fist on Home / Research");
      const researchView = await waitUntil(
        () => viewSnapshot(kiosk),
        (view) => view?.research === true,
      );
      ok(
        "the fourth consecutive fist opens Research",
        researchView?.research === true,
        JSON.stringify(researchView),
      );
    }
  }
} finally {
  await kiosk.evaluate(`clearInterval(window.__flightReadyLease)`).catch(() => {});
  await kiosk.close();
}

console.log(`\n${failures ? "FAILED" : "showreel Enter gesture passed"}\n`);
if (failures) process.exitCode = 1;
