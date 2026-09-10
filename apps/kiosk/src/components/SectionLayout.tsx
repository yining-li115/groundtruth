import type { ReactNode } from "react";
import { Logo } from "@groundtruth/ui";
import { navigate } from "../lib/navigate";

/** Shared chrome for the light section pages: the floating tab bar, the same top-left brand
 *  block as the other sections (chair / school / university + TUM logo → home), and the
 *  section title. The brand markup + sizing match Projects/People/Research so it lines up.
 *
 *  The brand block doubles as "back to home". That is a mouse affordance and no use to a hand
 *  pointing from across a corridor, so the actual way back is `BackControl`, mounted globally
 *  in App — only one section ever used this layout, and a control every page needs cannot
 *  depend on which layout a page happened to pick. */
/**
 * How wide the page's content column is, and it is centred.
 *
 * Left-hugged with a fixed cap, the page put its table against the left edge and left the whole
 * right-hand side of the wall empty — read from a corridor that does not look like a layout, it
 * looks like something failed to load. Centred, the same measure reads as a composed page.
 *
 * The three parts each answer a different screen. `1500px` is the floor, so nothing narrower
 * than a laptop changes at all. `68vw` takes over on a genuinely wide display, because a column
 * pinned to 1500px on a 4K wall is a postage stamp in the middle of it. `92vw` is the ceiling,
 * so there is always a margin rather than type running into the bezel.
 */
const MEASURE = "min(92vw, max(1500px, 68vw))";

export function SectionLayout({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="min-h-screen" style={{ color: "var(--gt-text-primary)" }}>
      {/* No MENU here. Every section's top-right corner is the Home button now: the home
          page IS the menu, so a drawer that repeats the same five destinations is a second
          door into a room you can already see — and on the pages with a filter bar across the
          top it was fighting for the same strip of screen. */}
      <div className="px-10 pt-8" style={{ width: MEASURE, marginInline: "auto" }}>
        <button
          type="button"
          onClick={() => navigate("home")}
          aria-label="Back to home"
          className="flex items-center gap-4 text-left"
        >
          <span
            className="flex flex-col"
            style={{ fontSize: "0.72rem", lineHeight: 1.35, color: "var(--gt-text-secondary)" }}
          >
            <span className="font-bold" style={{ color: "var(--gt-text-primary)" }}>
              Professorship of Photogrammetry and Remote Sensing
            </span>
            <span>TUM School of Engineering and Design</span>
            <span>Technical University of Munich</span>
          </span>
          <Logo variant="black" width={64} height={33} />
        </button>
        <h1 className="mt-8 text-5xl font-bold tracking-tight">{title}</h1>
      </div>
      <div className="px-10 pb-24 pt-8" style={{ width: MEASURE, marginInline: "auto" }}>
        {children}
      </div>
    </div>
  );
}
