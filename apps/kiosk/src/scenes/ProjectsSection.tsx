import { Fragment, Suspense, lazy, useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { gsap } from "gsap";
import { GooeyNav, Logo, type GooeyNavItem } from "@groundtruth/ui";
import type { OpenTopic, OpenTopicType } from "../../../../content/schema";
import { openTopics, personName } from "../lib/content";
import { KioskMenu } from "../components/KioskMenu";
import { navigate } from "../lib/navigate";
import { TAG_COLOR } from "./tagColors";
import "./projects.css";

// Lazy so html2canvas + the WebGL transmission material stay out of the main bundle.
const FluidLens = lazy(() =>
  import("../components/FluidLens").then((m) => ({ default: m.FluidLens })),
);

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
  // The fluid-glass lens is heavy motion — skip it entirely under reduced motion.
  const reducedMotion = useRef(
    typeof window !== "undefined" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches,
  ).current;

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
            initial={{ opacity: 0, y: 32 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 32 }}
            transition={{ duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
          >
            <button
              type="button"
              data-hover
              className="sp-detail-back"
              onClick={() => setSelected(null)}
            >
              ← Back
            </button>

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

            {/* Prev / next within the current filter. */}
            <div className="sp-detail-nav">
              <button
                type="button"
                data-hover
                className="sp-nav sp-nav--prev"
                aria-label="Previous topic"
                disabled={selectedIndex <= 0}
                onClick={() => goTo(-1)}
              >
                <svg viewBox="0 0 28 24" aria-hidden="true">
                  <path d="M24 12H3" />
                  <path d="M11 5L4 12l7 7" />
                </svg>
              </button>
              <span className="sp-nav-count">
                {selectedIndex + 1} / {filtered.length}
              </span>
              <button
                type="button"
                data-hover
                className="sp-nav sp-nav--next"
                aria-label="Next topic"
                disabled={selectedIndex >= filtered.length - 1}
                onClick={() => goTo(1)}
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

      {/* Fluid-glass lens — magnifies/refracts the open detail, following the cursor. */}
      {selected && !reducedMotion && (
        <Suspense fallback={null}>
          <FluidLens targetRef={detailRef} contentKey={selected.id} />
        </Suspense>
      )}
    </div>
  );
}
