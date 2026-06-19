import type { ReactNode } from "react";
import { Logo } from "@groundtruth/ui";
import { KioskMenu } from "./KioskMenu";
import { navigate } from "../lib/navigate";

/** Shared chrome for the light section pages: the floating tab bar, the same top-left brand
 *  block as the other sections (chair / school / university + TUM logo → home), and the
 *  section title. The brand markup + sizing match Projects/People/Research so it lines up. */
export function SectionLayout({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="min-h-screen" style={{ color: "var(--gt-text-primary)" }}>
      <KioskMenu />
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
