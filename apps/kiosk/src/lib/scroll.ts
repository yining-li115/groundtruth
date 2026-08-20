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
/**
 * Apply a pixel delta to the page scroll.
 *
 * `continuous` is for input that arrives every frame — the hand's lean-to-scroll. It matters
 * enormously and the reason is not obvious: `lenis.scrollTo` STARTS AN ANIMATION, a 1.1s
 * ease toward the target. Called once per frame it restarts that ease about a hundred and
 * twenty times a second, so only the first few milliseconds of each one ever runs and the
 * page creeps. Measured against the same gesture with Lenis disabled: 110 px/s instead of
 * 2400 — four per cent of the intended speed, which is a roster that takes half a minute of
 * held, leaned arm to get through, and reads as scrolling being broken.
 *
 * A per-frame drive does not want easing anyway: the hand position is already smoothed by the
 * 1€ filter before it becomes a velocity, so Lenis would be easing something eased. It is
 * still routed through Lenis rather than around it, so ScrollTrigger and the smooth-scroll
 * loop keep agreeing about where the page is.
 */
export function scrollByPx(dy: number, { continuous = false } = {}) {
  if (lenis) lenis.scrollTo(lenis.targetScroll + dy, { immediate: continuous });
  else window.scrollBy({ top: dy, behavior: "auto" });
}

/**
 * Put a freshly opened screen at its top.
 *
 * Without this the scroll position simply carries over, and a detail page taller than the
 * viewport opens clamped to its own bottom — with its Back control several hundred pixels
 * above the top edge, unreachable by any gesture. Measured on eight profiles: eight failures.
 */
export function scrollToTop() {
  scrollToY(0);
}

/** Jump the page to an absolute position — used to put a visitor back where they were. */
export function scrollToY(y: number) {
  if (lenis) lenis.scrollTo(y, { immediate: true });
  else window.scrollTo({ top: y, behavior: "auto" });
}

/**
 * The nearest thing under a point that can actually scroll, or null for the page itself.
 *
 * A hand drag used to always scroll the document, which is fine until a section turns out to
 * be a fixed, full-screen layout with its own `overflow-y: auto` inside it — Projects and
 * Publications both are. On those the document has nothing to scroll and the gesture did
 * nothing at all, with no way to tell from the outside whether the tracking or the page was
 * at fault. A wheel does not have this problem because it scrolls whatever is under the
 * pointer; this makes the hand behave the same way.
 */
export function scrollableAt(x: number, y: number): HTMLElement | null {
  let el = document.elementFromPoint(x, y) as HTMLElement | null;
  while (el && el !== document.body && el !== document.documentElement) {
    const st = getComputedStyle(el);
    const scrollableY =
      /(auto|scroll|overlay)/.test(st.overflowY) && el.scrollHeight > el.clientHeight + 2;
    const scrollableX =
      /(auto|scroll|overlay)/.test(st.overflowX) && el.scrollWidth > el.clientWidth + 2;
    if (scrollableY || scrollableX) return el;
    el = el.parentElement;
  }
  return null;
}

/**
 * Scroll a specific element, or the page (through Lenis) when there isn't one.
 *
 * Both axes: some sections browse sideways. An element that cannot scroll an axis simply
 * ignores it, so this needs no knowledge of which is which.
 */
export function scrollTarget(el: HTMLElement | null, dx: number, dy: number): void {
  if (el) {
    if (dx) el.scrollLeft += dx;
    if (dy) el.scrollTop += dy;
  } else if (dy) scrollByPx(dy, { continuous: true });
}

export { dragScrollVelocity } from "./scrollGesture";
