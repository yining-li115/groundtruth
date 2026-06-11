import type { ReactNode } from "react";
import { KioskMenu } from "./KioskMenu";
import { navigate } from "../lib/navigate";

/** Shared chrome for the four section pages: the same floating sticky tab bar as Home,
 *  a non-sticky group name (→ home, scrolls away), and the section title. */
export function SectionLayout({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="min-h-screen" style={{ color: "var(--gt-text-primary)" }}>
      <KioskMenu />
      <div className="px-10 pt-8">
        <button
          type="button"
          onClick={() => navigate("home")}
          className="max-w-[24ch] text-left text-sm font-bold leading-snug"
          aria-label="Back to home"
        >
          Professorship of Photogrammetry and Remote Sensing
        </button>
        <h1 className="mt-8 text-5xl font-bold tracking-tight">{title}</h1>
      </div>
      <div className="px-10 pb-24 pt-8">{children}</div>
    </div>
  );
}
