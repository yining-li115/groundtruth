import { useEffect } from "react";
import { startSmoothScroll } from "./lib/scroll";
import { useKioskStore } from "./state/store";
import { HandControl } from "./components/HandControl";
import { GestureHint } from "./components/GestureHint";
import { BackControl } from "./components/BackControl";
import { PixelOverlay } from "./components/PixelOverlay";
import { Home } from "./scenes/Home";
import { HomeBoard } from "./scenes/HomeBoard";
import { HomeMenu } from "./scenes/HomeMenu";
import { HomeFly } from "./scenes/HomeFly";
import { Showreel } from "./scenes/Showreel";
import { ShowreelFlight } from "./scenes/ShowreelFlight";
import { PeopleSection } from "./scenes/PeopleSection";
import { ResearchSection } from "./scenes/ResearchSection";
import { ProjectsSection } from "./scenes/ProjectsSection";
import { PublicationsSection } from "./scenes/PublicationsSection";
import { TeachingSection } from "./scenes/TeachingSection";

function CurrentView() {
  const view = useKioskStore((s) => s.view);
  const homeVariant = useKioskStore((s) => s.homeVariant);
  switch (view) {
    case "showreel":
      return <Showreel />;
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

  // Start the smooth-scroll + ScrollTrigger loop once for the tab's lifetime.
  useEffect(() => {
    startSmoothScroll();
  }, []);

  return (
    <main className="relative" style={{ background: "var(--gt-bg)" }}>
      {entered ? (
        <CurrentView />
      ) : (
        <ShowreelFlight onEnter={() => useKioskStore.getState().setEntered(true)} />
      )}

      {/* The only input. Mounted outside the view so the camera survives navigation. */}
      <HandControl />

      {/* What the hands can do, said once per visitor. */}
      <GestureHint />

      {/* The way home, identical on every section. */}
      <BackControl />

      {/* Pixel page transition cover — above everything; played on section navigation. */}
      <PixelOverlay />
    </main>
  );
}
