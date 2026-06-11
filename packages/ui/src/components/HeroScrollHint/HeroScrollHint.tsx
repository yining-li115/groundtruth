import { useRef } from "react";
import { gsap } from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import { useGSAP } from "@gsap/react";
import { prefersReducedMotion } from "../../lib/motion";
import "./HeroScrollHint.css";

gsap.registerPlugin(ScrollTrigger);

/**
 * A bouncing "<label> ↓" scroll hint. The whole hint bobs to invite a scroll; when a
 * `fadeTrigger` is given it also blurs + fades out across that scroll range (e.g. so it
 * leaves together with a hero headline). Reduced motion: no bounce, no fade.
 */
export interface HeroScrollHintProps {
  /** Text before the arrow (default "Spotlight"). */
  label?: string;
  className?: string;
  /** When set, the hint blurs + fades out over this scroll range (selector or element). */
  fadeTrigger?: string | Element;
  fadeStart?: string;
  fadeEnd?: string;
}

export function HeroScrollHint({
  label = "Spotlight",
  className,
  fadeTrigger,
  fadeStart = "25% top",
  fadeEnd = "70% top",
}: HeroScrollHintProps) {
  const ref = useRef<HTMLDivElement>(null);

  useGSAP(
    () => {
      if (prefersReducedMotion() || !ref.current || !fadeTrigger) return;
      // Resolve a selector trigger ourselves so useGSAP's scope doesn't scope it to this
      // element (where an ancestor like ".hero-pin" isn't found → wrong fallback element).
      const triggerEl =
        typeof fadeTrigger === "string" ? document.querySelector(fadeTrigger) : fadeTrigger;
      if (!triggerEl) return;
      gsap.to(ref.current, {
        opacity: 0,
        filter: "blur(8px)",
        ease: "none",
        scrollTrigger: { trigger: triggerEl, start: fadeStart, end: fadeEnd, scrub: true },
      });
    },
    { scope: ref },
  );

  return (
    <div ref={ref} className={`ui-hint ${className ?? ""}`.trim()}>
      {label}{" "}
      <span className="ui-hint__arrow" aria-hidden>
        ↓
      </span>
    </div>
  );
}
