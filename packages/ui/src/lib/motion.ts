/** True when the user/device asks for reduced motion. Heavy, scroll-driven effects in this
 *  package check this and degrade to a static state. */
export function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}
