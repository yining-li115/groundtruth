/**
 * Scramble palette for the TypeShuffle "decode" effect (experiments/people detail page).
 *
 * These are EFFECT / asset colors — the transient per-character hues a glyph flashes
 * through *while* it is decoding, part of fx5's identity (the green→blue terminal look
 * from Codrops' TypeShuffle). Per design-system §2 "Asset colors", effect colors live in
 * a clearly-labelled file next to the scene rather than in the token palette. The token
 * palette still governs the RESTING UI here: the page background and the settled text
 * color come from the dark-theme tokens (--gt-bg / --gt-text-primary) — only these
 * mid-animation flashes are off-token, and only for the duration of the shuffle.
 *
 * Values are the upstream fx5 colors, kept verbatim for 1:1 fidelity with the reference.
 */
export const EFFECT_COLORS: readonly string[] = ["#3e775d", "#61dca3", "#61b3dc"];
