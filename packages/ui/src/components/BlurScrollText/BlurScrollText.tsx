import { createElement, useRef, type ElementType, type ReactNode } from "react";
import { gsap } from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import { useGSAP } from "@gsap/react";
import { prefersReducedMotion } from "../../lib/motion";

gsap.registerPlugin(ScrollTrigger);

/**
 * Scroll-driven blur typography — adapted from Codrops' ScrollBlurTypography. Each character
 * animates `filter: blur()` with a stagger, scrubbed to scroll position; we use `opacity`
 * (not `brightness`) so dark type on a light background genuinely fades.
 *
 *   mode="in"  — chars start blurred + transparent, sharpen as the element scrolls in.
 *   mode="out" — chars start sharp, blur + fade as the trigger range scrolls past.
 *
 * Uses GSAP ScrollTrigger (works on native or smooth scroll). Reduced motion: renders crisp.
 */
export interface BlurScrollTextProps {
  text: string;
  /** Element tag to render (default "span"). */
  as?: ElementType;
  className?: string;
  mode?: "in" | "out";
  /** ScrollTrigger trigger (selector or element). Defaults to the text element itself. */
  trigger?: string | Element;
  start?: string;
  end?: string;
  /** Per-character stagger seconds (default 0.04). */
  stagger?: number;
  /** Max blur in px (default 10). */
  blur?: number;
}

export function BlurScrollText({
  text,
  as,
  className,
  mode = "in",
  trigger,
  start,
  end,
  stagger = 0.04,
  blur = 10,
}: BlurScrollTextProps) {
  const ref = useRef<HTMLElement>(null);

  useGSAP(
    () => {
      if (prefersReducedMotion() || !ref.current) return;
      const chars = ref.current.querySelectorAll<HTMLElement>(".bst-char");
      if (!chars.length) return;

      const sharp = { filter: "blur(0px)", opacity: 1 };
      const soft = { filter: `blur(${blur}px)`, opacity: 0 };

      // Resolve a selector trigger to an element OURSELVES: a string passed to ScrollTrigger
      // inside useGSAP's scope would be scoped to this text element, where an ancestor like
      // ".hero-pin" doesn't exist — so it would silently fall back to the wrong element.
      const triggerEl =
        typeof trigger === "string" ? document.querySelector(trigger) : trigger;

      gsap.fromTo(
        chars,
        { ...(mode === "in" ? soft : sharp), willChange: "filter, opacity" },
        {
          ...(mode === "in" ? sharp : soft),
          ease: "none",
          stagger,
          scrollTrigger: {
            trigger: triggerEl ?? ref.current,
            start: start ?? "top bottom-=15%",
            end: end ?? "bottom center+=15%",
            scrub: true,
          },
        },
      );
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
