import { useRef } from "react";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import { useGSAP } from "@gsap/react";
import { Engine } from "../experiments/depth/Engine";
import { prefersReducedMotion } from "../lib/scroll";
import "../experiments/depth/depth.css";

/**
 * Home "Open Topics" section: the vendored depth gallery (Codrops houmahani/codrops-depth-gallery)
 * wired into page scroll. The stage is sticky inside a tall section, so it RISES up from beneath
 * the News grid (continuous — no blank gap, no separate "reveal") and sticks at the top while the
 * remaining scroll travels the camera through the poster stack. A scrubbed ScrollTrigger maps the
 * section's scroll progress → camera depth (the engine's own wheel/touch hijack is off via
 * externalScroll). Reduced motion: the section collapses to one viewport showing the entry plane.
 */
export function OpenTopicsDepth() {
  const section = useRef<HTMLElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);

  useGSAP(
    () => {
      if (!canvas.current || !stage.current || !section.current) return;
      const engine = new Engine(canvas.current, {
        externalScroll: true,
        overlayRoot: stage.current,
      });
      engine.init().catch((error: unknown) => console.error("Depth engine init failed", error));

      let st: ScrollTrigger | undefined;
      if (!prefersReducedMotion) {
        st = ScrollTrigger.create({
          trigger: section.current,
          start: "top top", // progress 0 once the sticky stage reaches the top of the viewport
          end: "bottom bottom", // progress 1 when the section's tail clears
          onUpdate: (self) => engine.setScrollProgress(self.progress),
        });
      }

      return () => {
        st?.kill();
        engine.dispose();
      };
    },
    { scope: section },
  );

  return (
    <section
      className="depth-section"
      ref={section}
      aria-label="Open Topics"
      // Reduced motion: no depth travel — just one viewport showing the entry plane.
      style={prefersReducedMotion ? { height: "100vh" } : undefined}
    >
      <div className="depth-stage depth-stage--sticky" ref={stage}>
        <canvas className="depth-canvas" ref={canvas} />
      </div>
    </section>
  );
}
