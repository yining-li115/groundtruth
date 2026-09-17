import { useEffect } from "react";
import { startSmoothScroll } from "./lib/scroll";
import { useKioskStore } from "./state/store";
import { HandControl } from "./components/HandControl";
import { Calibration } from "./components/Calibration";
import { GestureHint } from "./components/GestureHint";
import { BackControl } from "./components/BackControl";
import { PixelOverlay } from "./components/PixelOverlay";
import { Home } from "./scenes/Home";
import { HomeBoard } from "./scenes/HomeBoard";
import { HomeMenu } from "./scenes/HomeMenu";
import { HomeFly } from "./scenes/HomeFly";
import { ShowreelFlight } from "./scenes/ShowreelFlight";
import { PeopleSection } from "./scenes/PeopleSection";
import { ResearchSection } from "./scenes/ResearchSection";
import { ProjectsSection } from "./scenes/ProjectsSection";
import { PublicationsSection } from "./scenes/PublicationsSection";
import { TeachingSection } from "./scenes/TeachingSection";
import { displaySignature } from "./lib/vision/profileStore";
import {
  cameraSignature,
  onCameraIdentity,
} from "./lib/vision/cameraPairing";

function CurrentView() {
  const view = useKioskStore((s) => s.view);
  const homeVariant = useKioskStore((s) => s.homeVariant);
  switch (view) {
    case "people":
      return <PeopleSection />;
    case "research":
      return <ResearchSection />;
    case "projects":
      return <ProjectsSection />;
    case "publications":
      return <PublicationsSection />;
    case "teaching":
      return <TeachingSection />;
    default:
      // Four home designs, live-switchable until the supervisor picks one. The board is the
      // default; the older three stay reachable with `?home=…` for comparison.
      if (homeVariant === "fly") return <HomeFly />;
      if (homeVariant === "classic") return <Home />;
      if (homeVariant === "menu") return <HomeMenu />;
      return <HomeBoard />;
  }
}

/**
 * The kiosk.
 *
 * Input is the camera and nothing else. There was a whole second app for this — a phone
 * reached by scanning a QR code, talking to a relay server that decided which of several
 * phones held the token — and it is gone from this screen: no code to scan, no queue, no
 * server to keep running. A visitor raises a hand and the screen follows it.
 *
 * That collapses the two modes the kiosk used to have into one honest condition. It shows
 * the idle showreel until somebody chooses to come in, and returns to it by itself once
 * they have gone (`HandControl` watches for that).
 */
export default function App() {
  const entered = useKioskStore((s) => s.entered);
  const calibrated = useKioskStore((s) => s.calibrated);

  // Start the smooth-scroll + ScrollTrigger loop once for the tab's lifetime.
  useEffect(() => {
    startSmoothScroll();
  }, []);

  // A mapping proven with one physical camera/display pairing is never used with another.
  // Camera replacement is published synchronously by the stream owner before its first frame;
  // display moves are less consistently reported by browsers, so they also get a slow poll.
  // Once invalidated, Calibration immediately restores an existing profile for the new pair or
  // measures it if none exists. The router sees `calibrated=false` synchronously and cancels any
  // live click/scroll/scene session before React paints the setup screen.
  useEffect(() => {
    let knownDisplay = displaySignature();
    let knownCamera = cameraSignature();
    const verifyPairing = () => {
      const nextDisplay = displaySignature();
      const nextCamera = cameraSignature();
      const store = useKioskStore.getState();
      // While setup owns input it is authoritative for the current pair. Following it here
      // prevents the first camera publication on startup from immediately reopening setup.
      if (!store.calibrated) {
        knownDisplay = nextDisplay;
        if (nextCamera !== "\u0000") knownCamera = nextCamera;
        return;
      }
      const displayChanged = nextDisplay !== knownDisplay;
      const cameraChanged = nextCamera !== "\u0000" && nextCamera !== knownCamera;
      if (!displayChanged && !cameraChanged) return;
      knownDisplay = nextDisplay;
      if (nextCamera !== "\u0000") knownCamera = nextCamera;
      store.setCalibrated(false);
    };
    const orientation = window.screen?.orientation;
    const offCamera = onCameraIdentity(verifyPairing);
    window.addEventListener("resize", verifyPairing);
    orientation?.addEventListener("change", verifyPairing);
    const timer = window.setInterval(verifyPairing, 750);
    return () => {
      offCamera();
      window.removeEventListener("resize", verifyPairing);
      orientation?.removeEventListener("change", verifyPairing);
      window.clearInterval(timer);
    };
  }, []);

  return (
    <main className="relative" style={{ background: "var(--gt-bg)" }}>
      {/* Before anything else, once per camera/display pairing: measure the room.
          It renders nothing at all when this machine has already been measured, so the wall
          comes up straight into its showreel on every restart after the first. */}
      {!calibrated ? (
        <>
          {/* Calibration owns the screen and the gesture router. In particular, do not load the
              Gaussian scene behind this overlay: it competes with vision for the GPU and used
              to let calibration movements steer an invisible camera. */}
          <div className="fixed inset-0" style={{ background: "var(--gt-bg)" }} aria-hidden />
          <Calibration onDone={() => useKioskStore.getState().setCalibrated(true)} />
        </>
      ) : entered ? (
        <CurrentView />
      ) : (
        <ShowreelFlight onEnter={() => useKioskStore.getState().setEntered(true)} />
      )}

      {/* The only input. Mounted outside the view so the camera survives navigation. */}
      <HandControl />

      {calibrated && (
        <>
          {/* What the hands can do, said once per visitor. */}
          <GestureHint />

          {/* The way home, identical on every section. */}
          <BackControl />

          {/* Pixel page transition cover — above everything; played on section navigation. */}
          <PixelOverlay />
        </>
      )}
    </main>
  );
}
