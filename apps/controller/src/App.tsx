import { useCallback, useEffect, useRef, useState } from "react";
import { Logo } from "@groundtruth/ui";
import { TIMING } from "@groundtruth/protocol";
import { socket } from "./lib/socket";
import { parseSessionId } from "./lib/session";
import { useControllerStore } from "./state/store";
import { TrackpadSurface } from "./components/TrackpadSurface";

const SESSION_ID = parseSessionId();

export default function App() {
  const connected = useControllerStore((s) => s.connected);
  const role = useControllerStore((s) => s.role);
  const position = useControllerStore((s) => s.position);
  const total = useControllerStore((s) => s.total);

  /** Whether we want a token at all (false after a voluntary pass, true on rejoin). */
  const intend = useRef(true);
  const lastActivity = useRef(Date.now());
  const [idleLeft, setIdleLeft] = useState(TIMING.IDLE_TIMEOUT_MS / 1000);

  // Connect + wire role/queue events. socket.io reconnects automatically; on every
  // (re)connect we re-send ctrl:join if we still intend to participate (architecture §5).
  useEffect(() => {
    if (!SESSION_ID) return;
    const store = useControllerStore.getState();

    const onConnect = () => {
      store.setConnected(true);
      if (intend.current) socket.emit("ctrl:join", { sessionId: SESSION_ID });
    };
    const onDisconnect = () => store.setConnected(false);
    const onRole = (p: { role: "driver" | "queued"; position?: number }) => {
      store.setRole(p.role);
      if (p.role === "queued" && typeof p.position === "number") {
        store.setQueue(p.position, Math.max(p.position, store.total));
      }
      if (p.role === "driver") lastActivity.current = Date.now();
    };
    const onQueue = (p: { position: number; total: number }) =>
      store.setQueue(p.position, p.total);
    const onYouAreUp = () => {
      store.setRole("driver");
      lastActivity.current = Date.now();
    };

    socket.on("connect", onConnect);
    socket.on("disconnect", onDisconnect);
    socket.on("room:role", onRole);
    socket.on("room:queue", onQueue);
    socket.on("room:youAreUp", onYouAreUp);
    if (!socket.connected) socket.connect();

    return () => {
      socket.off("connect", onConnect);
      socket.off("disconnect", onDisconnect);
      socket.off("room:role", onRole);
      socket.off("room:queue", onQueue);
      socket.off("room:youAreUp", onYouAreUp);
      // Keep this singleton socket connected for the app's lifetime (it closes when the
      // tab does) — only detach listeners. Disconnecting here makes React StrictMode's
      // dev double-mount churn connect→disconnect→connect, which the relay sees as a
      // phantom 2nd controller that lands in the queue behind the first.
    };
  }, []);

  // Heartbeat (connection liveness) only while driving.
  useEffect(() => {
    if (role !== "driver") return;
    const id = setInterval(
      () => socket.emit("ctrl:heartbeat", {}),
      TIMING.HEARTBEAT_INTERVAL_MS,
    );
    return () => clearInterval(id);
  }, [role]);

  // Idle countdown display (the relay enforces the real timeout).
  useEffect(() => {
    if (role !== "driver") {
      setIdleLeft(TIMING.IDLE_TIMEOUT_MS / 1000);
      return;
    }
    const id = setInterval(() => {
      const left = Math.max(0, TIMING.IDLE_TIMEOUT_MS - (Date.now() - lastActivity.current));
      setIdleLeft(Math.ceil(left / 1000));
    }, 500);
    return () => clearInterval(id);
  }, [role]);

  const onActivity = useCallback(() => {
    lastActivity.current = Date.now();
  }, []);

  const onPass = () => {
    socket.emit("ctrl:pass", {});
    intend.current = false;
    useControllerStore.getState().setRole("passed");
  };
  const onRejoin = () => {
    intend.current = true;
    useControllerStore.getState().setRole("connecting");
    if (SESSION_ID) socket.emit("ctrl:join", { sessionId: SESSION_ID });
  };

  return (
    <main className="gt-controller">
      <header className="flex items-center justify-between">
        <Logo width={64} height={33} />
        <span className="flex items-center gap-1.5 text-xs" style={{ color: "var(--gt-text-secondary)" }}>
          <span
            className="inline-block h-1.5 w-1.5 rounded-full"
            style={{ background: connected ? "var(--gt-accent)" : "var(--gt-border)" }}
          />
          {connected ? "connected" : "connecting…"}
        </span>
      </header>

      {!SESSION_ID && (
        <Centered>
          <h1 className="text-xl font-medium">No session</h1>
          <p style={{ color: "var(--gt-text-secondary)" }}>
            Open this page by scanning the QR code on the screen.
          </p>
        </Centered>
      )}

      {SESSION_ID && role === "connecting" && (
        <Centered>
          <p style={{ color: "var(--gt-text-secondary)" }}>Joining room…</p>
        </Centered>
      )}

      {SESSION_ID && role === "queued" && (
        <Centered>
          <h1 className="text-2xl font-medium">You're in the queue</h1>
          <p className="text-5xl font-medium" style={{ color: "var(--gt-accent)" }}>
            {position}
            <span className="text-2xl" style={{ color: "var(--gt-text-secondary)" }}>
              {" "}/ {total}
            </span>
          </p>
          <p style={{ color: "var(--gt-text-secondary)" }}>
            You'll take control automatically when it's your turn.
          </p>
          <p className="text-xs" style={{ color: "var(--gt-text-secondary)" }}>
            (A waiting-room mini-game lands here in Phase 5.)
          </p>
        </Centered>
      )}

      {SESSION_ID && role === "driver" && (
        <>
          <TrackpadSurface onActivity={onActivity} />
          <footer className="flex items-center justify-between gap-4">
            <span className="text-xs" style={{ color: "var(--gt-text-secondary)" }}>
              Idle release in {idleLeft}s
            </span>
            <button type="button" className="gt-btn-outline" onClick={onPass}>
              Pass control
            </button>
          </footer>
        </>
      )}

      {SESSION_ID && role === "passed" && (
        <Centered>
          <h1 className="text-xl font-medium">Control passed</h1>
          <p style={{ color: "var(--gt-text-secondary)" }}>Thanks! Want another turn?</p>
          <button type="button" className="gt-btn-solid" onClick={onRejoin}>
            Rejoin queue
          </button>
        </Centered>
      )}
    </main>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-4 text-center">
      {children}
    </div>
  );
}
