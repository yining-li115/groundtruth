import { useRef } from "react";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import { useGSAP } from "@gsap/react";
import { BlurScrollText, HoverCaption } from "@groundtruth/ui";
import { GalleryGL } from "../experiments/gallery/galleryGL";
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
// Placeholder spotlights — fake (but on-theme) titles/descriptions until real content lands.
const ITEMS = [
  {
    id: 1,
    title: "Digital Twins",
    desc: "Photorealistic, geometrically precise 3D replicas of real-world environments.",
  },
  {
    id: 2,
    title: "Sensor Fusion",
    desc: "LiDAR, radar and imagery fused into one coherent 3D understanding.",
  },
  {
    id: 3,
    title: "Agentic 3D Vision",
    desc: "From raw pixels to geometry, dynamics, and agents that reason in 3D.",
  },
].map((it) => ({ ...it, src: `https://picsum.photos/seed/gt-spot-${it.id}/1600/900` }));

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
    <>
      {/* The canvas lives OUTSIDE the pinned section: ScrollTrigger leaves a transform on the
          section, and a transform makes position:fixed descendants anchor to it (not the
          viewport), which offsets the planes from the DOM captions during scroll. */}
      <canvas className="gxgl-canvas" ref={canvas} />
      <section className="sg-section" ref={section}>
        <div className="sg-head">
        <BlurScrollText as="h2" className="sg-title" text="Spotlight" mode="in" />
      </div>
      <div className="gallery__wrapper" ref={wrapper}>
        <div className="gallery__image__container" ref={container}>
          {ITEMS.map((item) => (
            <HoverCaption
              className="gxgl-media"
              key={item.id}
              title={item.title}
              description={item.desc}
            >
              {/* invisible — only defines layout bounds for its WebGL plane */}
              <img className="gxgl-img" src={item.src} alt="" draggable={false} />
            </HoverCaption>
          ))}
        </div>
      </div>
        <p className="sg-hint">Keep scrolling → browse spotlights</p>
      </section>
    </>
  );
}
