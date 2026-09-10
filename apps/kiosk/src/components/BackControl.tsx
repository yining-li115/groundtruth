import { useEffect, useState } from "react";
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
 * The rule of the kiosk's chrome is about HEIGHT, not left/right: LEAVING THE PAGE SITS
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
 *
 * ---------------------------------------------------------------------------------------
 * WHY IT IS A CORNER OF LIGHT RATHER THAN A BUTTON
 *
 * It used to be a pill about the size of a mouse button, and the failure was not that it was
 * hard to *reach* — it was hard to *stay on*. Closing a fist visibly moves the whole hand, so
 * the cursor drifts several pixels at exactly the moment of selection; on a small target that
 * drift lands outside and nothing happens, which from in front of the screen is
 * indistinguishable from the camera not seeing you. The fix for a shaky pointer is not better
 * tracking, it is a target big enough that the shake does not matter.
 *
 * So the exit is now a soft quadrant of light bled into the corner of the page — white on the
 * dark sections, the brand violet on the light ones — sized in viewport units so it is the
 * same fraction of a 4K wall as it is of a laptop.
 *
 * THE PART THAT IS NOT OBVIOUS: it paints over the page rather than yielding to it.
 *
 * Two of the sections are full-bleed scrolling lists whose rows run straight through this
 * corner, which is what makes a large target here dangerous rather than merely generous: a
 * visitor aiming at the glow lands on a publication and opens it. That is not "nothing
 * happened", it is the wrong page — the accidental navigation this project holds at zero
 * (`docs/gesture-control-plan.md` §6). Letting the content win instead only inverts the same
 * failure: then the glow is a target that ignores you.
 *
 * So the corner is claimed outright. A scrim in the page's own background colour dissolves
 * whatever scrolls into it and the light sits on top, which makes the rule visible: what is
 * unreadable here is what is unclickable here. The cost is a real constraint on every section —
 * none of them may put a control in this corner — and Research's prev/next pair moved to the
 * bottom centre because of it, which is the kiosk's own chrome rule anyway.
 */

/**
 * Which theme is painted UNDER the corner, so the glow can be the opposite of it.
 *
 * The first version read `data-theme` off the section root once, whenever `view` changed. That
 * is wrong twice: a detail view can be a different theme from the section that owns it, and
 * opening one does not change `view` at all. Selecting a person swaps the whole page to a dark
 * profile while the store still says "people" — so the light section's violet glow stayed, on
 * black, looking nothing like the identical control two clicks away on Projects.
 *
 * So it asks the page instead of remembering an answer: what `data-theme` scope actually
 * applies at the point the glow is drawn? That is the same attribute the token file keys off,
 * so there is still exactly one declaration of what is dark — this just reads it where it
 * matters rather than where it was expected to be.
 *
 * A MutationObserver rather than a poll, because the thing being watched is a React commit:
 * the detail mounts, the corner is a different colour on the very next frame, and the glow has
 * to change with it and not a quarter of a second later.
 */
function useCornerTheme(view: string): "dark" | "light" {
  const [theme, setTheme] = useState<"dark" | "light">("light");
  useEffect(() => {
    const read = () => {
      const x = window.innerWidth * 0.05;
      const y = window.innerHeight * 0.95;
      // Skip our own region (it sits on top and paints the page's colour by design, so it
      // would happily report itself) and the page-transition cover (black cells mid-swap, on
      // a page that may be light either side of it).
      const under = document
        .elementsFromPoint(x, y)
        .find((el) => !el.closest(".bc-home") && !el.closest(".pixel-overlay"));
      setTheme(under?.closest('[data-theme="dark"]') ? "dark" : "light");
    };
    read();

    const main = document.querySelector("main");
    if (!main) return;
    let queued = 0;
    const observer = new MutationObserver(() => {
      // Coalesce: one commit is many mutation records, and this only has to run once per frame.
      if (queued) return;
      queued = requestAnimationFrame(() => {
        queued = 0;
        read();
      });
    });
    observer.observe(main, { childList: true, subtree: true, attributes: true,
      attributeFilter: ["data-theme", "class"] });
    return () => {
      observer.disconnect();
      if (queued) cancelAnimationFrame(queued);
    };
  }, [view]);
  return theme;
}

export function BackControl() {
  const entered = useKioskStore((s) => s.entered);
  const view = useKioskStore((s) => s.view);
  const handPresent = useKioskStore((s) => s.handPresent);
  const theme = useCornerTheme(view);

  // Nothing to go back from on the home view, and nothing to offer when nobody is here.
  if (!entered || view === "home") return null;

  return (
    <div
      className={`bc-home bc-home--${theme} ${handPresent ? "is-on" : ""}`}
      data-hover
      onClick={() => navigate("home")}
    >
      {/* No handler of its own — the click bubbles to the region, so a press on the words and a
          press on the light are the same one event and cannot navigate twice. */}
      <button type="button" className="bc-home__label" aria-label="Back to home">
        <span aria-hidden>←</span> Home
      </button>
    </div>
  );
}
