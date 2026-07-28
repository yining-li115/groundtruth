import { lazy, Suspense } from "react";
import { Logo } from "@groundtruth/ui";
import { dark } from "@groundtruth/tokens";

/**
 * Idle showreel — the unattended screen behind the glass (architecture §6).
 *
 * A continuous camera flight through the TUM campus gaussians: it rests on each of the
 * hand-picked viewpoints in `experiments/spark/tour.json`, carries that stop's spotlight
 * card, then flies on to the next and loops. No cuts, and never a frame with empty space
 * in it — every pose was verified to be filled by the model (scripts/build-tour.py).
 *
 * The brand block sits top-left over the flight; the QR lives in App so a visitor can take
 * control from any screen. Hand-tracked navigation — someone walks past, raises a hand and
 * steers the camera themselves — lands on top of this later; the flight is the resting state
 * it will return to.
 */
const CampusFlight = lazy(() =>
  import("../experiments/spark/SparkCampusExperiment").then((m) => ({ default: m.CampusFlight })),
);

export function ShowreelFlight({ onEnter }: { onEnter?: () => void }) {
  return (
    <div className="fixed inset-0 overflow-hidden" style={{ background: dark.bg }}>
      <Suspense fallback={null}>
        <CampusFlight tools={false} autoPlay asset="max" />
      </Suspense>

      {/* Brand, over the flight. White logo on the dark idle backdrop — the one allowed
          recolor (design-system §3). */}
      <div className="pointer-events-none absolute left-10 top-9 flex items-center gap-4">
        <Logo variant="white" width={86} height={45} />
        <div className="text-xs leading-tight" style={{ color: dark.text.primary }}>
          <div className="whitespace-nowrap font-bold">
            Professorship of Photogrammetry and Remote Sensing
          </div>
          <div className="whitespace-nowrap font-bold" style={{ color: dark.text.secondary }}>
            TUM School of Engineering and Design
          </div>
        </div>
      </div>

      {onEnter && (
        <button
          type="button"
          onClick={onEnter}
          className="absolute bottom-8 left-1/2 -translate-x-1/2 rounded-full px-5 py-2 text-sm font-semibold"
          style={{
            background: dark.button.solid.bg,
            color: dark.button.solid.text,
            cursor: "pointer",
          }}
        >
          Enter site (debug)
        </button>
      )}
    </div>
  );
}
