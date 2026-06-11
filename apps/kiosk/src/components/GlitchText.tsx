import { useEffect, type RefObject } from "react";
import { gsap } from "gsap";
import { prefersReducedMotion } from "../lib/scroll";

/**
 * Terminal "decode" glitch — reimplemented from Codrops' LineTextHoverAnimations (effect-1,
 * MIT) WITHOUT SplitType: text is rendered as per-character spans here, and on hover each char
 * scrambles through a random charset then settles, with a block-cursor (the `::after`, driven by
 * the `--opa` CSS var). Triggered by the kiosk cursor's `is-hover` class (no native pointer on
 * the display) AND a real mouseenter for desktop dev. Reduced motion: text stays static.
 */
const CHARSET = "abcdefghijklmnopqrstuvwxyz!@#$%^&*-_+=;:<>,".split("");
const rand = () => CHARSET[Math.floor(Math.random() * CHARSET.length)] ?? "x";

/** Run the scramble on one `.gt-glitch` element's characters. */
export function scrambleGlitch(el: HTMLElement) {
  const chars = el.querySelectorAll<HTMLElement>(".gt-glitch-char");
  chars.forEach((char, pos) => {
    const original = char.dataset.ch ?? "";
    gsap.killTweensOf(char);
    char.textContent = original;
    let repeat = 0;
    gsap.fromTo(
      char,
      { opacity: 0 },
      {
        opacity: 1,
        duration: 0.03,
        repeat: 3,
        repeatDelay: 0.04,
        delay: (pos + 1) * 0.02, // cascade; small so long titles still decode quickly
        onStart() {
          gsap.set(char, { "--opa": 1 });
          char.textContent = rand();
        },
        onRepeat() {
          repeat++;
          char.textContent = rand();
          if (repeat === 1) gsap.set(char, { "--opa": 0 });
        },
        onComplete() {
          gsap.set(char, { "--opa": 0 });
          char.textContent = original;
        },
      },
    );
  });
}

/**
 * Wire a container so every `.gt-glitch` inside it decodes when the container is hovered —
 * via real mouseenter (desktop) or the kiosk cursor toggling `.is-hover` (the container must
 * carry `data-hover`). No-op under reduced motion.
 */
export function useGlitchOnHover(ref: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const row = ref.current;
    if (!row || prefersReducedMotion) return;
    const run = () =>
      row.querySelectorAll<HTMLElement>(".gt-glitch").forEach((el) => scrambleGlitch(el));

    row.addEventListener("mouseenter", run);
    // The cursor adds/removes `.is-hover`; fire only on the false→true transition.
    let was = row.classList.contains("is-hover");
    const mo = new MutationObserver(() => {
      const now = row.classList.contains("is-hover");
      if (now && !was) run();
      was = now;
    });
    mo.observe(row, { attributes: true, attributeFilter: ["class"] });

    return () => {
      row.removeEventListener("mouseenter", run);
      mo.disconnect();
    };
  }, [ref]);
}

/** Render text as decode-ready character spans. Spaces are preserved (not glitched). */
export function GlitchText({ text, className }: { text: string; className?: string }) {
  return (
    <span className={`gt-glitch${className ? ` ${className}` : ""}`} aria-label={text}>
      {Array.from(text).map((ch, i) =>
        ch === " " ? (
          <span key={i}> </span>
        ) : (
          <span key={i} className="gt-glitch-char" data-ch={ch} aria-hidden>
            {ch}
          </span>
        ),
      )}
    </span>
  );
}
