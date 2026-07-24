import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { Logo, BlurScrollText, HeroScrollHint } from "@groundtruth/ui";
import { KioskMenu } from "../components/KioskMenu";
import { SpotlightGallery } from "../components/SpotlightGallery";
import { NewsGrid } from "../components/NewsGrid";
import { useKioskStore } from "../state/store";

import { activePointer } from "../lib/cursorPosition";
import { liquidColors } from "../experiments/liquid/assetColors";

// Lazy — the WebGL scene (three.js + gaussian splats) is heavy; code-split it out of the
// main bundle. The hero is now the real TUM-campus gaussians (same scroll-disperse/orbit
// behaviour as the old procedural point cloud, which stays previewable at /?exp=showcase).
const HeroScene = lazy(() =>
  import("../experiments/showcase/HeroSplat").then((m) => ({ default: m.HeroSplat })),
);
// Cursor-fluid garnish over the hero; also three.js-heavy, so lazy too.
const HeroFluid = lazy(() =>
  import("../experiments/liquid/LiquidEther").then((m) => ({ default: m.LiquidEther })),
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
      {/* Global cursor-fluid — a fixed layer behind ALL content (hero → News) that trails
          the cursor across the whole page. Reduced-motion: skipped. */}
      {!reduced && (
        <div className="home-fluid">
          <Suspense fallback={null}>
            <HeroFluid
              colors={liquidColors}
              mouseForce={19}
              cursorSize={55}
              resolution={0.5}
              autoDemo={false}
              pointerSource={activePointer}
            />
          </Suspense>
        </div>
      )}

      <KioskMenu />

      {/* HERO — full-bleed particle canvas with the text overlaid on top. Scrolling
          disperses the particles rightward and releases into the Spotlight feed below. */}
      <div className="hero-pin">
        <section className="hero-stage">
          <div className="hero-canvas">
            {!reduced && (
              <Suspense fallback={null}>
                <HeroScene progressRef={progress} />
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

      {/* Open Topics (full-bleed depth gallery) removed from the home for now — the component
          and its effect are kept in components/OpenTopicsDepth.tsx (preview /?exp=depth). */}

      {/* debug: showreel jump + the home A/B tab (until the supervisor picks a design) */}
      <div className="fixed bottom-4 left-1/2 z-50 flex -translate-x-1/2 gap-2">
        <button
          type="button"
          onClick={() => {
            const s = useKioskStore.getState();
            s.setEntered(false);
            s.setHasDriver(false);
          }}
          className="rounded-full px-4 py-1.5 text-sm font-semibold"
          style={{ background: "var(--gt-accent)", color: "var(--gt-brand-white)", cursor: "pointer" }}
        >
          → Showreel (debug)
        </button>
        <button
          type="button"
          onClick={() => {
            window.scrollTo(0, 0);
            useKioskStore.getState().setHomeVariant("fly");
          }}
          className="rounded-full px-4 py-1.5 text-sm font-semibold"
          style={{
            background: "var(--gt-surface)",
            color: "var(--gt-text-primary)",
            border: "1px solid var(--gt-border)",
            cursor: "pointer",
          }}
        >
          ⇄ Home B (fly)
        </button>
      </div>
    </div>
  );
}
