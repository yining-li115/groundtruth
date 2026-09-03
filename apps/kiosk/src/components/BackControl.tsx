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
 * The rule of the kiosk's chrome is now about HEIGHT, not left/right: LEAVING THE PAGE SITS
 * BOTTOM LEFT, MOVING AROUND INSIDE IT SITS BOTTOM CENTRE. The hand is held up in front of
 * the camera and steered with the whole arm, so anything along the top edge is reached with
 * the arm at its most raised and least steady — the bottom edge is where a tired arm already
 * is. Bottom left rather than bottom centre leaves the cheapest point on the wall, the
 * bottom midpoint, to the in-page prev/next controls.
 *
 * (It has now been in three places: top centre, then top right to stop colliding with the
 * filter tabs several sections run across the top, and now here. Sections must not add a
 * second exit of their own — Projects had one two centimetres away, and a control competing
 * with the control is worse than either alone.)
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
