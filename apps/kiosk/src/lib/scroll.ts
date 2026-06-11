import Lenis from "lenis";
import { gsap } from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";

/**
 * Smooth-scroll + scroll-animation FOUNDATION (plumbing only — no choreography).
 *
 * This wires the three things every scroll-driven animation on the kiosk needs, and
 * nothing about how anything *looks*:
 *   1. Lenis  — eased, inertial smooth scrolling (design-system §6: "Lenis everywhere").
 *   2. GSAP ScrollTrigger — registered and kept in sync with Lenis, so future components
 *      can attach scroll-linked reveals/pins/parallax without touching this file.
 *   3. prefers-reduced-motion — when set, smoothing is skipped (native scroll); ScrollTrigger
 *      still works against the native scroll, so reveals can degrade to instant.
 *
 * Lenis drives the *real* document scroll, so existing code that reads `window.scrollY`
 * or listens for `scroll` events (e.g. the home hero disperse) keeps working unchanged —
 * it just receives eased values. The one thing that must NOT bypass Lenis is programmatic
 * scrolling (the phone's two-finger scroll); route that through `scrollByPx` below.
 */

gsap.registerPlugin(ScrollTrigger);

export const prefersReducedMotion =
  typeof window !== "undefined" &&
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

let lenis: Lenis | null = null;
let started = false;

/**
 * Start the singleton smooth-scroll loop. Idempotent and persistent for the tab's lifetime
 * (mirrors the socket singleton) so React StrictMode's dev double-mount can't churn it.
 * No-op under reduced motion — the page falls back to native scrolling.
 */
export function startSmoothScroll() {
  if (started) return;
  started = true;
  if (prefersReducedMotion) return;

  lenis = new Lenis({
    duration: 1.1, // eased momentum; slow-out feel per design-system §6
    smoothWheel: true,
  });
  // Keep ScrollTrigger's notion of scroll position in lockstep with Lenis.
  lenis.on("scroll", ScrollTrigger.update);
  // Drive Lenis off GSAP's ticker so both share one rAF loop (no competing clocks).
  gsap.ticker.add((time) => lenis?.raf(time * 1000));
  gsap.ticker.lagSmoothing(0);
}

/**
 * Apply a pixel delta to the scroll position, routed through Lenis so the controller's
 * two-finger scroll eases with the page instead of fighting the smooth-scroll loop.
 * `dy` is already sign-corrected by the caller (positive = scroll down). Falls back to
 * native scrolling when Lenis is off (reduced motion).
 */
export function scrollByPx(dy: number) {
  if (lenis) lenis.scrollTo(lenis.targetScroll + dy, { immediate: false });
  else window.scrollBy({ top: dy, behavior: "auto" });
}
