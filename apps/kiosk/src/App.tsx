import { useEffect } from "react";
import { socket } from "./lib/socket";
import { startSmoothScroll } from "./lib/scroll";
import { SESSION_ID } from "./config";
import { useKioskStore } from "./state/store";
import { Cursor } from "./components/Cursor";
import { KioskQR } from "./components/KioskQR";
import { PixelOverlay } from "./components/PixelOverlay";
import { Home } from "./scenes/Home";
import { HomeFly } from "./scenes/HomeFly";
import { Showreel } from "./scenes/Showreel";
import { ShowreelSplit } from "./experiments/showreel2/ShowreelSplit";
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
      // two competing home designs, live-switchable until the supervisor picks one
      return homeVariant === "fly" ? <HomeFly /> : <Home />;
  }
}

export default function App() {
  const connected = useKioskStore((s) => s.connected);
  const hasDriver = useKioskStore((s) => s.hasDriver);
  const entered = useKioskStore((s) => s.entered);
  const interactive = hasDriver || entered; // a real driver OR a manual "enter" click

  // Start the smooth-scroll + ScrollTrigger loop once for the tab's lifetime.
  useEffect(() => {
    startSmoothScroll();
  }, []);

  useEffect(() => {
    const { setConnected, setHasDriver } = useKioskStore.getState();

    const onConnect = () => {
      setConnected(true);
      socket.emit("kiosk:hello", { sessionId: SESSION_ID });
    };
    const onDisconnect = () => setConnected(false);
    const onDriverChanged = ({ hasDriver }: { hasDriver: boolean }) =>
      setHasDriver(hasDriver);

    socket.on("connect", onConnect);
    socket.on("disconnect", onDisconnect);
    socket.on("room:driverChanged", onDriverChanged);
    if (!socket.connected) socket.connect();

    return () => {
      socket.off("connect", onConnect);
      socket.off("disconnect", onDisconnect);
      socket.off("room:driverChanged", onDriverChanged);
      // Keep this singleton socket connected for the app's lifetime (it closes when the
      // tab does) — only detach listeners. Disconnecting here makes React StrictMode's
      // dev double-mount churn connect→disconnect→connect, which registers the kiosk in
      // the room multiple times (you saw kiosks=2/3 in the relay log).
    };
  }, []);

  return (
    <main className="relative" style={{ background: "var(--gt-bg)" }}>
      {/* Idle landing = the touchless showreel (splat + puzzle). The moment a phone takes the
          token (hasDriver) — or someone clicks "Enter" — we hand over to the website shell. */}
      {interactive ? (
        <CurrentView />
      ) : (
        <ShowreelSplit showQR={false} onEnter={() => useKioskStore.getState().setEntered(true)} />
      )}

      {/* Static QR — always visible so a visitor can take control (architecture §2). */}
      <KioskQR />

      {/* The phone-driven cursor only exists while someone is driving. */}
      {hasDriver && <Cursor />}

      {/* Subtle connection status (kept out of the way). */}
      <div
        className="fixed bottom-4 left-4 flex items-center gap-2 text-[0.7rem]"
        style={{ color: "var(--gt-text-secondary)" }}
      >
        <span
          className="inline-block h-1.5 w-1.5 rounded-full"
          style={{ background: connected ? "var(--gt-accent)" : "var(--gt-border)" }}
        />
        {connected ? `relay · ${SESSION_ID}` : "connecting…"}
      </div>

      {/* Pixel page transition cover — above everything; played on section navigation. */}
      <PixelOverlay />
    </main>
  );
}
