import { Color } from "three";

/**
 * ASSET color — NOT a design token (the point cloud is an asset, like a project photo;
 * see docs/design-system.md "Asset colors — exception"). A SINGLE indigo: form + density
 * express the object (city / satellite / car), not color. On the light page with normal
 * blending, dense areas build up dark and sparse/dispersing areas stay light — the value
 * gradient does the reading, like the reference.
 */
export const A = {
  point: new Color("#3a30d8"),
};
