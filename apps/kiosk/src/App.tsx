import { Logo } from "@groundtruth/ui";
import { TIMING } from "@groundtruth/protocol";

/**
 * Phase 0 placeholder. Proves the foundation wiring end-to-end: tokens (CSS vars),
 * the @groundtruth/ui component library (Logo), and the shared @groundtruth/protocol.
 * Idle showreel + interactive mode arrive in Phases 1–2.
 */
export default function App() {
  return (
    <main
      className="min-h-screen flex flex-col items-center justify-center gap-6 px-8 text-center"
      style={{ background: "var(--gt-bg)", color: "var(--gt-text-primary)" }}
    >
      <Logo width={146} height={76} />
      <h1 className="text-5xl font-medium tracking-tight">Groundtruth</h1>
      <p className="text-lg" style={{ color: "var(--gt-text-secondary)" }}>
        Kiosk · Phase 0 scaffold · idle release after {TIMING.IDLE_TIMEOUT_MS / 1000}s
      </p>
    </main>
  );
}
