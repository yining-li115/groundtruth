import type { ReactNode } from "react";
import { useKioskStore, type View } from "../state/store";

/**
 * A titled entry block on the long home page: a heading, an optional "See all →" jump
 * to the matching section page, and a preview of a few items below. Plain structure
 * only — no scroll/entrance effects (those come in Phase 3/4).
 */
export function HomeBlock({
  title,
  seeAll,
  children,
}: {
  title: string;
  seeAll?: View;
  children: ReactNode;
}) {
  const setView = useKioskStore((s) => s.setView);
  return (
    <section className="px-10">
      <div className="flex items-end justify-between gap-4">
        <h2 className="text-3xl font-bold tracking-tight">{title}</h2>
        {seeAll && (
          <button type="button" className="gt-nav-btn" onClick={() => setView(seeAll)}>
            See all →
          </button>
        )}
      </div>
      <div className="mt-5">{children}</div>
    </section>
  );
}
