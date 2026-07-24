/**
 * Asset colors for the cursor-grid experiment (CLAUDE.md rule 1 "Asset colors"
 * exception — a decorative WebGL/DOM effect layer, not UI). Replicates the reference
 * video's amber "lit glass" ramp; `ELECTRIC` is the drop-in brand-family alternative
 * (swap RAMP for it to TUM-ify the effect).
 */

/** energy 1 → 0 color ramp (fresh → dying), as [r,g,b] 0-255 */
export const RAMP: [number, number, number][] = [
  [255, 216, 40], // fresh — bright glowing yellow
  [235, 165, 20], // warm amber
  [150, 95, 45], // ember brown (almost gone)
];

export const ELECTRIC: [number, number, number][] = [
  [122, 162, 255], // airy blue
  [58, 58, 240], // brand electric
  [40, 34, 120], // deep indigo ember
];

/** page backdrop — the reference's warm light gray */
export const BG = "#c9c7c6";
