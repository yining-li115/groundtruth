import { useEffect, useRef } from "react";
import { GalleryGL } from "./galleryGL";
import "./gallery.css";

/**
 * Horizontal parallax gallery EXPERIMENT (?exp=gallery) — WebGL version, ported from the
 * Codrops demo (the smoother one: image content parallax-shifts in a shader as it slides).
 * Invisible <img> placeholders lay out the row; three.js planes render at their bounds.
 * Vertical wheel/finger delta moves the row sideways. Images are picsum placeholders for
 * now. NOT wired into the home. (galleryEngine.ts holds the 2D/DOM fallback.)
 */

// Placeholder images (4:3) — stand-ins until real content cards land.
const ITEMS = Array.from({ length: 10 }, (_, i) => ({
  id: i + 1,
  src: `https://picsum.photos/seed/gt-gallery-${i + 1}/1200/900`,
}));

export function GalleryExperiment() {
  const canvas = useRef<HTMLCanvasElement>(null);
  const wrapper = useRef<HTMLDivElement>(null);
  const container = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!canvas.current || !wrapper.current || !container.current) return;
    const els = Array.from(container.current.querySelectorAll<HTMLElement>(".gxgl-img"));
    const gl = new GalleryGL(canvas.current, container.current, wrapper.current, els);
    return () => gl.destroy();
  }, []);

  return (
    <div className="gx-page">
      <canvas ref={canvas} className="gxgl-canvas" />
      <div className="gallery__wrapper" ref={wrapper}>
        <div className="gallery__image__container" ref={container}>
          {ITEMS.map((item) => (
            <picture className="gxgl-media" key={item.id}>
              {/* invisible — only defines layout bounds for its WebGL plane */}
              <img className="gxgl-img" src={item.src} alt="" draggable={false} />
            </picture>
          ))}
        </div>
      </div>
      <p className="gx-hint">Scroll ↓ — moves the gallery sideways (WebGL parallax per image)</p>
    </div>
  );
}
