# User-test harness — a hand you can script

`driver.mjs` drives the real kiosk with a synthetic hand, so the touchless interaction can be
tested the way a person would use it: point somewhere, pinch, see what happened.

The camera is replaced; **nothing else is**. The thresholds, the press debounce, the 1€ filter,
the interaction box, click routing and scrolling all run exactly as they ship. What this
cannot tell you is whether a real camera would have seen the gesture — that half was measured
separately from recordings of a real hand (`scripts/fixtures/pinch-trials.json`, replayed by
`npm run check:pointer`).

## Use

```js
import { openKiosk, sleep } from "./scripts/usertest/driver.mjs";

const k = await openKiosk({ url: "http://localhost:5173/?enter=1&view=people" });
try {
  await k.aimPx(x, y);        // point at a screen pixel, waits for the cursor to arrive
  await k.aim(u, v);          // ...or in unit coordinates
  await k.pinch();            // a full click: close, hold past the debounce, open, settle
  await k.fist();             // the other click posture
  await k.leanScroll(0.25);   // hold and lean down to scroll; negative leans up
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
- **A click takes about a second to land.** `pinch()` already waits for the pixel transition
  that swaps the view; if you check sooner you will see the old page and report a click that
  worked as broken.
- **Aim, then pinch.** `aimPx` waits for the smoothing to arrive. Pinching mid-move makes the
  press count as a drag, and a drag is not a click.
- **Read the page, not your assumptions.** Confirm what an element is with `evaluate` before
  deciding a click failed — plenty of things move, animate in, or only exist in a sub-view.
- Chrome is launched on a throwaway profile and killed by pid. Never `pkill`.
