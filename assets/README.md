# Assets

Brand source files. The design tokens in `packages/tokens` are derived from these —
when there's any doubt about a color, the PDF wins for values, and
`docs/design-system.md` wins for web application decisions.

## Files

| File | What it is | Use |
|------|-----------|-----|
| `tum-color-print-spec.pdf` | Official TUM color spec (print) | Reference for exact hex/RGB/Pantone values. Source of `docs/design-system.md` §2. |
| `logo/tum-logo.svg` | TUM web wordmark, vector, `#3070B3`, transparent | **Preferred** logo for all web use. Recolor to white only on dark backgrounds. |
| `logo/tum-logo.png` | Raster fallback, 73×38, transparent | Fallback when SVG can't be used. |
| `logo/tum-logo@2x.png` | Raster fallback, 146×76, transparent | Retina fallback. |

## Logo rules (summary — full version in design-system.md §3)
- Logo blue is `#3070B3` and stays that way. Do NOT recolor it to TUM blue `#0065BD` or to the UI accent `#3A3AF0`.
- On dark backgrounds, use a white logo (SVG `fill` → white). That's the only allowed recolor.
- Keep clear space ≥ the height of the logo's bar. No stretch, rotate, or shadow.

## Color quick reference (authoritative table is design-system.md)
- UI accent (the single hero color): `#3A3AF0` (electric blue-violet, `brand.electric`)
- TUM blue (logo/brand contexts only — not the UI accent): `#0065BD`
- Logo blue: `#3070B3`
- Accents (sparing only): orange `#E37222`, green `#A2AD00`, beige `#DAD7CB`,
  light blue `#98C6EA`, mid blue `#64A0C8`
- Never use orange and green together to distinguish things (color-blindness rule).
