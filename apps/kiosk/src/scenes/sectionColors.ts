import type { View } from "../state/store";

/**
 * One colour per section — the home page's bands, and the menu button's sweep.
 *
 * These are the same colours in both places on purpose. The MENU toggle opens by sweeping
 * bands of colour across the screen, and the home page is those same bands standing still:
 * the sweep is not decoration, it is a preview of where each one goes. That only works if a
 * colour means the same thing in both, so the mapping lives here and both read it.
 *
 * THE PALETTE IS THE ONE THE PROJECT ALREADY USES — green, black, electric violet, orange,
 * plus TUM's mid-blue to reach five. Same colours as the student-project tags and the menu
 * sweep, so a visitor meets them in one consistent set rather than learning a new one here.
 *
 * Two notes, both from `docs/design-system.md` §2. It says the TUM accents highlight and
 * never fill, and these are full bands of colour; and it says orange and green should not
 * appear in one view as two things a visitor must tell apart, which is a red-green
 * colour-blindness point. Both were raised and the palette was chosen anyway, so the design
 * carries the mitigation instead: every band is labelled in words, numbered, and ordered —
 * nothing here is distinguished by hue alone, which is what that rule is really protecting.
 *
 * Everything here is a token CSS variable. No hex (CLAUDE.md rule 1).
 */
export interface SectionColor {
  /** band fill */
  bg: string;
  /** type and arrow drawn on it — black on the mid-tone fills, white on the dark ones,
   *  chosen for contrast rather than for consistency: white on orange is barely legible */
  fg: string;
}

export const SECTION_COLOR: Record<Exclude<View, "home">, SectionColor> = {
  research: { bg: "var(--gt-brand-electric)", fg: "var(--gt-brand-white)" },
  people: { bg: "var(--gt-accent-green)", fg: "var(--gt-brand-black)" },
  projects: { bg: "var(--gt-accent-orange)", fg: "var(--gt-brand-black)" },
  publications: { bg: "var(--gt-accent-midblue)", fg: "var(--gt-brand-black)" },
  teaching: { bg: "var(--gt-brand-black)", fg: "var(--gt-brand-white)" },
};

/** The order the bands stand in. Also the order the menu sweeps them. */
export const SECTION_ORDER: Array<Exclude<View, "home">> = [
  "research",
  "people",
  "projects",
  "publications",
  "teaching",
];

/** Just the fills, for the menu's prelayer sweep (it uses the first four). */
export const SWEEP_COLORS = SECTION_ORDER.map((k) => SECTION_COLOR[k].bg);
