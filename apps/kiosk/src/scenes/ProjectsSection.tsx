import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { gsap } from "gsap";
import { GooeyNav, Logo, type GooeyNavItem } from "@groundtruth/ui";
import type { OpenTopic, OpenTopicType } from "../../../../content/schema";
import { openTopics, personName } from "../lib/content";
import { navigate } from "../lib/navigate";
import { DetailPager } from "../components/DetailPager";
import { TAG_COLOR } from "./tagColors";
import "./projects.css";

/**
 * Student Projects — the open topics the group OFFERS to students. A GooeyNav filter (the
 * five project kinds) at the top narrows the list; the list reuses the Codrops
 * RapidImageHoverMenuEffects demo 5 (hover reveals number + type tag), and a click opens a
 * text-only detail (no figures — those live on the Publications page). Data is content
 * (content/open-topics.json, CLAUDE.md rule 3). Dark via [data-theme="dark"] — a deliberate
 * exception to the light-first site (design-system §5). Preview at /?view=projects.
 */

const TYPES: OpenTopicType[] = [
  "IDP",
  "Guided Research",
  "Semester Arbeit",
  "Bachelor Thesis",
  "Master Thesis",
];
// "All" (chronological) leads, then the five kinds. Filter tabs keep their default colour —
// only the per-topic tags below are colour-coded (TAG_COLOR).
const ALL = "All";
const FILTER_LABELS: string[] = [ALL, ...TYPES];
const FILTER_ITEMS: GooeyNavItem[] = FILTER_LABELS.map((label) => ({ label, key: label }));

/** Newest first by `posted` date (missing dates sort last). */
function byPostedDesc(a: OpenTopic, b: OpenTopic): number {
  return (b.posted ?? "").localeCompare(a.posted ?? "");
}

/** Render a topic's types as colour-coded tags, separated by a muted pipe. */
function TagList({ types }: { types: OpenTopicType[] }) {
  return (
    <>
      {types.map((ty, i) => (
        <Fragment key={ty}>
          {i > 0 && <span className="tag-sep">|</span>}
          <span style={{ color: TAG_COLOR[ty] }}>{ty}</span>
        </Fragment>
      ))}
    </>
  );
}

export function ProjectsSection() {
  const rootRef = useRef<HTMLDivElement>(null);
  const detailRef = useRef<HTMLDivElement>(null);
  const [activeFilter, setActiveFilter] = useState(0);
  const [selected, setSelected] = useState<OpenTopic | null>(null);
  const activeLabel = FILTER_LABELS[activeFilter] ?? ALL;
  const filtered = useMemo(() => {
    if (activeLabel === ALL) return [...openTopics].sort(byPostedDesc);
    return openTopics.filter((t) => t.types.includes(activeLabel as OpenTopicType));
  }, [activeLabel]);

  const selectedIndex = selected ? filtered.findIndex((t) => t.id === selected.id) : -1;
  const goTo = (dir: -1 | 1) => {
    const next = filtered[selectedIndex + dir];
    if (next) setSelected(next);
  };

  // Reveal the list whenever the filter changes (each title slides up from its clip row,
  // like demo 5's showMenuItems). Reduced motion just shows them.
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
      { yPercent: 0, duration: 1, ease: "expo.out", stagger: 0.05 },
    );
    return () => {
      tween.kill();
      gsap.set(inners, { yPercent: 0 });
    };
  }, [activeFilter]);

  return (
    <div className="projects" data-theme="dark" ref={rootRef}>
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

      {/* Oversized two-line title, behind the menu (one word per line). */}
      <div className="title" aria-hidden="true">
        <h2 className="title__main">
          <span className="oh">
            <span className="oh__inner">Student</span>
          </span>
          <span className="oh">
            <span className="oh__inner">Projects</span>
          </span>
        </h2>
      </div>

      {/* Filter tabs — the five project kinds. */}
      <div className="projects-filter">
        <GooeyNav
          items={FILTER_ITEMS}
          initialActiveIndex={activeFilter}
          onSelect={(i) => {
            setActiveFilter(i);
            setSelected(null);
          }}
        />
      </div>

      {/* The filtered open-topics list. */}
      <nav className="menu" key={activeLabel}>
        {filtered.length === 0 ? (
          <p className="menu__empty">No open topics in this category right now — check back soon.</p>
        ) : (
          filtered.map((t) => (
            <a className="menu__item" data-hover key={t.id} onClick={() => setSelected(t)}>
              <span className="menu__item-text">
                <span className="menu__item-textinner">{t.title}</span>
              </span>
              <span className="menu__item-sub">
                <TagList types={t.types} />
              </span>
            </a>
          ))
        )}
      </nav>

      {/* Text-only detail for the clicked open topic. */}
      <AnimatePresence>
        {selected && (
          <motion.div
            key="sp-detail"
            ref={detailRef}
            className="sp-detail"
            /* Lenis owns the document wheel. Without this it swallows the gesture and
               scrolls the page — which, on a fixed full-screen detail, means nothing
               moves and a topic longer than the viewport cannot be read to the end. */
            data-lenis-prevent
            initial={{ opacity: 0, y: 32 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 32 }}
            transition={{ duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
          >
            {/* No page-level Back here. The global Home control is the one way out of a
                section, and a second exit two centimetres from it — in the strip a hand
                crosses on its way to the filter tabs — was a control competing with the
                control. Prev/next below still moves between topics. */}

            <div className="sp-detail-inner">
              <span className="sp-detail-type">
                <TagList types={selected.types} />
              </span>
              <h2 className="sp-detail-title">{selected.title}</h2>
              <p className="sp-detail-summary">{selected.summary}</p>
              <p className="sp-detail-desc">{selected.description}</p>

              <div className="sp-detail-meta">
                {selected.supervisorId && (
                  <div className="sp-meta-block">
                    <span className="sp-meta-label">Supervisor</span>
                    <span className="sp-meta-value">{personName(selected.supervisorId)}</span>
                  </div>
                )}
                {selected.contact && (
                  <div className="sp-meta-block">
                    <span className="sp-meta-label">Contact</span>
                    <span className="sp-meta-value sp-meta-contact">{selected.contact}</span>
                  </div>
                )}
                {selected.prerequisites && selected.prerequisites.length > 0 && (
                  <div className="sp-meta-block">
                    <span className="sp-meta-label">Prerequisites</span>
                    <span className="sp-chips">
                      {selected.prerequisites.map((p) => (
                        <span className="sp-chip" key={p}>
                          {p}
                        </span>
                      ))}
                    </span>
                  </div>
                )}
              </div>
            </div>

          </motion.div>
        )}
      </AnimatePresence>

      {/* Prev / next within the current filter: the side-edge wings (`DetailPager`). Outside
          the motion.div — it animates `transform`, which would turn the wings' `fixed` into
          "fixed to the detail" and scroll them away with the text. */}
      {selected && (
        <DetailPager
          index={selectedIndex}
          total={filtered.length}
          onPrev={() => goTo(-1)}
          onNext={() => goTo(1)}
          prevLabel="Previous topic"
          nextLabel="Next topic"
        />
      )}

      {/*
       * The fluid-glass lens is GONE from this page (`components/FluidLens` is kept, unmounted,
       * as the experiment it was).
       *
       * It could not sample the DOM, so it magnified an html2canvas snapshot of the detail —
       * and when that snapshot did not arrive it fell back to a frosted disc, which on this
       * black page was simply a large grey ellipse parked next to the text. That is the second
       * thing following the hand, on a screen whose whole interaction depends on the visitor
       * trusting exactly one dot to be where they are pointing. The cursor's job here is to be
       * unambiguous, and it was already the layer that trapped a visitor once (see
       * `fluidLens.css` on the pointer-events bug).
       */}
    </div>
  );
}
