/**
 * Raw TUM palette — the exact values from docs/design-system.md §2, which in turn
 * derive from assets/tum-color-print-spec.pdf. This file (inside the tokens package)
 * is the ONLY place raw hex literals are allowed (CLAUDE.md rule 1). Everything else
 * — components, apps, themes — must reference these constants or the CSS variables.
 */
export const palette = {
  /** Primary brand colors. */
  brand: {
    /**
     * UI accent — the single high-chroma hero color (Lusion-inspired electric
     * blue-violet). Use for interactive accents, focus rings, the one hero color block.
     * NOT a TUM print color; it is the chosen web accent (design-system §1).
     */
    electric: "#3A3AF0",
    /**
     * TUM blue (print-spec primary, Pantone 300C / RAL 5017). RESERVED for TUM-brand /
     * logo-adjacent contexts only — NO LONGER the UI accent (use `brand.electric`).
     * Still distinct from `logoBlue` (design-system §1).
     */
    blue: "#0065BD",
    /**
     * Logo-only blue. The official TUM web wordmark is drawn in this hue. NEVER use it
     * for UI fills, and never recolor the logo to `brand.blue`. Distinct on purpose so
     * the blues can never be confused or merged (design-system §1).
     */
    logoBlue: "#3070B3",
    white: "#FFFFFF",
    black: "#000000",
  },
  /** Secondary blues — extend the spectrum (design-system §2). */
  secondary: {
    blue1: "#005293",
    blue2: "#003359",
  },
  /** Grays — TUM "Grautöne", black at 80/50/20%. */
  gray: {
    80: "#333333",
    50: "#808080",
    20: "#CCCCCC",
  },
  /**
   * Accent colors — USE SPARINGLY. Per the print spec these highlight, they never
   * fill: a glowing edge, one key word, a small indicator — never a background, card
   * fill, or long text passage. Also: never put `accent.orange` and `accent.green` in
   * the same view as two things the user must tell apart (red-green color-blindness).
   * (design-system §2 accent usage rules.)
   */
  accent: {
    beige: "#DAD7CB",
    orange: "#E37222",
    green: "#A2AD00",
    lightblue: "#98C6EA",
    midblue: "#64A0C8",
  },
} as const;

export type Palette = typeof palette;
