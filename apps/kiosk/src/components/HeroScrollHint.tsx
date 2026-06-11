import { useRef } from "react";
import { gsap } from "gsap";
import { useGSAP } from "@gsap/react";
import { prefersReducedMotion } from "../lib/scroll";

/**
 * The "Spotlight ↓" scroll hint on the hero. The arrow bounces while the visitor lingers on
 * the particle hero (a "scroll down" invitation), and the whole hint blurs + fades out as
 * they scroll — in the same range as the motto, so they leave together. Reduced motion: no
 * bounce, no fade (the hint just stays put).
 */
export function HeroScrollHint({ className }: { className?: string }) {
  const ref = useRef<HTMLDivElement>(null);

  useGSAP(
    () => {
      if (prefersReducedMotion || !ref.current) return;
      gsap.to(ref.current, {
        opacity: 0,
        filter: "blur(8px)",
        ease: "none",
        scrollTrigger: {
          trigger: ".hero-pin",
          start: "25% top",
          end: "70% top",
          scrub: true,
        },
      });
    },
    { scope: ref },
  );

  return (
    <div ref={ref} className={`hero-hint ${className ?? ""}`}>
      Spotlight <span className="hero-hint__arrow" aria-hidden>↓</span>
    </div>
  );
}
