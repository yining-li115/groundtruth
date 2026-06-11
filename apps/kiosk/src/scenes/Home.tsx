import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { Logo, BlurScrollText, HeroScrollHint } from "@groundtruth/ui";
import { KioskMenu } from "../components/KioskMenu";
import { SpotlightGallery } from "../components/SpotlightGallery";
import { NewsGrid } from "../components/NewsGrid";
import { OpenTopicsDepth } from "../components/OpenTopicsDepth";
import { useKioskStore } from "../state/store";

// Lazy — the WebGL scene (three.js) is heavy; code-split it out of the main bundle.
const HeroScene = lazy(() =>
  import("../experiments/showcase/Scene").then((m) => ({ default: m.Scene })),
);

export function Home() {
  const setHeroOrbitActive = useKioskStore((s) => s.setHeroOrbitActive);

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
            <BlurScrollText
              as="h1"
              className="mt-auto text-7xl font-bold leading-[1.02] tracking-tight md:text-8xl"
              text={"Making Machines\nSee and Think in 3D"}
              mode="out"
              trigger=".hero-pin"
              start="30% top"
              end="80% top"
            />
            <HeroScrollHint className="mt-8" fadeTrigger=".hero-pin" />
          </div>
        </section>
      </div>

      {/* Spotlight — horizontal WebGL parallax gallery, browsed by scrolling on (pinned). */}
      <SpotlightGallery />

      {/* News — 3D staggered scroll grid (Lusion "Featured Work" layout). */}
      <NewsGrid />

      {/* Open Topics — full-bleed depth gallery, browsed by continuing to scroll down (pinned). */}
      <OpenTopicsDepth />
    </div>
  );
}
