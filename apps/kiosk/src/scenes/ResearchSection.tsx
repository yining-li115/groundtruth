import { useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { gsap } from "gsap";
import { Logo } from "@groundtruth/ui";
import { topics } from "../lib/content";
import { KioskMenu } from "../components/KioskMenu";
import { navigate } from "../lib/navigate";
import { horizontalLoop } from "../lib/horizontalLoop";
import "./research.css";

/**
 * Research — the group's topics as the Osmo draggable infinite slider (drag with momentum +
 * snap, or use the prev/next buttons / click a slide). The left overlay shows a vertical
 * counter and the active topic's title + summary. Content is data (content/research-topics.json,
 * CLAUDE.md rule 3): each topic's cover → image, title → title, summary → blurb. A deliberate
 * DARK section (design-system §5, like Projects). Layout/animation are a 1:1 port of the
 * reference; only colours/font are our tokens (research.css).
 */
const pad = (n: number) => (n < 10 ? `0${n}` : `${n}`);

export function ResearchSection() {
  const slides = useMemo(
    () => topics.map((t) => ({ id: t.id, title: t.title, blurb: t.summary, image: t.cover })),
    [],
  );

  const rootRef = useRef<HTMLDivElement>(null);
  const stepsRef = useRef<HTMLDivElement>(null);
  const prevRef = useRef<HTMLButtonElement>(null);
  const nextRef = useRef<HTMLButtonElement>(null);
  // The opaque (active) slide is offset by +1 from the centred one (clears the overlay), so
  // the slider starts on the 2nd slide — matching the reference.
  const [activeIndex, setActiveIndex] = useState(1);

  useEffect(() => {
    const root = rootRef.current;
    const steps = stepsRef.current;
    if (!root) return;

    const slideEls = gsap.utils.toArray<HTMLElement>(root.querySelectorAll('[data-slider="slide"]'));
    const length = slideEls.length;
    if (!length) return;
    let activeEl: HTMLElement | null = null;

    const loop = horizontalLoop(slideEls, {
      paused: true,
      draggable: true,
      center: false,
      onChange: (element, index) => {
        activeEl?.classList.remove("active");
        const next = (element.nextElementSibling as HTMLElement) ?? slideEls[0]!;
        next.classList.add("active");
        activeEl = next;
        const activeIdx = (index + 1) % length;
        // Each number slot is 1.6em tall (matches research.css), so translate by whole slots.
        if (steps) gsap.to(steps, { y: `${-activeIdx * 1.6}em`, ease: "power3", duration: 0.45 });
        setActiveIndex(activeIdx);
      },
    });

    const slideHandlers = slideEls.map((slide, i) => {
      const handler = () => loop.toIndex(i - 1, { ease: "power3", duration: 0.725 });
      slide.addEventListener("click", handler);
      return handler;
    });
    const onNext = () => loop.next({ ease: "power3", duration: 0.725 });
    const onPrev = () => loop.previous({ ease: "power3", duration: 0.725 });
    nextRef.current?.addEventListener("click", onNext);
    prevRef.current?.addEventListener("click", onPrev);

    return () => {
      slideEls.forEach((slide, i) => slide.removeEventListener("click", slideHandlers[i]!));
      nextRef.current?.removeEventListener("click", onNext);
      prevRef.current?.removeEventListener("click", onPrev);
      loop.context?.revert();
    };
  }, [slides]);

  const active = slides[activeIndex] ?? slides[0]!;

  return (
    <div className="rsl" data-theme="dark" ref={rootRef}>
      <KioskMenu />

      <button type="button" className="rsl-brand" aria-label="Back to home" onClick={() => navigate("home")}>
        <span className="rsl-brand-text">
          <span className="rsl-brand-strong">
            Professorship of Photogrammetry and Remote Sensing
          </span>
          <span>TUM School of Engineering and Design</span>
          <span>Technical University of Munich</span>
        </span>
        <Logo variant="white" width={64} height={33} />
      </button>

      <div className="rsl-overlay">
        <div className="rsl-overlay-inner">
          <div className="rsl-count-row">
            <div className="rsl-count-column">
              <div className="rsl-count-steps" ref={stepsRef}>
                {slides.map((s, i) => (
                  <h2 className="rsl-count-heading" key={s.id}>
                    {pad(i + 1)}
                  </h2>
                ))}
              </div>
            </div>
            <div className="rsl-count-divider" />
            <div className="rsl-count-column">
              <h2 className="rsl-count-heading">{pad(slides.length)}</h2>
            </div>
          </div>

          <div className="rsl-desc">
            <AnimatePresence mode="wait">
              <motion.div
                key={active.id}
                initial={{ opacity: 0, x: -24 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: 24 }}
                transition={{ duration: 0.45, ease: [0.625, 0.05, 0, 1] }}
              >
                <h3 className="rsl-desc-title">{active.title}</h3>
                <p className="rsl-desc-blurb">{active.blurb}</p>
              </motion.div>
            </AnimatePresence>
          </div>

          <div className="rsl-nav-row">
            <button ref={prevRef} type="button" className="rsl-button" data-hover aria-label="previous topic">
              <svg width="100%" viewBox="0 0 17 12" fill="none" className="rsl-button-arrow">
                <path
                  d="M6.28871 12L7.53907 10.9111L3.48697 6.77778H16.5V5.22222H3.48697L7.53907 1.08889L6.28871 0L0.5 6L6.28871 12Z"
                  fill="currentColor"
                />
              </svg>
              <span className="rsl-button-overlay">
                <span className="rsl-corner" />
                <span className="rsl-corner top-right" />
                <span className="rsl-corner bottom-left" />
                <span className="rsl-corner bottom-right" />
              </span>
            </button>
            <button ref={nextRef} type="button" className="rsl-button" data-hover aria-label="next topic">
              <svg width="100%" viewBox="0 0 17 12" fill="none" className="rsl-button-arrow next">
                <path
                  d="M6.28871 12L7.53907 10.9111L3.48697 6.77778H16.5V5.22222H3.48697L7.53907 1.08889L6.28871 0L0.5 6L6.28871 12Z"
                  fill="currentColor"
                />
              </svg>
              <span className="rsl-button-overlay">
                <span className="rsl-corner" />
                <span className="rsl-corner top-right" />
                <span className="rsl-corner bottom-left" />
                <span className="rsl-corner bottom-right" />
              </span>
            </button>
          </div>
        </div>
      </div>

      <div className="rsl-main">
        <div className="rsl-wrap">
          <div className="rsl-list">
            {slides.map((s) => (
              <div className="rsl-slide" data-slider="slide" data-hover key={s.id}>
                <div className="rsl-inner">
                  <img src={s.image} alt="" loading="lazy" />
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
