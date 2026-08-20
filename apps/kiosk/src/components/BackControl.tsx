import { useKioskStore } from "../state/store";
import { navigate } from "../lib/navigate";
import "./backControl.css";

/**
 * The way back, in one place, on every page.
 *
 * Each section already had one — the brand block in its corner, which navigates home when
 * clicked. That works for a mouse and fails for this pointer twice over: it does not look
 * like a control, and it is a thin strip of text to aim a hand at. Worse, an end-to-end pass
 * found that only one of the five sections had ever adopted the shared layout, so what the
 * back affordance looked like depended on which page you happened to be on.
 *
 * A kiosk cannot afford that. Someone who has walked up to a wall needs the exit to be in the
 * same place, the same shape and the same size wherever they are — so it is mounted once, for
 * the whole app, rather than left to each section to remember.
 *
 * Top centre, and that is the whole rule of the kiosk's chrome: TOP CENTRE LEAVES THE PAGE,
 * BOTTOM CENTRE MOVES AROUND INSIDE IT. Corners were the natural place to tuck controls away
 * and the worst place to put them here — a hand is steered by moving a whole arm, so a corner
 * is the most expensive point on the wall to reach and the easiest to overshoot past. The
 * middle of an edge is the cheapest.
 */
export function BackControl() {
  const entered = useKioskStore((s) => s.entered);
  const view = useKioskStore((s) => s.view);
  const handPresent = useKioskStore((s) => s.handPresent);

  // Nothing to go back from on the home view, and nothing to offer when nobody is here.
  if (!entered || view === "home") return null;

  return (
    <button
      type="button"
      className={`bc-back ${handPresent ? "is-on" : ""}`}
      onClick={() => navigate("home")}
      aria-label="Back to home"
    >
      <span aria-hidden>←</span> Home
    </button>
  );
}
