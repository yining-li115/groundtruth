import { useEffect, useRef, useState } from "react";
import { Logo } from "@groundtruth/ui";
import { KioskMenu } from "../components/KioskMenu";
import { useKioskStore } from "../state/store";
import { ContentCard, runwayVh } from "../experiments/fly/FlyExperiment";
import {
  PAGES,
  STOP_COUNT,
  useFlySplatStage,
} from "../experiments/fly/FlySplatExperiment";
import { STOP_ACCENTS } from "../experiments/fly/assetColors";

/**
 * Home variant B — the campus-splat fly-through as the REAL interactive home
 * (candidate design; the classic point-cloud home stays as variant A, switchable via
 * the debug tab both scenes show at the bottom). Full shell functionality is kept:
 * StaggeredMenu navigation, brand block + logo, the global QR/cursor from App.
 *
 * The opening frame mirrors the classic hero exactly: campus large centre-right, the
 * full slogan (two lines, always fully lit) bottom-left.
 */
export function HomeFly() {
  const smRef = useRef(0);
  const cardRefs = useRef<(HTMLDivElement | null)[]>([]);
  const stageRef = useRef<HTMLDivElement>(null);
  const [reduced] = useState(
    () =>
      typeof window !== "undefined" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches,
  );

  // arriving from the other home (possibly mid-scroll) → start the story at the top
  useEffect(() => {
    window.scrollTo(0, 0);
    smRef.current = 0;
  }, []);

  useFlySplatStage(stageRef, smRef, cardRefs, !reduced);

  const switchHome = () => {
    window.scrollTo(0, 0);
    useKioskStore.getState().setHomeVariant("classic");
  };

  return (
    <div className="min-h-screen" style={{ color: "var(--gt-text-primary)" }}>
      {/* the splat world (fixed, behind everything) */}
      {!reduced && <div ref={stageRef} className="fixed inset-0" />}

      <KioskMenu />

      {/* brand block — same as the classic home hero, fixed so it survives the scroll */}
      <div className="fixed left-8 top-8 z-10 flex items-center gap-4">
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

      {/* the story cards; card 0 is the always-fully-lit slogan */}
      {PAGES.map((c, i) => (
        <ContentCard
          key={c.title}
          item={c}
          accent={STOP_ACCENTS[i]!}
          big={i === 0}
          staticCard={i === 0}
          refCb={(el) => {
            cardRefs.current[i] = el;
          }}
        />
      ))}

      {/* scroll runway (reduced motion: plain readable column instead) */}
      {!reduced ? (
        <div style={{ height: `${runwayVh(STOP_COUNT)}vh` }} />
      ) : (
        <div className="px-[8vw] py-40">
          {PAGES.map((c, i) => (
            <article key={c.title} className="mb-24 max-w-3xl">
              {c.tag && (
                <div
                  className="mb-3 text-xs font-bold uppercase tracking-widest"
                  style={{ color: STOP_ACCENTS[i] }}
                >
                  {c.tag}
                </div>
              )}
              <h2 className="text-5xl font-bold tracking-tight">{c.title}</h2>
              {c.body && (
                <p className="mt-5 text-lg" style={{ color: "var(--gt-text-secondary)" }}>
                  {c.body}
                </p>
              )}
            </article>
          ))}
        </div>
      )}

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
          onClick={switchHome}
          className="rounded-full px-4 py-1.5 text-sm font-semibold"
          style={{
            background: "var(--gt-surface)",
            color: "var(--gt-text-primary)",
            border: "1px solid var(--gt-border)",
            cursor: "pointer",
          }}
        >
          ⇄ Home A (classic)
        </button>
      </div>
    </div>
  );
}
