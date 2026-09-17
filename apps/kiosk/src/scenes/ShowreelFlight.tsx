import {
  Component,
  lazy,
  Suspense,
  useEffect,
  useState,
  type ErrorInfo,
  type ReactNode,
} from "react";
import { Logo } from "@groundtruth/ui";
import { dark } from "@groundtruth/tokens";
import { useKioskStore } from "../state/store";
import {
  flightInput,
  setSceneAvailability as publishSceneAvailability,
  setSceneMode,
  type SceneAvailability,
} from "../lib/vision/flightInput";
import {
  clickGestureInstruction,
  useClickGesture,
} from "../lib/vision/useClickGesture";
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
 * The flight's own steering comes from the global hand pipeline, never a camera of its own.
 * No hand means attract mode: the composed camera tour and its news cards keep cycling. A
 * stable hand immediately freezes that tour and enters Explore; an open hand turns and travels,
 * while UI hover, a closed hand and tracking loss hold the camera. The router still owns
 * exclusivity, so an Enter press can never be interpreted as scene movement as well.
 */
/** Use the deployment asset everywhere so laptop tests measure the product; `?asset=max` is explicit. */
const LOCAL_QUALITY = "mid" as const;

const CampusFlight = lazy(() =>
  import("../experiments/spark/SparkCampusExperiment").then((m) => ({ default: m.CampusFlight })),
);

/** Keep the site entrance alive when a laptop cannot initialise WebGL/Spark or load its chunk. */
class SceneErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  componentDidCatch(error: unknown, info: ErrorInfo): void {
    publishSceneAvailability("failed");
    console.error("[showreel] 3D scene unavailable", error, info.componentStack);
  }

  render(): ReactNode {
    return this.state.failed ? null : this.props.children;
  }
}

export function ShowreelFlight({ onEnter }: { onEnter?: () => void }) {
  const handPresent = useKioskStore((s) => s.handPresent);
  const handStatus = useKioskStore((s) => s.handStatus);
  const blind = handStatus === "error";
  const clickGesture = useClickGesture();
  const clickInstruction = clickGestureInstruction(clickGesture);
  const [sceneAvailability, setSceneAvailability] = useState<SceneAvailability>(
    () => flightInput.availability,
  );

  useEffect(() => {
    // Production has one grammar. The other modes exist only for the Spark authoring tool and
    // tests; do not let a previous dev route leave the public showreel in one of them.
    if (!flightInput.active) setSceneMode("explore");
    const id = window.setInterval(() => {
      if (!flightInput.active && flightInput.mode !== "explore") setSceneMode("explore");
      setSceneAvailability(flightInput.availability);
    }, 100);
    return () => window.clearInterval(id);
  }, []);
  const sceneReady = sceneAvailability === "ready";
  const sceneFailed = sceneAvailability === "failed";
  const showSceneStatus = handPresent || !sceneReady;

  return (
    <div className="fixed inset-0 overflow-hidden" style={{ background: dark.bg }}>
      <SceneErrorBoundary>
        <Suspense fallback={null}>
          <CampusFlight
            tools={false}
            autoPlay
            asset={LOCAL_QUALITY}
            handControl
            visitorPresent={handPresent}
          />
        </Suspense>
      </SceneErrorBoundary>

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
        className={`sf-invite ${handPresent || blind || !sceneReady ? "is-hidden" : ""}`}
        aria-hidden={handPresent || blind || !sceneReady}
      >
        <span className="sf-invite__hand">✋</span>
        Raise a hand to control this screen
      </div>

      {/* One discoverable grammar, not a mode picker: presence takes the showreel out of its
          news tour, while open-hand position controls the camera through the routed Explore
          session. This panel is feedback only and therefore cannot steal the cursor. */}
      <div
        className={`sf-explore ${showSceneStatus ? "is-on" : ""}`}
        aria-live="polite"
        role="status"
      >
        <strong>
          {sceneReady
            ? "Explore the model"
            : sceneFailed
              ? "3D model unavailable"
              : "Loading 3D model"}
        </strong>
        <span>
          {sceneReady
            ? "Move your open hand · left/right to turn · up/down to travel"
            : sceneFailed
              ? handPresent
                ? "The news tour is unavailable · Enter still opens the site"
                : "The news tour is unavailable · Raise a hand to enter the site"
              : handPresent
                ? "Preparing the news tour · Hand control is paused"
                : "Preparing the news tour · Hand control will unlock when ready"}
        </span>
      </div>

      {/* The way in appears once the pointer has a stable owner. It stays a large, ordinary UI
          target; a scene grab can never steal the same fist. */}
      <div className={`sf-enter ${handPresent ? "is-on" : ""}`} data-scene-ui>
        <button type="button" className="sf-enter__btn" onClick={onEnter} data-hover>
          Enter
          <span className="sf-enter__sub">Explore the group</span>
        </button>
        <p className="sf-enter__how">
          Point with an open hand · {clickInstruction.toLowerCase()}, then open to select
          <br />
          {sceneReady
            ? "Keep your hand open to explore · move onto Enter to pause the model"
            : "3D browsing is paused · Enter remains available"}
        </p>
      </div>
    </div>
  );
}
