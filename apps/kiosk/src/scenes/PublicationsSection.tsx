import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { gsap } from "gsap";
import { Logo } from "@groundtruth/ui";
import type { Paper } from "../../../../content/schema";
import { publications } from "../lib/content";
import { KioskMenu } from "../components/KioskMenu";
import { navigate } from "../lib/navigate";
import "./publications.css";

/**
 * Publications — the group's PhD papers. A full-screen, left-aligned menu (adapted from the
 * Codrops RapidImageHoverMenuEffects demo 5: hover reveals number + venue tag), and a click
 * opens a ContentLayoutTransition-style detail (left: title/authors/abstract/link; right: the
 * paper's figures via swipe + dots). Data is content (content/publications.json, CLAUDE.md
 * rule 3). Dark via [data-theme="dark"] — a deliberate exception to the light-first site
 * (design-system §5); the rest of the kiosk stays light. `?open=<id>` deep-links a paper.
 *
 * This is the former "Projects" page: the student open-topics moved to ProjectsSection and
 * these four real papers stayed here under their own section.
 */
export function PublicationsSection() {
  const rootRef = useRef<HTMLDivElement>(null);
  const [selected, setSelected] = useState<Paper | null>(() => {
    const id = new URLSearchParams(window.location.search).get("open");
    return publications.find((p) => p.id === id) ?? null;
  });

  const selectedIndex = selected ? publications.findIndex((p) => p.id === selected.id) : -1;
  const goToPaper = (dir: -1 | 1) => {
    const next = publications[selectedIndex + dir];
    if (next) setSelected(next);
  };

  // Which figure of the current paper is shown (dot- or swipe-navigated, kept in sync).
  const [imgIndex, setImgIndex] = useState(0);
  useEffect(() => {
    setImgIndex(0);
  }, [selected]);
  const images = selected?.images ?? [];
  const mediaRef = useRef<HTMLDivElement>(null);
  const onMediaScroll = () => {
    const el = mediaRef.current;
    if (el) setImgIndex(Math.round(el.scrollLeft / el.clientWidth));
  };
  const scrollToImage = (i: number) => {
    const el = mediaRef.current;
    if (el) el.scrollTo({ left: i * el.clientWidth, behavior: "smooth" });
  };

  // Auto-fit the detail title to the column: largest size that still wraps within the
  // width and stays under a max height, so titles of any length fill the space cleanly.
  const titleRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    const el = titleRef.current;
    if (!el) return;
    const fit = () => {
      const maxH = window.innerHeight * 0.46;
      let lo = 22;
      let hi = 130;
      let best = 22;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        el.style.fontSize = `${mid}px`;
        if (el.scrollHeight <= maxH && el.scrollWidth <= el.clientWidth + 1) {
          best = mid;
          lo = mid + 1;
        } else {
          hi = mid - 1;
        }
      }
      el.style.fontSize = `${best}px`;
    };
    fit();
    window.addEventListener("resize", fit);
    return () => window.removeEventListener("resize", fit);
  }, [selected]);

  // Initial reveal: each title slides up from behind its clipping row (demo 5's showMenuItems).
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const inners = root.querySelectorAll<HTMLElement>(".menu__item-textinner");
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduced) {
      gsap.set(inners, { yPercent: 0 });
      return;
    }
    const tween = gsap.fromTo(
      inners,
      { yPercent: 100 },
      { yPercent: 0, duration: 1.2, ease: "expo.out", stagger: 0.06 },
    );
    return () => {
      tween.kill();
      gsap.set(inners, { yPercent: 0 });
    };
  }, []);

  return (
    <div className="publications" data-theme="dark" ref={rootRef}>
      <KioskMenu />

      {/* Top-left: chair + university (white on dark), clickable → home. */}
      <div className="frame">
        <button
          type="button"
          data-hover
          className="frame__logo"
          aria-label="Back to home"
          onClick={() => navigate("home")}
        >
          <div className="frame__brand-text">
            <div className="frame__brand-line frame__brand-strong">
              Professorship of Photogrammetry and Remote Sensing
            </div>
            <div className="frame__brand-line">TUM School of Engineering and Design</div>
            <div className="frame__brand-line">Technical University of Munich</div>
          </div>
          <Logo variant="white" width={64} height={33} />
        </button>
      </div>

      {/* Oversized title, behind the menu. */}
      <div className="title" aria-hidden="true">
        <h2 className="title__main">
          <span className="oh">
            <span className="oh__inner">Publications</span>
          </span>
        </h2>
      </div>

      {/* The browse menu. */}
      <nav className="menu">
        {publications.map((p) => (
          <a className="menu__item" data-hover key={p.id} onClick={() => setSelected(p)}>
            <span className="menu__item-text">
              <span className="menu__item-textinner">{p.title}</span>
            </span>
            <span className="menu__item-sub">{p.type}</span>
          </a>
        ))}
      </nav>

      {/* Detail view for the clicked paper. */}
      <AnimatePresence>
        {selected && (
          <motion.div
            key="pub-detail"
            className="pub-detail"
            initial={{ opacity: 0, y: 32 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 32 }}
            transition={{ duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
          >
            <button
              type="button"
              data-hover
              className="pub-detail-back"
              onClick={() => setSelected(null)}
            >
              ← Back
            </button>

            <div className="pub-detail-text">
              <span className="pub-detail-type">{selected.type}</span>
              <h2 className="pub-detail-title" ref={titleRef}>
                {selected.title}
              </h2>
              <p className="pub-detail-authors">{selected.authors.join(", ")}</p>
              <p className="pub-detail-venue">
                {selected.venue} · {selected.year}
              </p>
              <p className="pub-detail-abstract">{selected.abstract}</p>
              {selected.url && (
                <a
                  className="pub-detail-link"
                  data-hover
                  href={selected.url}
                  target="_blank"
                  rel="noreferrer"
                >
                  Read paper ↗
                </a>
              )}
            </div>

            <div className="pub-detail-right">
              <button
                type="button"
                data-hover
                className="pub-nav pub-nav--prev"
                aria-label="Previous paper"
                disabled={selectedIndex <= 0}
                onClick={() => goToPaper(-1)}
              >
                <svg viewBox="0 0 24 28" aria-hidden="true">
                  <path d="M12 3v21" />
                  <path d="M5 17l7 7 7-7" />
                </svg>
              </button>

              {/* One figure at a time — swipe horizontally OR use the dots below. */}
              <div className="pub-detail-media" ref={mediaRef} onScroll={onMediaScroll}>
                {images.map((src) => (
                  <img key={src} className="pub-detail-img" src={src} alt="" />
                ))}
              </div>

              {images.length > 1 && (
                <div className="pub-detail-dots">
                  {images.map((src, i) => (
                    <button
                      key={src}
                      type="button"
                      data-hover
                      className={`pub-dot${i === imgIndex ? " is-active" : ""}`}
                      aria-label={`Figure ${i + 1}`}
                      onClick={() => scrollToImage(i)}
                    />
                  ))}
                </div>
              )}

              <button
                type="button"
                data-hover
                className="pub-nav pub-nav--next"
                aria-label="Next paper"
                disabled={selectedIndex >= publications.length - 1}
                onClick={() => goToPaper(1)}
              >
                <svg viewBox="0 0 24 28" aria-hidden="true">
                  <path d="M12 3v21" />
                  <path d="M5 17l7 7 7-7" />
                </svg>
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
