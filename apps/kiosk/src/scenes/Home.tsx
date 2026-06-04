import { NavMenu } from "../components/NavMenu";

/**
 * Interactive home — the post-takeover landing (architecture §6). Composition borrows
 * the Lusion post-entry feel (light base, big display headline, one strong accent,
 * generous whitespace, rounded forms) but is built from scratch with our tokens
 * (CLAUDE.md rule 9). The central block is a clean placeholder for a future interactive
 * component — deliberately NOT the showreel.
 */
export function Home() {
  return (
    <div
      className="flex min-h-screen flex-col px-10 py-8"
      style={{ color: "var(--gt-text-primary)" }}
    >
      {/* Top bar: group name (left, bold) · horizontal nav (right). No logo for now. */}
      <header className="flex items-start justify-between gap-8">
        <span className="max-w-[24ch] text-base font-bold leading-snug">
          Professorship of Photogrammetry and Remote Sensing
        </span>
        <NavMenu />
      </header>

      {/* Oversized display headline = the group motto, centered in the upper area */}
      <h1 className="mx-auto mt-14 max-w-[20ch] text-center text-6xl font-bold leading-[1.04] tracking-tight md:text-7xl">
        Making Machines See and Think in 3D
      </h1>

      {/* Central visual area — clean placeholder for a future interactive component */}
      <section
        className="mt-10 flex flex-1 items-center justify-center rounded-[2rem]"
        style={{
          background: "var(--gt-surface)",
          border: "1px solid var(--gt-border)",
          minHeight: "38vh",
        }}
        aria-label="Interactive showcase area"
      >
        <span
          className="text-xs uppercase tracking-[0.22em]"
          style={{ color: "var(--gt-text-secondary)" }}
        >
          interactive showcase · coming soon
        </span>
      </section>

      {/* Bottom control/scroll hint */}
      <footer
        className="mt-6 flex items-center justify-between text-[0.7rem] uppercase tracking-[0.2em]"
        style={{ color: "var(--gt-text-secondary)" }}
      >
        <span aria-hidden>+</span>
        <span>Scan to take control · drag to move · tap to select</span>
        <span aria-hidden>+</span>
      </footer>
    </div>
  );
}
