import { useEffect, useState } from "react";

/**
 * Puzzle accordion — the SHOWREEL-LEFT concept, styled to match the reference video: a centred
 * row of slim, CAPSULE-shaped cases with clear gaps between them. Collapsed, the cards tile a
 * shared cover (the group name); click one and it expands IN PLACE into a rounded-square news
 * panel (others stay slim + dim); click again to reassemble.
 *
 * LAYOUT (from the video): fixed widths, not flex-fill — collapsed cases are a fixed slim width,
 * the active one grows to a square, the row is centred so gaps read as whitespace. Corner radius
 * = half the collapsed width, so the slim cases are true capsules AND the expanded square reads
 * as a nicely-rounded jewel case with one fixed value.
 *
 * PUZZLE MATH: each card's bottom layer is the SAME cover, sized `{N*100}% 100%` and offset per
 * index (`i/(N-1)*100%`) so the slices show the group name across the row. NOTE: with the video's
 * gaps the banner is sliced (not seamless) — that's the video's look. The top (news) layer fades
 * in over the slice when active.
 *
 * Placeholder cover = an inline SVG of the group name; per-news images are picsum. SVG colors are
 * ASSET colors (rule 1 exception). Experiment only — preview at /?exp=puzzle.
 */

export interface NewsItem {
  id: string;
  kind: string;
  title: string;
  blurb: string;
  seed: string; // picsum seed → the card's exclusive image
}

const NEWS: NewsItem[] = [
  {
    id: "n1",
    kind: "Spotlight",
    title: "Making machines see & think in 3D",
    blurb: "Turning pixels and points into an understanding of the world.",
    seed: "pf-spotlight",
  },
  {
    id: "n2",
    kind: "News",
    title: "Best Paper Award at ISPRS 2026",
    blurb: "Regularised mesh reconstruction from fused aerial LiDAR + imagery.",
    seed: "pf-isprs",
  },
  {
    id: "n3",
    kind: "Open position",
    title: "MSc thesis — neural fields for façades",
    blurb: "Neural radiance & signed-distance fields for building reconstruction.",
    seed: "pf-nerf",
  },
  {
    id: "n4",
    kind: "News",
    title: "CuBy small-satellite mission launches",
    blurb: "A multispectral Earth-observation payload for the state of Bavaria.",
    seed: "pf-cuby",
  },
  {
    id: "n5",
    kind: "Spotlight",
    title: "Digital crime-scene twins with AI agents",
    blurb: "Geometrically accurate, photorealistic forensic reconstruction.",
    seed: "pf-scene",
  },
  {
    id: "n6",
    kind: "Open position",
    title: "Autonomous UAV landing-site detection",
    blurb: "A LiDAR-RGB sensor stack + multimodal fusion for aerial perception.",
    seed: "pf-uav",
  },
  {
    id: "n7",
    kind: "Research",
    title: "Photorealistic photogrammetry",
    blurb: "City-scale reconstruction that is both geometrically and radiometrically true.",
    seed: "pf-photoreal",
  },
  {
    id: "n8",
    kind: "Research",
    title: "6D pose for unknown objects",
    blurb: "Category-free pose estimation for grasping and manipulation.",
    seed: "pf-pose",
  },
  {
    id: "n9",
    kind: "Spotlight",
    title: "Holistic 4D scene understanding in the OR",
    blurb: "Modelling the operating room in space and time for surgical data science.",
    seed: "pf-or",
  },
  {
    id: "n10",
    kind: "News",
    title: "Outstanding Reviewer at CVPR 2026",
    blurb: "Recognised again on the programme committees of the main vision venues.",
    seed: "pf-cvpr",
  },
];

export const PUZZLE_NEWS = NEWS;
export const PUZZLE_COVER = "/media/pf-cover.png";
const newsImg = (seed: string) => `https://picsum.photos/seed/${seed}/1200/1400`;

// expo-out easing for a smooth, Lusion-y open/squeeze
const EASE = "cubic-bezier(0.22, 1, 0.36, 1)";
const DUR = 1050; // open/collapse transition — slower, smoother
const DWELL = 4200; // ms each case stays OPEN in auto-play
const CLOSED_GAP = 1300; // ms the row rests fully collapsed (banner shown) between cases

export interface PuzzleRowProps {
  items?: NewsItem[];
  cover?: string;
  /** CSS length for the row height */
  height?: string;
  /** collapsed capsule width, px */
  collapsedW?: number;
  /** CSS length the active case grows to (≈ height → square) */
  activeW?: string;
  /** px gap between cases */
  gap?: number;
  /** px corner radius */
  radius?: number;
  align?: "center" | "start";
  /** auto-cycle through the cases (idle); when false, click to drive */
  autoPlay?: boolean;
}

/**
 * The bare capsule row (no page chrome), so it can be dropped into the standalone experiment OR
 * floated over the splat in the combined showreel. Sizing is all props → the showreel passes a
 * more compact set. Colors from tokens; the covers/news images are content assets.
 */
export function PuzzleRow({
  items = NEWS,
  cover = PUZZLE_COVER,
  height = "min(70vh, 560px)",
  collapsedW = 80,
  activeW = "min(70vh, 560px)",
  gap = 18,
  radius = 26,
  align = "center",
  autoPlay = false,
}: PuzzleRowProps) {
  const [active, setActive] = useState<number | null>(null);
  const n = items.length;

  // auto-play cycle: open case i → hold (DWELL) → collapse to the banner → rest (CLOSED_GAP) →
  // open case i+1 … Toggling autoPlay off hands control back and clears the open case.
  useEffect(() => {
    if (!autoPlay) {
      setActive(null);
      return;
    }
    let idx = 0;
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    const openNext = () => {
      if (!alive) return;
      setActive(idx); // open
      timer = setTimeout(() => {
        if (!alive) return;
        setActive(null); // collapse back to the banner
        timer = setTimeout(() => {
          idx = (idx + 1) % n;
          openNext(); // then open the next one
        }, CLOSED_GAP);
      }, DWELL);
    };
    openNext();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [autoPlay, n]);

  return (
    <div
      className="flex items-center"
      style={{ height, gap: `${gap}px`, justifyContent: align === "start" ? "flex-start" : "center" }}
    >
      {items.map((item, i) => {
        const isActive = active === i;
        const dimmed = active !== null && !isActive;
        return (
          <button
            key={item.id}
            type="button"
            onClick={() => {
              if (!autoPlay) setActive(isActive ? null : i);
            }}
            className="group relative shrink-0 overflow-hidden outline-none"
            style={{
              width: isActive ? activeW : `${collapsedW}px`,
              height: "100%",
              borderRadius: `${radius}px`,
              transition: `width ${DUR}ms ${EASE}`,
              boxShadow: isActive
                ? "0 28px 70px color-mix(in srgb, var(--gt-brand-black) 32%, transparent)"
                : "0 12px 30px color-mix(in srgb, var(--gt-brand-black) 22%, transparent)",
              cursor: "pointer",
            }}
          >
            {/* bottom layer — a slice of the shared cover banner (the puzzle) */}
            <div
              className="absolute inset-0"
              style={{
                backgroundImage: `url("${cover}")`,
                backgroundSize: `${n * 100}% 100%`,
                backgroundPosition: `${(i / (n - 1)) * 100}% center`,
                backgroundRepeat: "no-repeat",
              }}
            />

            {/* dim mask on the non-active cases, to spotlight the open one */}
            <div
              className="pointer-events-none absolute inset-0"
              style={{
                background: "color-mix(in srgb, var(--gt-brand-black) 42%, transparent)",
                opacity: dimmed ? 1 : 0,
                transition: `opacity ${DUR}ms ${EASE}`,
              }}
            />

            {/* top layer — the exclusive news, fades in only when this case is active */}
            <div
              className="absolute inset-0"
              style={{ opacity: isActive ? 1 : 0, transition: `opacity ${DUR}ms ${EASE}` }}
            >
              <div
                className="absolute inset-0"
                style={{
                  backgroundImage: `url(${newsImg(item.seed)})`,
                  backgroundSize: "cover",
                  backgroundPosition: "center",
                }}
              />
              <div
                className="absolute inset-x-0 bottom-0 p-6 text-left"
                style={{
                  background:
                    "linear-gradient(to top, color-mix(in srgb, var(--gt-brand-black) 82%, transparent), transparent)",
                  color: "var(--gt-brand-white)",
                  transform: isActive ? "translateY(0)" : "translateY(14px)",
                  transition: `transform ${DUR}ms ${EASE}`,
                }}
              >
                <div
                  className="text-[0.72rem] uppercase tracking-[0.24em]"
                  style={{ color: "color-mix(in srgb, var(--gt-brand-white) 78%, transparent)" }}
                >
                  {item.kind}
                </div>
                <div className="mt-1.5 text-2xl font-bold leading-tight">{item.title}</div>
                <p className="mt-2 max-w-[34rem] text-sm leading-relaxed opacity-85">{item.blurb}</p>
              </div>
            </div>
          </button>
        );
      })}
    </div>
  );
}

/** Standalone experiment page (/?exp=puzzle) — the row centred on a light page with a header. */
export function PuzzleAccordion() {
  return (
    <div
      className="fixed inset-0 flex flex-col items-center justify-center gap-10 overflow-hidden"
      style={{
        background: "var(--gt-bg)",
        color: "var(--gt-text-primary)",
        fontFamily: "var(--font-sans)",
      }}
    >
      <header className="text-center">
        <div className="text-xs uppercase tracking-[0.3em]" style={{ color: "var(--gt-accent)" }}>
          ( Showreel · News )
        </div>
        <p className="mt-2 text-sm" style={{ color: "var(--gt-text-secondary)" }}>
          click a case to read the story · click again to reassemble the banner
        </p>
      </header>
      <PuzzleRow />
    </div>
  );
}
