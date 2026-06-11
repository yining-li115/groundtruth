import { createElement, useRef, type ElementType, type ReactNode } from "react";
import { gsap } from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import { useGSAP } from "@gsap/react";
import { prefersReducedMotion } from "../lib/scroll";

/**
 * Scroll-driven blur typography — adapted from Codrops' ScrollBlurTypography (MIT). Each
 * character animates `filter: blur()` per-character with a stagger, scrubbed to scroll
 * position. We swap their `brightness` for `opacity` (our type is black on a light bg, where
 * brightness(0%) would still read as solid black) so it genuinely fades.
 *
 *   mode="in"  — chars start blurred + transparent, sharpen as the element scrolls in.
 *   mode="out" — chars start sharp, blur + fade as the trigger range scrolls past.
 *
 * Built on our Lenis + ScrollTrigger foundation. Reduced motion: renders crisp, no effect.
 */
export function BlurScrollText({
  text,
  as,
  className,
  mode = "in",
  trigger,
  start,
  end,
}: {
  text: string;
  as?: ElementType;
  className?: string;
  mode?: "in" | "out";
  /** ScrollTrigger trigger (selector or element). Defaults to the text element itself. */
  trigger?: string | Element;
  start?: string;
  end?: string;
}) {
  const ref = useRef<HTMLElement>(null);

  useGSAP(
    () => {
      if (prefersReducedMotion || !ref.current) return;
      const chars = ref.current.querySelectorAll<HTMLElement>(".bst-char");
      if (!chars.length) return;

      const sharp = { filter: "blur(0px)", opacity: 1 };
      const soft = { filter: "blur(10px)", opacity: 0 };
      const from = mode === "in" ? soft : sharp;
      const to = mode === "in" ? sharp : soft;

      gsap.fromTo(
        chars,
        { ...from, willChange: "filter, opacity" },
        {
          ...to,
          ease: "none",
          stagger: 0.04,
          scrollTrigger: {
            trigger: trigger ?? ref.current,
            start: start ?? "top bottom-=15%",
            end: end ?? "bottom center+=15%",
            scrub: true,
          },
        },
      );
      return () => ScrollTrigger.getAll().forEach((s) => s.vars.trigger === (trigger ?? ref.current) && s.kill());
    },
    { scope: ref, dependencies: [text, mode] },
  );

  const Tag = (as ?? "span") as ElementType;
  return createElement(Tag, { ref, className }, splitChars(text));
}

/** Split text into per-character spans (inline-block, animatable), honoring \n as line
 *  breaks and keeping each line unbreakable so inline-block chars don't wrap mid-word. */
function splitChars(text: string): ReactNode {
  const lines = text.split("\n");
  return lines.map((line, li) => (
    <span key={li} style={{ whiteSpace: "nowrap" }}>
      {Array.from(line).map((ch, ci) =>
        ch === " " ? (
          <span key={ci}> </span>
        ) : (
          <span key={ci} className="bst-char" style={{ display: "inline-block" }}>
            {ch}
          </span>
        ),
      )}
      {li < lines.length - 1 && <br />}
    </span>
  ));
}
