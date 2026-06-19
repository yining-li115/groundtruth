# Design System

Source of truth for all visual decisions. The authoritative color spec is the
TUM print document at `assets/tum-color-print-spec.pdf`; this file translates it
into web-ready tokens and resolves web-specific decisions.

---

## 1. The accent + the two blues (RESOLVED)

Three distinct colors, three distinct jobs — kept as separate tokens so they can never
be confused or merged:

- **UI accent = `#3A3AF0`** (`brand.electric`) — an **electric blue-violet**, Lusion-
  inspired. This is the single high-chroma hero color: interactive accents, primary
  buttons/focus rings, the one hero color block. *(Base version; may be tuned further.)*
- **TUM blue = `#0065BD`** (`brand.blue`, the print-spec primary, Pantone 300C / RAL
  5017) — **RESERVED for TUM-brand / logo-adjacent contexts only.** It is **no longer
  the UI accent**. Don't reach for it for general interactive accents; use
  `brand.electric`.
- **Logo blue = `#3070B3`** (`brand.logoBlue`) — the official web wordmark's native
  hue. The logo **ships as-is** from `assets/logo/`; never recolor it to `#0065BD` or
  to the accent (white recolor on dark backgrounds is the only exception, see §3).

All three live in the tokens package as distinct names (`brand.electric` /
`brand.blue` / `brand.logoBlue`).

---

## 2. Color tokens

All from the TUM palette (print spec pages 1–2). Organized by role. These map 1:1
to `packages/tokens`.

### Primary
| Token | Hex | RGB | Notes |
|-------|-----|-----|-------|
| `brand.electric` | `#3A3AF0` | 58/58/240  | **UI accent** — single hero color (Lusion-inspired blue-violet). Not a TUM print color. |
| `brand.blue`     | `#0065BD` | 0/101/189  | TUM blue (Pantone 300C, RAL 5017). **Logo/brand contexts only — not the UI accent.** |
| `brand.logoBlue` | `#3070B3` | 48/112/179 | Logo only — never for UI fills |
| `brand.white`    | `#FFFFFF` | 255/255/255 | |
| `brand.black`    | `#000000` | 0/0/0 | |

### Secondary (extend the spectrum; print spec allows 80/50/20% tints)
| Token | Hex | RGB |
|-------|-----|-----|
| `secondary.blue1` | `#005293` | 0/82/147 |
| `secondary.blue2` | `#003359` | 0/51/89 |

### Grays (print spec "Grautöne" — black at 80/50/20%)
| Token | Hex | RGB |
|-------|-----|-----|
| `gray.80` | `#333333` | 51/51/51 |
| `gray.50` | `#808080` | 128/128/128 |
| `gray.20` | `#CCCCCC` | 204/204/204 |

### Accent colors — USE SPARINGLY
The print spec is explicit: accent colors are for special emphasis, **never for long
text passages or large fills, used very little and never as a background.**
Also: **orange and green must not be used together** (red-green color-blindness) —
use them to distinguish only when one is present, or for separate purposes.

| Token | Hex | RGB | Pantone |
|-------|-----|-----|---------|
| `accent.beige`   | `#DAD7CB` | 218/215/203 | 7527 |
| `accent.orange`  | `#E37222` | 227/114/34  | 158 |
| `accent.green`   | `#A2AD00` | 162/173/0   | 383 |
| `accent.lightblue` | `#98C6EA` | 152/198/234 | 283 |
| `accent.midblue`   | `#64A0C8` | 100/160/200 | 542 |

### Accent usage rules (enforced)
- Accents highlight, they don't fill. A glowing edge, a single key word, a small
  indicator — yes. A section background, a card fill, a paragraph color — no.
- Never put `accent.orange` and `accent.green` in the same view as the two things
  the user must tell apart.

### Asset colors — exception
Visual **assets** — WebGL scenes (e.g. the hero point cloud), photos, project imagery —
are *content*, not UI, and are **not** bound to the token palette (project photos are
naturally multi-coloured). Such asset colors may live outside `packages/tokens` in a
clearly-labelled file (e.g. `assetColors.ts` next to the scene). Rule 1's "no hardcoded
colors" applies to the **UI** (type, panels, menus, buttons, backgrounds) — those still
use tokens. The hex-audit should exclude flagged asset files.

---

## 3. Logo

Files in `assets/logo/`:
- `tum-logo.svg` — vector, preferred for web. 73×38 viewBox. Single path, `#3070B3`,
  transparent background.
- `tum-logo.png` / `tum-logo@2x.png` — raster fallback (73×38 / 146×76), transparent.

Rules:
- Prefer the SVG. It scales cleanly and can be recolored to white via CSS `fill` ONLY
  for the dark-background case (see below) — that is the one allowed recolor.
- Clear space: keep padding around the logo at least the height of the "T" bar.
- Monochrome recolors allowed: **white** on dark backgrounds, **black** on light
  backgrounds (e.g. the kiosk hero). Those two are the only recolors — never `#0065BD`
  / the UI accent.
- Never stretch, rotate, add shadows, or place on a busy photo without a scrim.

---

## 4. Typography

**UI typeface — RESOLVED: TUM Neue Helvetica** (the official TUM identity font). It is
wired up as the `--font-sans` token; everything inherits it by default.

- **Files:** source TTFs (Regular / Bold / Italic / BoldItalic) live in `assets/fonts/`
  as provenance. Web-optimised **WOFF2** versions live in
  `packages/tokens/src/fonts/` and are loaded via `@font-face` in
  `packages/tokens/src/tokens.css`. Because every app and Storybook imports that
  stylesheet, the fonts are bundled once from the tokens package — no per-app copies.
- **Token:** `--font-sans` is defined in `tokens.css` (with a system-sans fallback
  chain: `ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Helvetica,
  Arial, sans-serif`). It is set unlayered, so it also overrides Tailwind's default
  `--font-sans` — the `font-sans` utility and the global default both resolve to TUM
  Neue Helvetica. A `--gt-font-sans` alias mirrors it for our `--gt-*` convention.
- **Faces shipped:** 400 normal, 700 normal, 400 italic, 700 italic.
- **Verify:** Storybook → *Foundations / Typography* renders a specimen (weights +
  italics, with a serif contrast row) to confirm the font actually loaded.
- Numerals for tickers/stats: tabular figures (use where available).
- License: TUM-licensed identity font; keep its use within TUM/PF contexts.

Scale (define as tokens, don't hardcode px in components):
- Display (kiosk hero): large, set per-scene.
- h1 / h2 / h3 / body / caption — standard modular scale.

Two weights in UI: regular (400) and medium (500). Avoid heavy 700 except for the
kiosk display headlines where viewing distance justifies it.

---

## 5. Theming — RESOLVED (light-first, no landing page)

> **DECIDED.** There is **no separate landing/attract page**. The whole site uses one
> **light theme** as the default and primary look, mirroring Lusion's *post-entry*
> aesthetic (not its dark loader). A dark token set is kept ONLY as an optional kiosk
> idle backdrop (see below) — it is not a landing page and not a second "mode" the user
> navigates into.

### The look we're matching (from the Lusion reference screenshot)
The high-end feel comes from restraint, not color volume:
- **Near-white lavender background** — not pure `#FFFFFF`. A very faint cool
  lavender tint (`bg` = `#F7F6FB`).
- **Generous whitespace.** Let elements breathe; don't fill the canvas.
- **Oversized black display headlines** in a geometric sans. Big type IS the design.
- **A single high-chroma color block** as the one hero accent — an **electric blue-violet**
  (`brand.electric` `#3A3AF0`), the Lusion-style accent.
- **Pill-shaped buttons**: one dark solid (near-black) + one light/outline variant.
- **Imagery duotoned to the accent** — photos tinted toward `brand.electric` rather than
  shown full-color, so media reads as part of the palette.

> Note: the hero accent is the electric blue-violet `brand.electric` `#3A3AF0` (base
> version — may be tuned). TUM blue `#0065BD` is reserved for logo/brand contexts and is
> **not** the UI accent.

### `theme.light` — the default, used everywhere
The content sections (People, Research, Student projects, Teaching, Photo), the idle
showreel by default, and the entire controller UI.

| Token | Value (guideline — tune to taste) | Role |
|-------|-----------------------------------|------|
| `bg`             | `#F7F6FB` (near-white, faint lavender tint) | page background |
| `surface`        | `#FFFFFF` | cards, raised surfaces |
| `text.primary`   | `brand.black` `#000000` | headlines, body |
| `text.secondary` | `gray.80` `#333333` | secondary copy |
| `border`         | `gray.20` `#CCCCCC` | hairlines, dividers |
| `accent`         | `brand.electric` `#3A3AF0` | the single hero color block, links, focus |
| `button.solid`   | near-black `#1A1A1A` bg / white text | primary pill |
| `button.outline` | transparent bg / dark text / `border` outline | secondary pill |

Imagery: apply a duotone tint toward `brand.electric` (the accent) for hero/section
media to match the reference. Keep this as a reusable treatment (a component/util), not
per-image hacks.

### `theme.dark` — idle backdrop + the Projects section
Originally only the optional idle backdrop. Purpose there: a calmer, less glaring backdrop
for the **idle showreel** when the kiosk runs unattended (e.g. evenings, to reduce
glare/reflection behind the glass). Most interactive content sections use `theme.light`.

- Build it only if/when wanted; `theme.light` is the priority. If unsure, ship light-only
  for the idle showreel too and add dark later.
- **Base is true black** (`brand.black` `#000000`) — maximal glare reduction behind the
  glass. `surface` is a near-black lift so raised cards read above the base. The accent
  (`brand.electric`) and sparing accents glow against it; the **logo is recolored white**
  (the one allowed recolor, see §3).

| Token | Value | Role |
|-------|-------|------|
| `bg`             | `brand.black` `#000000` | page background (true black) |
| `surface`        | `#121212` | cards, raised surfaces (near-black lift) |
| `text.primary`   | `brand.white` `#FFFFFF` | headlines, body |
| `text.secondary` | `gray.20` `#CCCCCC` | secondary copy |
| `border`         | `gray.80` `#333333` | hairlines, dividers |
| `accent`         | `brand.electric` `#3A3AF0` | the single hero color block, links, focus |
| `button.solid`   | `brand.white` bg / `brand.black` text | primary pill |
| `button.outline` | transparent bg / white text / `gray.80` border | secondary pill |

### Exception — the Projects AND Research sections are dark (DECIDED)
Two sections now opt into `theme.dark` (`data-theme="dark"` on their root): **Projects**
(papers) and **Research** (`apps/kiosk/src/scenes/ResearchSection.tsx` — the topics shown as
an Osmo-style draggable image slider; the photography reads best on black). With a second dark
section, the note below ("If more sections ever want dark, revisit whether dark should become a
selectable mode") is now live — worth revisiting if a third wants it. People, Home, Teaching and
the controller stay `theme.light`.

The **Projects section** (`apps/kiosk/src/scenes/ProjectsSection.tsx` — the group's
papers/publications) is rendered in **`theme.dark`** (`data-theme="dark"` on its root),
a **deliberate exception** to the light-first rule. It's the one full-page dark surface a
visitor navigates into; the oversized white "PROJECTS" type, dimmed menu, and the accent
on hover/links read best on black, and the paper figures (varied, often dark) sit cleaner
on a true-black ground than on the lavender base. The rest of the kiosk (Home, People,
Research, Teaching, the controller) stays `theme.light`. This is scoped via `data-theme`
on that section only — no hardcoded colors; it just swaps the token set (see Token
discipline below). If more sections ever want dark, revisit whether dark should become a
selectable mode rather than a per-section exception.

### Token discipline
Both theme sets define the **same token NAMES** (`bg`, `surface`, `text.primary`,
`text.secondary`, `border`, `accent`, `button.solid`, `button.outline`). Components switch
theme by swapping the token set — never by branching on a hardcoded color. Default everything
to `theme.light`.

---

## 6. Motion principles (Lusion-inspired)

- Easing: prefer custom cubic-beziers with a slow-out, never linear. GSAP defaults
  like `power3.out` are a good baseline.
- Smooth scroll via Lenis everywhere on the kiosk.
- Text reveals: stagger by word or line on section entry.
- Transitions between sections: deliberate, ~0.6–1.0s, never instant cuts.
- Cursor (driven by phone): smooth follow with slight lag/inertia, not 1:1 snapping —
  this both feels premium and hides network jitter.
- Honor `prefers-reduced-motion` on the controller (see CLAUDE.md rule 5).
