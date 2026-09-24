import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { gsap } from "gsap";
import { palette } from "@groundtruth/tokens";
import { QRCodeSVG } from "qrcode.react";
import type { Paper } from "../../../../content/schema";
import { publications } from "../lib/content";
import { DetailPager } from "../components/DetailPager";
import { SectionHome } from "../components/SectionHome";
import { PublicationStoryBackdrop } from "./PublicationStoryBackdrop";
import "./publications.css";

/**
 * Publications — the group's PhD papers. A full-screen, left-aligned menu (adapted from the
 * Codrops RapidImageHoverMenuEffects demo 5: hover reveals number + venue tag), and a click
 * opens a detail built like the student-project one (`ProjectsSection`): a centred paper
 * header, its featured figure and abstract, then the bibliographic facts. Data is content
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
  const [pageDirection, setPageDirection] = useState<-1 | 1>(1);

  const selectedIndex = selected ? publications.findIndex((p) => p.id === selected.id) : -1;
  const selectPaper = (paper: Paper) => {
    const nextIndex = publications.findIndex((candidate) => candidate.id === paper.id);
    setPageDirection(selectedIndex >= 0 && nextIndex < selectedIndex ? -1 : 1);
    setSelected(paper);
  };
  const goToPaper = (dir: -1 | 1) => {
    const next = publications[selectedIndex + dir];
    if (next) {
      setPageDirection(dir);
      setSelected(next);
    }
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
    <div
      className={`publications${selected ? " publications--detail-open" : ""}`}
      data-theme="dark"
      data-hand-scroll-speed={selected ? undefined : 0.8}
      ref={rootRef}
    >
      {/* Static identity at top-left; SectionHome supplies the independent bottom-left Home. */}
      <div className="frame">
        <SectionHome tone="dark" className="frame__logo" />
      </div>

      {/* Oversized right-half poster title. It is in normal flow, so no scrolling row can
          cross through it. */}
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
          <a
            className="menu__item"
            data-hover
            data-has-image={Boolean(p.images?.[0])}
            key={p.id}
            onClick={() => selectPaper(p)}
          >
            <span className="menu__item-text">
              <span className="menu__item-textinner">
                <span className="menu__item-label">{p.title}</span>
              </span>
            </span>
            <span className="menu__item-sub">{p.type}</span>
          </a>
        ))}
      </nav>

      {/* Five authored images become reusable particle destinations. Every paper turn reforms
          the same cloud into the next image; after five papers the visual sequence loops. */}
      {selected && (
        <PublicationStoryBackdrop
          index={selectedIndex}
          direction={pageDirection}
        />
      )}

      {/* Paper detail. The abstract owns the centred reading column under the authors. A figure,
          when available, follows as supporting evidence rather than squeezing the copy into a
          narrow side column. */}
      <AnimatePresence mode="wait">
        {selected && (
          <motion.div
            key={`pub-detail:${selected.id}`}
            className="pub-detail"
            /* Lenis owns the document wheel. Without this it swallows the gesture and scrolls
               the page — which, on a fixed full-screen detail, means nothing moves and an
               abstract longer than the viewport cannot be read to the end. */
            data-lenis-prevent
            initial={{ opacity: 0, x: pageDirection * 40, y: 16 }}
            animate={{ opacity: 1, x: 0, y: 0 }}
            exit={{ opacity: 0, x: pageDirection * -40, y: -8 }}
            transition={{ duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
          >
            {/* Home remains fixed at bottom-left; prev/next below moves only between papers. */}
            <div className="pub-detail-inner">
              <header className="pub-detail-header">
                <span className="pub-detail-type">{selected.type}</span>
                <h2 className="pub-detail-title">{selected.title}</h2>
                <p className="pub-detail-authors">{selected.authors.join(", ")}</p>
              </header>

              <div
                className={`pub-detail-body${selected.images?.[0] ? " pub-detail-body--with-image" : ""}`}
              >
                <p className="pub-detail-abstract">{selected.abstract}</p>
                {selected.images?.[0] && (
                  <figure className="pub-detail-figure">
                    <img
                      key={`${selected.id}:${selected.images[0]}`}
                      className="pub-detail-image"
                      src={selected.images[0]}
                      alt={`Featured figure for “${selected.title}”`}
                      loading="eager"
                      decoding="async"
                    />
                  </figure>
                )}
              </div>

              <div className="pub-detail-meta">
                <div className="pub-meta-facts">
                  <div className="pub-meta-block">
                    <span className="pub-meta-label">Venue</span>
                    <span className="pub-meta-value">{selected.venue}</span>
                  </div>
                  <div className="pub-meta-block">
                    <span className="pub-meta-label">Year</span>
                    <span className="pub-meta-value">{selected.year}</span>
                  </div>
                </div>
                {selected.url && (
                  <div className="pub-meta-block pub-meta-block--qr">
                    <span className="pub-meta-label">Scan to read paper</span>
                    <QRCodeSVG
                      className="pub-paper-qr"
                      value={selected.url}
                      size={192}
                      level="M"
                      marginSize={4}
                      fgColor={palette.brand.black}
                      bgColor={palette.brand.white}
                      role="img"
                      aria-label={`QR code to read “${selected.title}”`}
                      title={`Scan to read “${selected.title}”`}
                    />
                    <span className="pub-meta-domain">
                      {new URL(selected.url).hostname.replace(/^www\./, "")}
                    </span>
                  </div>
                )}
              </div>
            </div>

          </motion.div>
        )}
      </AnimatePresence>

      {/* Prev / next through the list: two wings of light on the side edges (see
          `DetailPager`). OUTSIDE the motion.div on purpose — it animates `transform`, and a
          transformed ancestor turns `position: fixed` into "fixed to me", so the wings would
          slide in with the text and scroll with the abstract. */}
      {selected && (
        <DetailPager
          index={selectedIndex}
          total={publications.length}
          onPrev={() => goToPaper(-1)}
          onNext={() => goToPaper(1)}
          prevLabel="Previous paper"
          nextLabel="Next paper"
        />
      )}
    </div>
  );
}
