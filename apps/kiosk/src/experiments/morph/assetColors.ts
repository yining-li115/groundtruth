import { Color } from "three";

/**
 * ASSET colors for the scroll-morph experiment — NOT design tokens (see
 * docs/design-system.md "Asset colors — exception"; the particle cloud is an asset).
 *
 * Each shape carries a two-colour gradient (a → b, bottom → top of the model, with
 * per-particle jitter); the cloud cross-fades palettes while it morphs. The first shape
 * keeps the home hero's brand indigo so the experiment still opens on-brand; the pages
 * then travel through distinct but related high-chroma families. `css` mirrors `a` for
 * the DOM (the card's tag line picks up its shape's accent).
 */
export interface ShapePalette {
  a: Color;
  b: Color;
  css: string;
}

const P = (a: string, b: string): ShapePalette => ({
  a: new Color(a),
  b: new Color(b),
  css: a,
});

export const SHAPE_PALETTES: ShapePalette[] = [
  P("#3a30d8", "#7aa2ff"), // city — brand indigo → airy blue (the home hero identity)
  P("#e8590c", "#ffb13d"), // car — signal orange → amber
  P("#0f8fb1", "#79d7f7"), // satellite — deep cyan → sky
  P("#8d2ee0", "#e85dcb"), // people — violet → magenta
  P("#3a30d8", "#e8590c"), // dust — indigo ↔ orange, heavily jittered = confetti of data
];

/** Extra per-particle hue jitter for the dust finale (0..1, mixes a↔b harder). */
export const DUST_JITTER = 0.9;
