import { palette } from "./palette";

/**
 * Theme token contract. `light` and `dark` define the SAME token names; components
 * switch themes by swapping the token set (or toggling `[data-theme]` for CSS vars),
 * NEVER by branching on a hardcoded color (design-system §5 "Token discipline").
 */
export type ThemeTokens = {
  /** Page background. */
  bg: string;
  /** Cards, raised surfaces. */
  surface: string;
  text: {
    /** Headlines, body. */
    primary: string;
    /** Secondary copy. */
    secondary: string;
  };
  /** Hairlines, dividers. */
  border: string;
  /** The single hero color block, links, focus. */
  accent: string;
  button: {
    /** Primary pill. */
    solid: { bg: string; text: string };
    /** Secondary pill. */
    outline: { bg: string; text: string; border: string };
  };
};

/**
 * theme.light — the DEFAULT, used everywhere: all content sections, the controller UI,
 * and the idle showreel by default (design-system §5). Lusion post-entry look: a
 * near-white cool base, big black type, one TUM-blue accent.
 */
export const light: ThemeTokens = {
  bg: "#F4F5F9",
  surface: palette.brand.white,
  text: {
    primary: palette.brand.black,
    secondary: palette.gray[80],
  },
  border: palette.gray[20],
  accent: palette.brand.blue,
  button: {
    solid: { bg: "#1A1A1A", text: palette.brand.white },
    outline: { bg: "transparent", text: palette.brand.black, border: palette.gray[20] },
  },
};

/**
 * theme.dark — OPTIONAL kiosk idle backdrop ONLY (design-system §5). Not a landing
 * page, not user-navigable. A true-black backdrop (`brand.black`) for the unattended
 * idle showreel — maximal glare reduction behind the glass. `surface` is a near-black
 * lift so raised cards read above the base. On this backdrop the logo is recolored
 * white — the one allowed recolor (design-system §3).
 */
export const dark: ThemeTokens = {
  bg: palette.brand.black,
  surface: "#121212",
  text: {
    primary: palette.brand.white,
    secondary: palette.gray[20],
  },
  border: palette.gray[80],
  accent: palette.brand.blue,
  button: {
    solid: { bg: palette.brand.white, text: palette.brand.black },
    outline: { bg: "transparent", text: palette.brand.white, border: palette.gray[80] },
  },
};

export const themes = { light, dark } as const;
export type ThemeName = keyof typeof themes;
