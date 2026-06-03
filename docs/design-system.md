# Design System

Source of truth for all visual decisions. The authoritative color spec is the
TUM print document at `assets/tum-color-print-spec.pdf`; this file translates it
into web-ready tokens and resolves web-specific decisions.

---

## 1. The color conflict (RESOLVED)

The TUM print spec lists the primary blue as **`#0065BD`**. The official TUM **web
logo** is drawn in **`#3070B3`**. These are different blues. Decision:

- **UI primary blue = `#0065BD`** (the print-spec primary). Use this for interactive
  accents, primary buttons, focus rings, key brand surfaces.
- **Logo keeps its native `#3070B3`.** Do NOT recolor the logo to `#0065BD`. It ships
  as-is from `assets/logo/`.

Both values live in the tokens package. They are distinct tokens with distinct names
(`brand.blue` vs `brand.logoBlue`) so they can never be confused or accidentally merged.

---

## 2. Color tokens

All from the TUM palette (print spec pages 1–2). Organized by role. These map 1:1
to `packages/tokens`.

### Primary
| Token | Hex | RGB | Notes |
|-------|-----|-----|-------|
| `brand.blue`      | `#0065BD` | 0/101/189  | **UI primary.** Pantone 300C, RAL 5017 |
| `brand.logoBlue`  | `#3070B3` | 48/112/179 | Logo only — never for UI fills |
| `brand.white`     | `#FFFFFF` | 255/255/255 | |
| `brand.black`     | `#000000` | 0/0/0 | |

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
- On dark backgrounds where `#3070B3` lacks contrast, use a **white** version of the
  logo (set SVG path fill to `brand.white`). Do not use `#0065BD`.
- Never stretch, rotate, add shadows, or place on a busy photo without a scrim.

---

## 4. Typography

The print spec governs print; for web pick a clean, neutral sans that pairs with the
TUM wordmark. Recommended (confirm with group if they have a license/preference):
- UI sans: a geometric/neutral grotesk (e.g. system stack `Inter`, or TUM's licensed
  face if available). Define as `--font-sans` token.
- Numerals for tickers/stats: tabular figures.

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
- **Near-white cool background** — not pure `#FFFFFF`. A very faint blue-gray tint.
- **Generous whitespace.** Let elements breathe; don't fill the canvas.
- **Oversized black display headlines** in a geometric sans. Big type IS the design.
- **A single high-chroma color block** as the one hero accent (Lusion uses a blue-violet;
  **we use TUM `brand.blue` `#0065BD` instead** — same structural role, TUM-compliant).
- **Pill-shaped buttons**: one dark solid (near-black) + one light/outline variant.
- **Imagery duotoned to the brand blue** — photos tinted toward `brand.blue` rather than
  shown full-color, so media reads as part of the palette.

> Important: do NOT copy Lusion's blue-violet hue. Borrow the *composition* (light base,
> big type, one strong color block, duotoned images) and apply TUM blue as that color.

### `theme.light` — the default, used everywhere
The content sections (People, Research, Student projects, Teaching, Photo), the idle
showreel by default, and the entire controller UI.

| Token | Value (guideline — tune to taste) | Role |
|-------|-----------------------------------|------|
| `bg`             | `#F4F5F9` (near-white, faint cool tint) | page background |
| `surface`        | `#FFFFFF` | cards, raised surfaces |
| `text.primary`   | `brand.black` `#000000` | headlines, body |
| `text.secondary` | `gray.80` `#333333` | secondary copy |
| `border`         | `gray.20` `#CCCCCC` | hairlines, dividers |
| `accent`         | `brand.blue` `#0065BD` | the single hero color block, links, focus |
| `button.solid`   | near-black `#1A1A1A` bg / white text | primary pill |
| `button.outline` | transparent bg / dark text / `border` outline | secondary pill |

Imagery: apply a duotone tint toward `brand.blue` for hero/section media to match the
reference. Keep this as a reusable treatment (a component/util), not per-image hacks.

### `theme.dark` — OPTIONAL kiosk idle backdrop only
Not a landing page, not user-navigable. Purpose: a calmer, less glaring backdrop for the
**idle showreel** when the kiosk runs unattended (e.g. evenings, to reduce glare/reflection
behind the glass). The interactive content sections always use `theme.light`.

- Build it only if/when wanted; `theme.light` is the priority. If unsure, ship light-only
  for the idle showreel too and add dark later.
- **Base is true black** (`brand.black` `#000000`) — maximal glare reduction behind the
  glass. `surface` is a near-black lift so raised cards read above the base. `brand.blue`
  and sparing accents glow against it; the **logo is recolored white** (the one allowed
  recolor, see §3).

| Token | Value | Role |
|-------|-------|------|
| `bg`             | `brand.black` `#000000` | page background (true black) |
| `surface`        | `#121212` | cards, raised surfaces (near-black lift) |
| `text.primary`   | `brand.white` `#FFFFFF` | headlines, body |
| `text.secondary` | `gray.20` `#CCCCCC` | secondary copy |
| `border`         | `gray.80` `#333333` | hairlines, dividers |
| `accent`         | `brand.blue` `#0065BD` | the single hero color block, links, focus |
| `button.solid`   | `brand.white` bg / `brand.black` text | primary pill |
| `button.outline` | transparent bg / white text / `gray.80` border | secondary pill |

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
