# User-test harness — a hand you can script

`driver.mjs` drives the real kiosk with a synthetic hand, so the touchless interaction can be
tested the way a person would use it: point somewhere, close, open, see what happened.

The camera is replaced; **nothing else is**. The thresholds, the press debounce, the 1€ filter,
the interaction box, click routing and scrolling all run exactly as they ship. What this
cannot tell you is whether a real camera would have seen the gesture — that half was measured
separately from recordings of a real hand (`scripts/fixtures/pinch-trials.json`, replayed by
`npm run check:pointer`).

## The tests that live here

- `home-board.mjs` (`npm run usertest:home`) — the home board: a 75-point coverage grid over
  the five rows using the production fist policy, seam agreement (the row that lights must be
  the row that opens), close→open click versus held-fist scroll (including a scroll begun over
  Back), the left column staying inert, and selection surviving the hand leaving. Uses the
  laboratory hand (below): it asks whether the PAGE is right.
- `showreel-enter.mjs` (`npm run usertest:enter`) — Showreel open-hand Explore plus four
  consecutive release-click epochs across Enter, Home, People, Back and Research. It proves a
  held fist never clicks and a natural `None` release clicks exactly once.
- `sweep.mjs` (`npm run usertest:sweep -- --hand shaky --camera far`) — every page and every
  detail view, driven by `hand.mjs`: a hand that sways, trembles and lurches as the fingers
  close, seen through a camera that jitters and drops frames. Separates the failures that feel
  different at the wall — MISSED (the pinch was never read), STRAYED (the click landed on
  something else), INERT (the click landed and nothing happened), TRAPPED/STUCK (no way out of
  a detail), PHANTOM (a click nobody asked for), SILENT (a failure with no feedback).

## Two hands, and why both exist

`driver.mjs` gives you a laboratory hand: it teleports to a coordinate, holds it to the
micrometre and closes its fingers instantly and completely. Everything passes against it, which
is exactly the problem — it cannot see the failures a real arm produces.

`hand.mjs` wraps it in a human one (`HANDS.steady` / `typical` / `shaky` / `timid`) and puts the
camera back in the way (`CAMERAS.none` / `near` / `far`). The difference is not cosmetic: on the
same home row, the laboratory hand clicks 10 times out of 10, while a typical hand at two metres
pinches through 5 times in 12 and a shaky one 2 in 12 — and the same hands' FIST lands 12 in 12.
Anything that claims the touchless interaction works has to say which hand it was measured with.

## Use

```js
import { openKiosk, sleep } from "./scripts/usertest/driver.mjs";

const k = await openKiosk({ url: "http://localhost:5173/?enter=1&view=people" });
try {
  await k.aimPx(x, y);        // point at a screen pixel, waits for the cursor to arrive
  await k.aim(u, v);          // ...or in unit coordinates
  await k.fist();             // production click: close, confirm, relax to None, settle
  await k.pinch();            // optional pinch-policy click
  await k.leanScroll(0.25);   // fist-grab by default; { gesture: "pinch" } overrides it
  await k.handAway();         // take the hand out of shot
  await k.handBack();
  const s = await k.state();  // { present, x, y, pinched, ratio, conf, ... }
  await k.evaluate(`...`);    // arbitrary JS in the page
  k.problems;                 // console errors and exceptions collected so far
} finally {
  await k.close();            // always: it owns a Chrome process
}
```

## Rules that will save you an hour

- **`?enter=1`** skips the showreel and opens the site shell. Without it every page starts on
  the idle screen, because entering is a gesture.
- **A click commits when the hand opens, then the page transition runs.** `fist()` and `pinch()`
  already wait for the pixel transition
  that swaps the view; if you check sooner you will see the old page and report a click that
  worked as broken.
- `usertest:enter` deliberately removes the confirmed closed hand for several camera frames on
  Enter and later page controls. The same pending epoch must resume and click only after a real
  release; `usertest:home` performs the same blink during an active page scroll.
- **Aim, then close and open.** `aimPx` waits for the smoothing to arrive. Closing mid-move makes the
  press count as a drag, and a drag is not a click.
- **Read the page, not your assumptions.** Confirm what an element is with `evaluate` before
  deciding a click failed — plenty of things move, animate in, or only exist in a sub-view.
- Chrome is launched on a throwaway profile and killed by pid. Never `pkill`.
