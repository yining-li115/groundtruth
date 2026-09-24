import { Logo } from "@groundtruth/ui";
import { navigate } from "../lib/navigate";
import "./sectionHome.css";

/**
 * Shared section chrome: a static identity lockup and a separate way home.
 *
 * `className` belongs to the identity lockup. Every section already reserves and positions that
 * top-left slot, so the chair/TUM mark stays exactly where the page composition put it. It is not
 * interactive: looking like institutional identity and secretly navigating was an unlabelled
 * trap for both a hand cursor and a mouse.
 *
 * Home is the second sibling and owns one stable place across the kiosk: bottom-left. Its broad
 * corner scrim makes the hit area honest by dissolving content below it; visible content is never
 * left underneath an unrelated navigation target.
 */
export function SectionHome({
  tone,
  className = "",
}: {
  tone: "light" | "dark";
  className?: string;
}) {
  return (
    <>
      <div
        className={`section-brand section-brand--${tone}${className ? ` ${className}` : ""}`}
      >
        <span className="section-brand__identity">
          <strong>Professorship of Photogrammetry and Remote Sensing</strong>
          <span>TUM School of Engineering and Design</span>
          <span>Technical University of Munich</span>
        </span>
        <Logo
          variant={tone === "dark" ? "white" : "black"}
          width="4rem"
          height="2.0625rem"
        />
      </div>

      <button
        type="button"
        className={`section-home section-home--${tone}`}
        data-section-home
        data-hover
        aria-label="Back to home"
        onClick={() => navigate("home")}
      >
        <span className="section-home__label">
          <span aria-hidden>←</span>
          Home
        </span>
      </button>
    </>
  );
}
