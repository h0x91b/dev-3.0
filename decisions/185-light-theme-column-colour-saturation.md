# 185 — Light-theme columns: fix the glass alpha, not just the colours

## Context

On the light theme, all eight kanban columns read as eight shades of white — a pale
peach column sat next to a pale blue one and next to a pale pink one with no
reliable way to tell which was which. The obvious diagnosis ("the column colours
are too pastel") is wrong: `STATUS_COLORS_LIGHT` held properly saturated values
such as `#6366f1` at `oklch(0.585 0.204 277)`.

## Investigation

The column tint is `.column-glow::before`, a gradient of the status colour at
`--glow-start-alpha` over `.glass-column` (white at `--glass-column-alpha`) over
the page gradient. Composited, a colour at 20% alpha over near-white glass keeps
roughly a quarter of its chroma:

| Column | Token chroma | Chroma as rendered |
|---|---|---|
| `in-progress` `#6366f1` | 0.204 | 0.047 |
| `review-by-colleague` `#8b5cf6` | 0.219 | 0.051 |

Measuring OKLCH distance between the *rendered* tints (not the hexes) put the
closest pair at **0.012** — visually one colour. Four more pairs sat under 0.030.
Cards then covered most of the column at `--glass-card-alpha: 0.72`, bleaching what
little tint was left.

## Decision

Three levers, in order of effect:

1. **Alpha** — light `--glow-start-alpha` 0.20 → 0.42, `--glow-mid-alpha` 0.06 →
   0.14, `--glow-line-alpha` 0.45 → 0.80; `--glass-card-alpha` 0.72 → 0.60 and
   `--glass-column-alpha` 0.52 → 0.46 so the tint survives the card on top of it.
2. **Colours at the gamut ceiling** — every `STATUS_COLORS_LIGHT` entry sits at the
   maximum sRGB chroma for its lightness, with hues re-spaced (15° → 40° → 95° →
   152° → 232° → 272° → 318°). `review-by-ai` stays deliberately neutral.
3. **Surfaces off the extremes** — no pure white and no pure black in the light
   theme, and every surface carries a little chroma, mirroring how the dark theme
   tints its navy surfaces.

Closest rendered pair went from 0.012 to **0.059**; the median pair roughly doubled.

## Risks

The light theme is now visibly more colourful, which is a taste call the user made
explicitly. Text contrast was re-measured against the new (slightly darker, tinted)
card surface and holds: `Lc 91 / 75 / 60 / 44` down the text ladder, and every
semantic colour is at `Lc 58+`.

The same measurement on the **dark** theme also reports close tints (min pair
0.013), but dark was left alone: there the identity is carried by the full-opacity
header text and the 2px top line against a near-black field, which this metric does
not capture. Do not "fix" dark on the strength of that number alone.

## Alternatives considered

- **Raise only the colours' saturation.** They were already near the sRGB ceiling;
  without the alpha change the rendered chroma barely moves.
- **Display-P3 colours** would genuinely extend the gamut, but the tokens are
  `R G B` triplets consumed as `rgb(var(--x) / <alpha>)` throughout Tailwind, so P3
  means changing the token format everywhere. Not worth it for this gain.
- **Give each column a different lightness** instead of chroma: easy to distinguish,
  but it implies a ranking between columns that does not exist.
