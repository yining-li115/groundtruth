import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { Logo } from "@groundtruth/ui";
import { HomeBlock } from "../components/HomeBlock";
import { KioskMenu } from "../components/KioskMenu";
import { useKioskStore } from "../state/store";
import { showreel, viewForId } from "../lib/content";

// Lazy — the WebGL scene (three.js) is heavy; code-split it out of the main bundle.
const HeroScene = lazy(() =>
  import("../experiments/showcase/Scene").then((m) => ({ default: m.Scene })),
);

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

export function Home() {
  const setView = useKioskStore((s) => s.setView);
  const setHeroOrbitActive = useKioskStore((s) => s.setHeroOrbitActive);

  const spotlight = showreel.filter((s) => s.kind === "spotlight");
  const news = showreel.filter((s) => s.kind === "news");
  const openTopics = showreel.filter((s) => s.kind === "open-topic");
  const refJump = (refId?: string) => {
    const v = refId ? viewForId(refId) : null;
    return v ? () => setView(v) : undefined;
  };

  // particle dispersal progress: 1 = assembled (top), → 0 as you scroll the hero runway.
  const progress = useRef(1);
  const [reduced] = useState(
    () =>
      typeof window !== "undefined" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches,
  );

  useEffect(() => {
    const onScroll = () => {
      const d = Math.min(1, Math.max(0, window.scrollY / (window.innerHeight * 0.8)));
      progress.current = 1 - d; // top assembled → scroll disperses
      // While the hero is still pinned (i.e. not yet scrolled past), a one-finger drag
      // orbits the particles instead of moving the cursor. Disabled in reduced-motion
      // (no scene to rotate). The hero unpins at the same 0.8·vh where progress hits 0.
      setHeroOrbitActive(!reduced && window.scrollY < window.innerHeight * 0.8);
    };
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      window.removeEventListener("scroll", onScroll);
      setHeroOrbitActive(false); // leaving home → cursor behaves normally again
    };
  }, [reduced, setHeroOrbitActive]);

  return (
    <div className="min-h-screen" style={{ color: "var(--gt-text-primary)" }}>
      <KioskMenu />

      {/* HERO — full-bleed particle canvas with the text overlaid on top. Scrolling
          disperses the particles rightward and releases into the Spotlight feed below. */}
      <div className="hero-pin">
        <section className="hero-stage">
          <div className="hero-canvas">
            {!reduced && (
              <Suspense fallback={null}>
                <HeroScene progressRef={progress} mode="home" />
              </Suspense>
            )}
          </div>

          <div className="hero-overlay">
            <div className="flex items-center gap-4">
              <div className="text-xs leading-tight">
                <div className="whitespace-nowrap font-bold">
                  Professorship of Photogrammetry and Remote Sensing
                </div>
                <div
                  className="whitespace-nowrap font-bold"
                  style={{ color: "var(--gt-text-secondary)" }}
                >
                  TUM School of Engineering and Design
                </div>
                <div
                  className="whitespace-nowrap font-bold"
                  style={{ color: "var(--gt-text-secondary)" }}
                >
                  Technical University of Munich
                </div>
              </div>
              <Logo variant="black" width={86} height={45} />
            </div>
            <h1 className="mt-auto text-7xl font-bold leading-[1.02] tracking-tight md:text-8xl">
              Making Machines
              <br />
              See and Think in 3D
            </h1>
            <span
              className="mt-8 text-2xl font-bold tracking-tight"
              style={{ color: "var(--gt-text-secondary)" }}
            >
              Spotlight ↓
            </span>
          </div>
        </section>
      </div>

      {/* Content feed (info only — the four sections live in the menu). */}
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
