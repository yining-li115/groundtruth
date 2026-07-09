import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { showreel } from "../lib/content";
import { useHandHeadControl } from "../lib/vision/useHandHeadControl";
import "./showreel/showreel.css";

/**
 * Showreel — the idle / attract screen (docs/architecture.md §6). Unattended auto-play:
 * the TUM-campus particle cloud lives on the RIGHT as a semi-transparent backdrop that slowly
 * turns; the group's news / spotlight / open positions auto-carousel on the LEFT. When a
 * visitor raises a hand, they can grab the cloud — drag to rotate, open palm = disperse,
 * fist = reassemble (via useHandHeadControl → heroOrbit). Cycles content/showreel.json.
 *
 * Person-presence gating (activate only when someone walks past) comes later.
 * Preview at /?view=showreel.
 */
const ShowreelStage = lazy(() =>
  import("./showreel/ShowreelStage").then((m) => ({ default: m.ShowreelStage })),
);

const KIND_LABEL: Record<string, string> = {
  spotlight: "Spotlight",
  news: "News",
  "open-topic": "Open position",
};

const DWELL = 6500; // ms each news item stays on the left

export function Showreel() {
  const items = showreel;
  const [index, setIndex] = useState(0);
  // hand control of the cloud (drag = rotate, open palm = disperse, fist = reassemble)
  const progress = useRef(1);
  const { videoRef } = useHandHeadControl(progress);

  useEffect(() => {
    if (items.length < 2) return;
    const id = setInterval(() => setIndex((i) => (i + 1) % items.length), DWELL);
    return () => clearInterval(id);
  }, [items]);

  const item = items[index];

  return (
    <div className="sr-root" data-theme="dark">
      {/* right: semi-transparent, hand-controllable point-cloud backdrop */}
      <Suspense fallback={null}>
        <ShowreelStage progressRef={progress} />
      </Suspense>

      {/* hidden webcam feed that drives the hand tracking */}
      <video ref={videoRef} className="sr-cam" playsInline muted />

      {/* left scrim so the news reads over the cloud */}
      <div className="sr-veil" />

      {/* left: auto-carouseling news / spotlight / open positions */}
      <div className="sr-news">
        <AnimatePresence mode="wait">
          {item && (
            <motion.article
              key={item.id}
              className="sr-item"
              initial={{ opacity: 0, x: -28 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: 20 }}
              transition={{ duration: 0.6, ease: [0.16, 1, 0.3, 1] }}
            >
              {item.media?.kind === "image" && (
                <div className="sr-item__media">
                  <img src={item.media.src} alt={item.media.caption ?? ""} />
                </div>
              )}
              <span className="sr-item__kind">{KIND_LABEL[item.kind] ?? item.kind}</span>
              <h2 className="sr-item__title">{item.title}</h2>
              {item.blurb && <p className="sr-item__blurb">{item.blurb}</p>}
              {item.cta && <span className="sr-item__cta">{item.cta} →</span>}
            </motion.article>
          )}
        </AnimatePresence>

        <div className="sr-dots">
          {items.map((it, i) => (
            <span key={it.id} className={`sr-dot ${i === index ? "is-on" : ""}`} />
          ))}
        </div>
      </div>

      <div className="sr-hint">✋ raise a hand to explore the model</div>
      <div className="sr-brand">Photogrammetry &amp; Remote Sensing · TUM</div>
    </div>
  );
}
