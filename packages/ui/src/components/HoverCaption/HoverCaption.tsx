import type { ReactNode } from "react";
import "./HoverCaption.css";

/**
 * A media card with a hover-revealed caption — adapted from Codrops' HoverEffectIdeas
 * ("Sadie"). Default is just the media (children); on hover ONLY a gradient rises and the
 * title + description fade in. The figure carries `data-hover` so a custom cursor can drive
 * the effect by toggling `.is-hover` (kiosk phone cursor) in addition to native `:hover`.
 *
 * Media-agnostic: pass an <img>, a <video>, or (as on the kiosk) an invisible placeholder
 * whose real picture is drawn by a WebGL plane behind it.
 */
export interface HoverCaptionProps {
  title: string;
  description?: string;
  /** Extra classes on the figure (e.g. sizing/aspect-ratio from the consumer). */
  className?: string;
  /** The media — rendered behind the caption. */
  children?: ReactNode;
}

export function HoverCaption({ title, description, className, children }: HoverCaptionProps) {
  return (
    <figure className={`ui-hovercap ${className ?? ""}`.trim()} data-hover>
      {children}
      <figcaption className="ui-hovercap__cap">
        <h3 className="ui-hovercap__title">{title}</h3>
        {description && <p className="ui-hovercap__desc">{description}</p>}
      </figcaption>
    </figure>
  );
}
