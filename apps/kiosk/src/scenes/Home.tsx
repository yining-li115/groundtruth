import { KioskMenu } from "../components/KioskMenu";
import { HomeBlock } from "../components/HomeBlock";
import { useKioskStore } from "../state/store";
import { showreel, viewForId } from "../lib/content";

/** A plain preview card. Clickable (button) when it has a jump target, else static. */
function Card({
  title,
  line,
  onClick,
}: {
  title: string;
  line?: string;
  onClick?: () => void;
}) {
  const inner = (
    <>
      <p className="font-medium">{title}</p>
      {line && (
        <p className="mt-1 text-sm" style={{ color: "var(--gt-text-secondary)" }}>
          {line}
        </p>
      )}
    </>
  );
  return onClick ? (
    <button type="button" className="gt-card w-full text-left" onClick={onClick}>
      {inner}
    </button>
  ) : (
    <div className="gt-card">{inner}</div>
  );
}

/**
 * Interactive home — a scrollable long page (structure only; no effects yet). A sticky
 * top bar holds the section menu, the hero fills the first screen, and entry blocks
 * follow top-to-bottom, each previewing a few items and linking onward.
 */
export function Home() {
  const setView = useKioskStore((s) => s.setView);

  const spotlight = showreel.filter((s) => s.kind === "spotlight");
  const news = showreel.filter((s) => s.kind === "news");
  const openTopics = showreel.filter((s) => s.kind === "open-topic");

  /** A showreel item jumps to the section of its refId, if it resolves. */
  const refJump = (refId?: string) => {
    const v = refId ? viewForId(refId) : null;
    return v ? () => setView(v) : undefined;
  };

  return (
    <div className="min-h-screen" style={{ color: "var(--gt-text-primary)" }}>
      {/* Bubble navigation — MENU toggle floats top-right over the content. */}
      <KioskMenu />

      {/* Hero — first screenful. Group name (top-left) scrolls away with the page. */}
      <section className="flex min-h-[86vh] flex-col px-10 pb-8 pt-8">
        <span className="max-w-[24ch] text-sm font-bold leading-snug">
          Professorship of Photogrammetry and Remote Sensing
        </span>
        <h1 className="mx-auto mt-16 max-w-[20ch] text-center text-6xl font-bold leading-[1.04] tracking-tight md:text-7xl">
          Making Machines See and Think in 3D
        </h1>
        <div
          className="mt-10 flex flex-1 items-center justify-center rounded-[2rem]"
          style={{
            background: "var(--gt-surface)",
            border: "1px solid var(--gt-border)",
            minHeight: "32vh",
          }}
          aria-label="Interactive showcase area"
        >
          <span
            className="text-xs uppercase tracking-[0.22em]"
            style={{ color: "var(--gt-text-secondary)" }}
          >
            interactive showcase · coming soon
          </span>
        </div>
        <p
          className="mt-6 text-center text-[0.7rem] uppercase tracking-[0.2em]"
          style={{ color: "var(--gt-text-secondary)" }}
        >
          Scroll to explore ↓
        </p>
      </section>

      {/* Entry blocks — info feed only. The four sections (Research / Student projects
          / Teaching / People) live in the top menu, so they're not duplicated here. */}
      <div className="flex flex-col gap-16 pb-28">
        <HomeBlock title="Spotlight">
          <div className="grid gap-4">
            {spotlight.map((s) => (
              <Card key={s.id} title={s.title} line={s.blurb} onClick={refJump(s.refId)} />
            ))}
          </div>
        </HomeBlock>

        <HomeBlock title="News">
          <div className="grid gap-4">
            {news.map((s) => (
              <Card key={s.id} title={s.title} line={s.blurb} onClick={refJump(s.refId)} />
            ))}
          </div>
        </HomeBlock>

        <HomeBlock title="Open Topics">
          <div className="grid gap-4">
            {openTopics.map((s) => (
              <Card key={s.id} title={s.title} line={s.blurb} onClick={refJump(s.refId)} />
            ))}
          </div>
        </HomeBlock>
      </div>
    </div>
  );
}
