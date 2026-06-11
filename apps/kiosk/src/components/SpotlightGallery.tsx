import { useRef } from "react";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import { useGSAP } from "@gsap/react";
import { GalleryGL } from "../experiments/gallery/galleryGL";
import { BlurScrollText } from "./BlurScrollText";
import { prefersReducedMotion } from "../lib/scroll";
import "../experiments/gallery/gallery.css";
import "./spotlightGallery.css";

/**
 * Home Spotlight section: a horizontal WebGL parallax gallery (galleryGL) that the visitor
 * browses by continuing to scroll DOWN. The section is pinned and a scrubbed ScrollTrigger
 * maps vertical scroll → the gallery's horizontal position (Lenis already smooths it, so the
 * gallery tracks 1:1). Reduced motion: the section just shows the gallery start, no pin.
 *
 * Images are picsum placeholders for now — real spotlight content cards land later. Note:
 * this adds a second WebGL context on the home (alongside the hero point cloud).
 */
const ITEMS = Array.from({ length: 3 }, (_, i) => ({
  id: i + 1,
  src: `https://picsum.photos/seed/gt-spot-${i + 1}/1600/900`,
}));

export function SpotlightGallery() {
  const section = useRef<HTMLElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const wrapper = useRef<HTMLDivElement>(null);
  const container = useRef<HTMLDivElement>(null);
  const gl = useRef<GalleryGL | null>(null);

  // Build the gallery FIRST (so ScrollTrigger can read its limit), then pin+scrub the
  // section to drive it horizontally. useGSAP runs as a layout effect; returning a cleanup
  // tears down both. The gallery is created even under reduced motion (just no pin).
  useGSAP(
    () => {
      if (!canvas.current || !wrapper.current || !container.current || !section.current) return;
      const els = Array.from(container.current.querySelectorAll<HTMLElement>(".gxgl-img"));
      const engine = new GalleryGL(canvas.current, container.current, wrapper.current, els, false);
      gl.current = engine;

      let st: ScrollTrigger | undefined;
      if (!prefersReducedMotion) {
        st = ScrollTrigger.create({
          trigger: section.current,
          start: "top top",
          end: () => "+=" + Math.max(1, engine.getLimit()),
          pin: true,
          scrub: true,
          invalidateOnRefresh: true,
          onUpdate: (self) => engine.setTarget(self.progress * engine.getLimit()),
        });
      }
      return () => {
        st?.kill();
        engine.destroy();
        gl.current = null;
      };
    },
    { scope: section },
  );

  return (
    <section className="sg-section" ref={section}>
      <canvas className="gxgl-canvas" ref={canvas} />
      <div className="sg-head">
        <BlurScrollText as="h2" className="sg-title" text="Spotlight" mode="in" />
      </div>
      <div className="gallery__wrapper" ref={wrapper}>
        <div className="gallery__image__container" ref={container}>
          {ITEMS.map((item) => (
            <picture className="gxgl-media" key={item.id}>
              <img className="gxgl-img" src={item.src} alt="" draggable={false} />
            </picture>
          ))}
        </div>
      </div>
      <p className="sg-hint">Keep scrolling → browse spotlights</p>
    </section>
  );
}
