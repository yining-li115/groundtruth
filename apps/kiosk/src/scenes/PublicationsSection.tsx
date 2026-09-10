import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { gsap } from "gsap";
import { Logo } from "@groundtruth/ui";
import type { Paper } from "../../../../content/schema";
import { publications } from "../lib/content";
import { navigate } from "../lib/navigate";
import "./publications.css";

/**
 * Publications — the group's PhD papers. A full-screen, left-aligned menu (adapted from the
 * Codrops RapidImageHoverMenuEffects demo 5: hover reveals number + venue tag), and a click
 * opens a text-only detail built like the student-project one (`ProjectsSection`): a single
 * centred column with the abstract as its body, and no figures. Data is content
 * (content/publications.json, CLAUDE.md
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
      {/* No MENU here. Every section's top-right corner is the Home button now: the home
          page IS the menu, so a drawer that repeats the same five destinations is a second
          door into a room you can already see — and on the pages with a filter bar across the
          top it was fighting for the same strip of screen. */}

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

      {/* Text-only detail for the clicked paper — the same shape as the student-project
          detail (`ProjectsSection`): one centred column, the abstract as the body, and the
          bibliographic facts as meta blocks underneath.

          The figures are GONE. A paper's own figures are made to be read at A4 with a caption
          beside them; parked in a column on a wall, at a distance where the body type has to
          be set at 1.45rem to be legible at all, they were decoration that cost half the
          screen — and the half they cost was the abstract's, which is the only part of a paper
          a passer-by can actually take away. */}
      <AnimatePresence>
        {selected && (
          <motion.div
            key="pub-detail"
            className="pub-detail"
            /* Lenis owns the document wheel. Without this it swallows the gesture and scrolls
               the page — which, on a fixed full-screen detail, means nothing moves and an
               abstract longer than the viewport cannot be read to the end. */
            data-lenis-prevent
            initial={{ opacity: 0, y: 32 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 32 }}
            transition={{ duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
          >
            {/* No page-level Back, for the same reason the student-project detail has none:
                the Home corner is the one way out of a section, and a second exit beside it is
                a control competing with the control. Prev/next below still moves between
                papers. */}
            <div className="pub-detail-inner">
              <span className="pub-detail-type">{selected.type}</span>
              <h2 className="pub-detail-title">{selected.title}</h2>
              <p className="pub-detail-authors">{selected.authors.join(", ")}</p>
              <p className="pub-detail-abstract">{selected.abstract}</p>

              <div className="pub-detail-meta">
                <div className="pub-meta-block">
                  <span className="pub-meta-label">Venue</span>
                  <span className="pub-meta-value">{selected.venue}</span>
                </div>
                <div className="pub-meta-block">
                  <span className="pub-meta-label">Year</span>
                  <span className="pub-meta-value">{selected.year}</span>
                </div>
                {selected.url && (
                  <div className="pub-meta-block">
                    <span className="pub-meta-label">Read it at</span>
                    {/* Not a link: nobody taps a URL on a wall behind glass, they read it and
                        write it down. Stripped of its scheme for the same reason. */}
                    <span className="pub-meta-value pub-meta-url">
                      {selected.url.replace(/^https?:\/\//, "")}
                    </span>
                  </div>
                )}
              </div>
            </div>

            {/* Prev / next through the list. */}
            <div className="pub-detail-nav">
              <button
                type="button"
                data-hover
                className="pub-nav pub-nav--prev"
                aria-label="Previous paper"
                disabled={selectedIndex <= 0}
                onClick={() => goToPaper(-1)}
              >
                <svg viewBox="0 0 28 24" aria-hidden="true">
                  <path d="M24 12H3" />
                  <path d="M11 5L4 12l7 7" />
                </svg>
              </button>
              <span className="pub-nav-count">
                {selectedIndex + 1} / {publications.length}
              </span>
              <button
                type="button"
                data-hover
                className="pub-nav pub-nav--next"
                aria-label="Next paper"
                disabled={selectedIndex >= publications.length - 1}
                onClick={() => goToPaper(1)}
              >
                <svg viewBox="0 0 28 24" aria-hidden="true">
                  <path d="M4 12h21" />
                  <path d="M17 5l7 7-7 7" />
                </svg>
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
