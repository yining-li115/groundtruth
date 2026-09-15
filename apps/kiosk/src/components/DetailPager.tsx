import "./detailPager.css";

/**
 * Previous / next, for a detail page, as two wings of light on the side edges.
 *
 * Both text-only details (a paper, an open topic) had the same pair of arrows: 1.75rem tall,
 * bottom centre, a hand's width apart. Fine for a mouse, and on the wall the single most missed
 * target on either page — an arrow that size is smaller than the drift a closing fist puts on
 * the cursor, so a visitor aimed at "next", closed their hand, and watched nothing happen.
 * Asked for in the Sept 2026 review: make them the left and right sides of the screen, and
 * make them glow rather than draw.
 *
 * So each is now a half-ellipse of light bled in from its edge — the same construction as the
 * Home corner, and for the same reason: a soft target the shake cannot leave, and a scrim in
 * the page's own colour underneath it so the abstract scrolling past is dissolved rather than
 * overlapped. They sit at mid-height, above the Home corner's reach on the left, so the three
 * lights on a detail page never share a pixel.
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
      {/* Where you are. Not a control, and out of the way at the bottom. */}
      <span className="dp-count" aria-live="polite">
        {index + 1} / {total}
      </span>
    </>
  );
}
