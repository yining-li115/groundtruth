/**
 * @groundtruth/tokens — TUM design tokens.
 *
 * TS constants live here; the matching CSS variables live in `tokens.css` (import via
 * `@groundtruth/tokens/tokens.css`). Both define the same names; `theme.light` is the
 * default. Never hardcode a color anywhere outside this package (CLAUDE.md rule 1).
 */
export { palette } from "./palette";
export type { Palette } from "./palette";

export { themes, light, dark } from "./themes";
export type { ThemeTokens, ThemeName } from "./themes";
