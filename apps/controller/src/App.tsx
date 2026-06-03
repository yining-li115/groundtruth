import { Logo } from "@groundtruth/ui";

/**
 * Phase 0 placeholder. The controller is the phone trackpad: it joins a room via
 * /c/:sessionId, becomes driver or queued, and streams trackpad intents. That arrives
 * in Phase 1. The whole controller UI uses theme.light and honors reduced motion.
 */
export default function App() {
  return (
    <main
      className="min-h-screen flex flex-col items-center justify-center gap-5 px-6 text-center"
      style={{ background: "var(--gt-bg)", color: "var(--gt-text-primary)" }}
    >
      <Logo width={88} height={46} />
      <h1 className="text-2xl font-medium tracking-tight">Groundtruth Controller</h1>
      <p className="text-sm" style={{ color: "var(--gt-text-secondary)" }}>
        Phase 0 scaffold — trackpad coming in Phase 1
      </p>
    </main>
  );
}
