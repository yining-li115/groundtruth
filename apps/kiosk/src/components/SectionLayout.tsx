import type { ReactNode } from "react";
import { SectionHome } from "./SectionHome";

/** Shared chrome for light reading pages: the institutional lockup stays in its reserved sticky
 *  header row while the explicitly labelled Home target stays fixed at bottom-left. */
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
    <div className="section-layout min-h-screen" style={{ color: "var(--gt-text-primary)" }}>
      <div
        className="section-layout__brandbar px-10"
        style={{ width: MEASURE, marginInline: "auto" }}
      >
        <SectionHome tone="light" />
      </div>
      <div className="px-10" style={{ width: MEASURE, marginInline: "auto" }}>
        <h1 className="mt-8 text-5xl font-bold tracking-tight">{title}</h1>
      </div>
      <div className="px-10 pb-24 pt-8" style={{ width: MEASURE, marginInline: "auto" }}>
        {children}
      </div>
    </div>
  );
}
