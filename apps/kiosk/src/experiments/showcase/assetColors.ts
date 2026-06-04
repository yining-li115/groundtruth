import { Color } from "three";

/**
 * ASSET colors — NOT design tokens (the point cloud is an asset, like a project photo;
 * see docs/design-system.md "Asset colors — exception"). Tuned for a LIGHT page: a
 * near-black "ink" base with a mostly-blue accent set, so dark points read crisply on
 * the light hero (normal blending — additive would wash out on light).
 */
export const A = {
  ink: new Color("#101218"), // near-black base (was white; light bg now)
  electric: new Color("#3a3af0"),
  blue: new Color("#2f5bff"),
  teal: new Color("#1f8fff"),
  cyan: new Color("#16c1d6"),
};

/** Mostly-blue accent set (no magenta/green — "mainly blue"). */
export const A_BLUES: Color[] = [A.electric, A.blue, A.teal, A.cyan];
