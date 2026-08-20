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
export function SectionLayout({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="min-h-screen" style={{ color: "var(--gt-text-primary)" }}>
      {/* No MENU here. Every section's top-right corner is the Home button now: the home
          page IS the menu, so a drawer that repeats the same five destinations is a second
          door into a room you can already see — and on the pages with a filter bar across the
          top it was fighting for the same strip of screen. */}
      <div className="px-10 pt-8">
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
      <div className="px-10 pb-24 pt-8">{children}</div>
    </div>
  );
}
