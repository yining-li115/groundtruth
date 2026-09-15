import { lazy, Suspense } from "react";
import { Logo } from "@groundtruth/ui";
import { dark } from "@groundtruth/tokens";
import { useKioskStore } from "../state/store";
import "./showreelFlight.css";

/**
 * Idle showreel — the unattended screen behind the glass (architecture §6).
 *
 * A continuous camera flight through the TUM campus gaussians: it rests on each of the
 * hand-picked viewpoints in `experiments/spark/tour.json`, carries that stop's spotlight
 * card, then flies on to the next and loops. No cuts, and never a frame with empty space
 * in it — every pose was verified to be filled by the model (scripts/build-tour.py).
 *
 * It is also the front door. There used to be a QR code here: scan it, and your phone became
 * the controller that let you into the site. Now the invitation is the visitor's own hand.
 * Nothing appears until a hand is actually tracked — an unattended screen offering a button
 * nobody can press is worse than one that simply plays — and once it is, the way in is a
 * single large target, because a hand-driven cursor is not a mouse and the one thing a first
 * interaction must not do is ask for precision.
 *
 * The flight's own steering comes from the global hand pointer (`handSource="global"`), not
 * from a camera of its own: one pipeline, one set of models.
 *
 * The tour hands the camera over as soon as a hand is seen — not once some grip is
 * discovered. A screen that keeps playing its own loop while somebody is standing in front
 * of it waving reads as a screen that cannot see them, which is the opposite of what this is
 * for. Moving the hand away from centre flies; holding it in the middle stops; and the block
 * of controls at the bottom is marked `data-no-fly` so aiming at the way in doesn't fly the
 * model out from under the cursor.
 */
/** dev has the 147MB file locally; a deployed build only has what git could carry */
const LOCAL_QUALITY = import.meta.env.DEV ? "max" : "mid";

const CampusFlight = lazy(() =>
  import("../experiments/spark/SparkCampusExperiment").then((m) => ({ default: m.CampusFlight })),
);

export function ShowreelFlight({ onEnter }: { onEnter?: () => void }) {
  const handPresent = useKioskStore((s) => s.handPresent);
  const handStatus = useKioskStore((s) => s.handStatus);
  const blind = handStatus === "error";

  return (
    <div className="fixed inset-0 overflow-hidden" style={{ background: dark.bg }}>
      <Suspense fallback={null}>
        <CampusFlight tools={false} autoPlay asset={LOCAL_QUALITY} handControl handSource="global" />
      </Suspense>

      {/* Brand, over the flight. White logo on the dark idle backdrop — the one allowed
          recolor (design-system §3). */}
      <div className="pointer-events-none absolute left-10 top-9 flex items-center gap-4">
        <Logo variant="white" width="5.375rem" height="2.8125rem" />
        <div className="text-xs leading-tight" style={{ color: dark.text.primary }}>
          <div className="whitespace-nowrap font-bold">
            Professorship of Photogrammetry and Remote Sensing
          </div>
          <div className="whitespace-nowrap font-bold" style={{ color: dark.text.secondary }}>
            TUM School of Engineering and Design
          </div>
        </div>
      </div>

      {/* The standing invitation, for a screen nobody has touched. Small, calm, always there:
          the one thing a passer-by has to learn is that the screen can see them.

          Unless the camera is down, in which case it must not stand there asking for gestures
          it has no way of seeing. A showreel that keeps playing is a perfectly respectable
          thing for a wall to be doing; a screen telling people to wave at a dead camera is
          not, and it is how a broken kiosk goes unnoticed for a week. */}
      <div
        className={`sf-invite ${handPresent || blind ? "is-hidden" : ""}`}
        aria-hidden={handPresent || blind}
      >
        <span className="sf-invite__hand">✋</span>
        Raise a hand to control this screen
      </div>

      {/* The way in. Only once a hand is actually being tracked.
          `data-no-fly` marks the whole block as controls rather than scenery: while the
          cursor is over it the camera holds still, so reaching for the button does not fly
          the model out from under it. */}
      <div className={`sf-enter ${handPresent ? "is-on" : ""}`} data-no-fly>
        <button type="button" className="sf-enter__btn" onClick={onEnter} data-hover>
          Enter
          <span className="sf-enter__sub">Explore the group</span>
        </button>
        <p className="sf-enter__how">
          Move your hand left or right to turn · up to fly forward, down to pull back ·
          hold it in the middle to stop
          <br />
          Make a fist (or pinch) to select
        </p>
      </div>
    </div>
  );
}
