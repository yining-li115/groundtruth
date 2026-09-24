/**
 * A geometrically centred right arrow for the home-page destination controls.
 *
 * The previous character arrow was centred by its font's line box, so its visible stroke sat
 * differently in the circle at different sizes. This path has explicit, symmetric bounds in a
 * square viewBox instead; the surrounding control still owns sizing, colour and hover motion.
 */
export function ArrowRightIcon() {
  return (
    <svg
      className="gt-arrow-right"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M4.5 12h15M13.5 6l6 6-6 6" />
    </svg>
  );
}
