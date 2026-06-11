import { useRef } from "react";
import { gsap } from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import { useGSAP } from "@gsap/react";
import { startSmoothScroll, prefersReducedMotion } from "../lib/scroll";
import "./newsGrid.css";

gsap.registerPlugin(ScrollTrigger);

/**
 * Home News section: a 3D staggered scroll grid (Codrops' `animateScrollGrid`, adapted to
 * our light theme + a Lusion "Featured Work" layout). Big near-full-width two-column cards
 * rise with a restrained 3D tilt + blur as they scroll. Picsum placeholders + fake copy for
 * now — the real (mostly text-only) news will need a different treatment, but this is the
 * showcase layout. Also previewable standalone at /?exp=news.
 */
const ITEMS = [
  { tag: "Research • CVPR • 3D Vision", title: "Five CVPR 2026 Papers" },
  { tag: "Award • Reconstruction", title: "Best Paper Award at ISPRS 2026" },
  { tag: "Event • Remote Sensing", title: "Joint DLR–TUM Workshop" },
  { tag: "People • Leadership", title: "Prof. Busam Joins PRS" },
  { tag: "Open • PhD • MCML", title: "Fully Funded PhD Positions" },
  { tag: "Research • LiDAR", title: "Multimodal Sensor Fusion" },
  { tag: "Project • Digital Twin", title: "City-Scale Reconstruction" },
  { tag: "Teaching • Thesis", title: "New Student Topics" },
  { tag: "Research • Neural Fields", title: "Façade Modelling" },
  { tag: "Field • Survey", title: "Campus Photogrammetry Scan" },
].map((it, i) => ({ ...it, src: `https://picsum.photos/seed/gt-news-${i + 1}/1200/800` }));

export function NewsGrid() {
  const root = useRef<HTMLElement>(null);

  useGSAP(
    () => {
      startSmoothScroll();
      if (prefersReducedMotion || !root.current) return;

      const wraps = root.current.querySelectorAll<HTMLElement>(".grid__item-imgwrap");
      const isLeftSide = (el: HTMLElement) =>
        el.getBoundingClientRect().left + el.offsetWidth / 2 < window.innerWidth / 2;

      wraps.forEach((wrap) => {
        const imgEl = wrap.querySelector<HTMLElement>(".grid__item-img");
        const leftSide = isLeftSide(wrap);

        gsap
          .timeline({
            scrollTrigger: {
              trigger: wrap,
              start: "top bottom+=10%",
              end: "bottom top-=25%",
              scrub: true,
            },
          })
          // Source's left/right direction (kept), angles toned down for big light cards.
          .from(wrap, {
            autoAlpha: 0,
            z: 120,
            rotateX: 28,
            rotateZ: leftSide ? 2 : -2,
            xPercent: leftSide ? -12 : 12,
            skewX: leftSide ? -4 : 4,
            yPercent: 40,
            filter: "blur(6px)",
            ease: "sine",
          })
          .to(wrap, {
            z: 120,
            rotateX: -18,
            rotateZ: leftSide ? -1 : 1,
            xPercent: leftSide ? -7 : 7,
            skewX: leftSide ? 3 : -3,
            filter: "blur(4px)",
            ease: "sine.in",
          })
          .from(imgEl, { scaleY: 1.25, ease: "sine" }, 0)
          .to(imgEl, { scaleY: 1.25, ease: "sine.in" }, ">");
      });
    },
    { scope: root },
  );

  return (
    <section className="news-section" ref={root}>
      <div className="news-section__head">
        <h2>News</h2>
      </div>
      <div className="news-grid">
        {ITEMS.map((item, i) => (
          <figure className="grid__item" key={i}>
            <div className="grid__item-imgwrap">
              <div className="grid__item-img" style={{ backgroundImage: `url(${item.src})` }} />
            </div>
            <figcaption className="grid__item-cap">
              <span className="grid__item-tag">{item.tag}</span>
              <h3 className="grid__item-title">→ {item.title}</h3>
            </figcaption>
          </figure>
        ))}
      </div>
    </section>
  );
}
