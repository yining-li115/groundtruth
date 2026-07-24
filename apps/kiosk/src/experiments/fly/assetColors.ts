import { Color } from "three";

/**
 * ASSET colors for the fly-through particle world — NOT design tokens (see
 * docs/design-system.md "Asset colors — exception"). One persistent world, coloured by
 * ELEMENT: each object family gets a two-colour ramp (bottom → top + per-particle
 * jitter), so the world reads colourful but semantic — city is the brand indigo, the
 * sensors each own a family. `css` feeds the DOM card accents at each camera stop.
 */
export interface Ramp {
  a: Color;
  b: Color;
}
const R = (a: string, b: string): Ramp => ({ a: new Color(a), b: new Color(b) });

export const ELEMENT_RAMPS = {
  city: R("#3a30d8", "#7aa2ff"), // brand indigo → airy blue
  car: R("#e8590c", "#ffb13d"), // signal orange → amber
  satellite: R("#0f8fb1", "#79d7f7"), // deep cyan → sky
  drone: R("#8d2ee0", "#e85dcb"), // violet → magenta
  lines: R("#7aa2ff", "#b9ccff"), // faint data streams
};

/** Abstract-ink mode for the splat fly-through: the campus rendered as near-black dust
 *  (real geometry, monochrome material — per-splat value jitter keeps it papery). */
export const INK = new Color("#232019");

/** Card accent per camera stop (overview, city, car, satellite, drone, finale). */
export const STOP_ACCENTS = [
  "#3a30d8",
  "#3a30d8",
  "#e8590c",
  "#0f8fb1",
  "#8d2ee0",
  "#e8590c",
];
