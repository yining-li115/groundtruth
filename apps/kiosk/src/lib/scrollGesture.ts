/**
 * How a held hand turns into page scrolling. Pure arithmetic, no Lenis and no DOM, so the
 * feel can be pinned down by tests instead of by standing in front of a camera.
 */

/** Hand offset from the grab point, below which nothing scrolls, in screen fractions. */
/*
 * Matched to `DRAG_START` on purpose. When the deadzone was larger there was a band between
 * them where a lean was too big to be a tap and too small to scroll — so a hesitant scroll
 * gesture produced nothing at all, which is the single most confusing outcome a touchless
 * screen can offer. Now every lean does exactly one of the two.
 */
const SCROLL_DEADZONE = 0.025;
/** ...and the offset at which it reaches full speed. */
const SCROLL_FULL = 0.28;
/** Full speed, in pixels per second. About a screenful and a half. */
const SCROLL_MAX_SPEED = 2400;

/**
 * How fast a held hand should scroll the page, given how far it has moved from where it
 * grabbed. Returns pixels per second; positive scrolls the page down.
 *
 * VELOCITY, NOT POSITION. Dragging the page directly — the obvious mapping, and the one a
 * touchscreen uses — does not survive being done in mid-air. An arm has perhaps forty
 * centimetres of comfortable travel, so reaching the bottom of a long page means letting go,
 * moving the hand back, grabbing again, and repeating: the clutch that a finger performs
 * effortlessly by lifting off glass. Mid-air there is nothing to lift off, the release is the
 * least reliable part of the gesture, and when it is missed the hand travelling back up
 * un-scrolls exactly what it just scrolled. The page ends up oscillating under the hand.
 *
 * Leaning instead removes the clutch entirely: hold, move away from where you grabbed, and
 * the page keeps going for as long as you stay there; come back to the middle and it stops.
 * The same reason the campus flight steers by latched direction rather than by displacement.
 *
 * The ramp between the deadzone and full speed is what makes both ends usable — a nudge
 * creeps a paragraph, a reach travels a section — and the deadzone is what stops a tap that
 * wobbles from scrolling anything at all.
 */
export function dragScrollVelocity(offset: number): number {
  const mag = Math.abs(offset);
  if (mag <= SCROLL_DEADZONE) return 0;
  const t = Math.min(1, (mag - SCROLL_DEADZONE) / (SCROLL_FULL - SCROLL_DEADZONE));
  // Eased rather than linear, so the slow end has real resolution instead of the whole
  // useful range being crushed against the deadzone.
  return Math.sign(offset) * t * t * SCROLL_MAX_SPEED;
}
