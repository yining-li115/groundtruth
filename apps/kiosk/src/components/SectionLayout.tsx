import type { ReactNode } from "react";
import { Logo } from "@groundtruth/ui";
import { useKioskStore } from "../state/store";
import { NavMenu } from "./NavMenu";

/** Shared chrome for the four section pages: the same top bar as Home (logo → home,
 *  group name, horizontal nav) plus the section title. Content renders plainly below. */
export function SectionLayout({ title, children }: { title: string; children: ReactNode }) {
  const setView = useKioskStore((s) => s.setView);

  return (
    <div className="min-h-screen px-10 py-8" style={{ color: "var(--gt-text-primary)" }}>
      <header className="flex items-start justify-between gap-8">
        <button
          type="button"
          onClick={() => setView("home")}
          className="flex items-center gap-4 text-left"
          aria-label="Back to home"
        >
          <Logo width={72} height={38} />
          <span
            className="max-w-[22ch] text-sm leading-snug"
            style={{ color: "var(--gt-text-secondary)" }}
          >
            Professorship of Photogrammetry and Remote Sensing
          </span>
        </button>
        <NavMenu />
      </header>

      <h1 className="mt-10 text-5xl font-bold tracking-tight">{title}</h1>

      <div className="mt-8 pb-16">{children}</div>
    </div>
  );
}
