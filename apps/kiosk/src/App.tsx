import { useEffect } from "react";
import { Logo } from "@groundtruth/ui";
import { socket } from "./lib/socket";
import { SESSION_ID } from "./config";
import { useKioskStore } from "./state/store";
import { Cursor } from "./components/Cursor";
import { KioskQR } from "./components/KioskQR";

export default function App() {
  const connected = useKioskStore((s) => s.connected);
  const hasDriver = useKioskStore((s) => s.hasDriver);

  useEffect(() => {
    const { setConnected, setHasDriver } = useKioskStore.getState();

    const onConnect = () => {
      setConnected(true);
      // (Re)register this room — also restores state after a relay restart (§8).
      socket.emit("kiosk:hello", { sessionId: SESSION_ID });
    };
    const onDisconnect = () => setConnected(false);
    const onDriverChanged = ({ hasDriver }: { hasDriver: boolean }) =>
      setHasDriver(hasDriver);

    socket.on("connect", onConnect);
    socket.on("disconnect", onDisconnect);
    socket.on("room:driverChanged", onDriverChanged);
    socket.connect();

    return () => {
      socket.off("connect", onConnect);
      socket.off("disconnect", onDisconnect);
      socket.off("room:driverChanged", onDriverChanged);
      socket.disconnect();
    };
  }, []);

  return (
    <main
      className="relative min-h-screen flex flex-col items-center justify-center gap-6 px-8 text-center"
      style={{ background: "var(--gt-bg)", color: "var(--gt-text-primary)" }}
    >
      <Logo width={146} height={76} />
      <h1 className="text-5xl font-medium tracking-tight">Groundtruth</h1>
      <p className="text-lg" style={{ color: "var(--gt-text-secondary)" }}>
        {hasDriver
          ? "Interactive — a phone is driving the cursor"
          : "Idle — scan the QR to take control"}
      </p>

      {/* Connection indicator */}
      <div className="absolute left-6 top-6 flex items-center gap-2 text-xs"
           style={{ color: "var(--gt-text-secondary)" }}>
        <span
          className="inline-block h-2 w-2 rounded-full"
          style={{ background: connected ? "var(--gt-accent)" : "var(--gt-border)" }}
        />
        {connected ? `connected · room ${SESSION_ID}` : "connecting…"}
      </div>

      <KioskQR />
      {hasDriver && <Cursor />}
    </main>
  );
}
