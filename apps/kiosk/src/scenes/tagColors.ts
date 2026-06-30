/**
 * Off-token category colours for the Student-Projects tags.
 *
 * The user explicitly allowed these tag colours to step OUTSIDE the enforced token palette
 * (CLAUDE.md rule 1) for category-coding — same spirit as the "asset colours" exception
 * (design-system §2): a single, clearly-labelled place. Three reuse existing accent tokens
 * (electric / green / orange); two are bespoke hues chosen to stay distinct and legible on
 * the dark page. Edit colours here only.
 */
import type { OpenTopicType } from "../../../../content/schema";

export const TAG_COLOR: Record<OpenTopicType, string> = {
  IDP: "var(--gt-accent)", // electric blue-violet #3A3AF0
  "Guided Research": "var(--gt-accent-green)", // #A2AD00 — the green used in the menu sweep
  "Semester Arbeit": "var(--gt-accent-orange)", // #E37222
  "Bachelor Thesis": "#16c2c2", // bespoke teal (off-token, sanctioned)
  "Master Thesis": "#e5447f", // bespoke magenta (off-token, sanctioned)
};
