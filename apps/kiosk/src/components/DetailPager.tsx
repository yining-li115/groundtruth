import "./detailPager.css";

/**
 * Previous / next, for a detail page, as two transparent hand-sized side-edge targets.
 *
 * Both text-only details (a paper, an open topic) had the same pair of arrows: 1.75rem tall,
 * bottom centre, a hand's width apart. Fine for a mouse, and on the wall the single most missed
 * target on either page — an arrow that size is smaller than the drift a closing fist puts on
 * the cursor, so a visitor aimed at "next", closed their hand, and watched nothing happen.
 * Asked for in the Sept 2026 review: make them the left and right sides of the screen, and
 * make them glow rather than draw.
 *
 * Each is a broad half-ellipse the hand can drift inside. The shared particle backdrop draws
 * the permanent arrows, so these buttons do not add a panel, rule or glow over the artwork.
 *
 * Disabled at either end rather than hidden: a wing that vanishes when there is no further
 * paper reads as a control that broke, one that dims reads as a shelf with nothing on it.
 */
export function DetailPager({
  index,
  total,
  onPrev,
  onNext,
  prevLabel = "Previous",
  nextLabel = "Next",
}: {
  /** zero-based position of the open item */
  index: number;
  total: number;
  onPrev: () => void;
  onNext: () => void;
  prevLabel?: string;
  nextLabel?: string;
}) {
  return (
    <>
      <button
        type="button"
        data-hover
        className="dp-wing dp-wing--prev"
        aria-label={prevLabel}
        disabled={index <= 0}
        onClick={onPrev}
      >
        <span className="dp-wing__arrow" aria-hidden>
          ←
        </span>
      </button>
      <button
        type="button"
        data-hover
        className="dp-wing dp-wing--next"
        aria-label={nextLabel}
        disabled={index >= total - 1}
        onClick={onNext}
      >
        <span className="dp-wing__arrow" aria-hidden>
          →
        </span>
      </button>
    </>
  );
}
