# Fit cell-edge glyphs onto the cell box instead of trusting ghostty-web's metrics

## Context

Powerline caps in the web terminal sat ~2px above the coloured segment they were
supposed to join, and bars drawn out of `U+2588` came out striped with 1px
vertical seams. Native Ghostty 1.3.1 renders the same script in the same font
pixel-perfect, and the font files say the glyphs are 100–101% of the line box, so
neither the font nor the user's config could explain it.

## Investigation

`measureFont` in `node_modules/ghostty-web/dist/ghostty-web.js` derives the cell
from the **ink box of a capital "M"** — `Math.ceil(ascent + descent) + 2` tall,
`Math.ceil(advance)` wide — while `renderCellText` draws every glyph into the
font's own line box at the font's own advance. At 14px JetBrains Mono that is a
16px cell against an 18px line box (the glyph starts 2px above the cell) and a
9px cell against an 8.4px advance (0.6px of bare cell per column). On device
pixels: the block glyph's extent was 5 device px above the background rect, with
one dead column per cell; a `U+E0B0` separator even bled into the neighbouring
cell's column.

## Decision

`src/mainview/terminal-glyph-cell-fit.ts` patches `renderCellText` per renderer
instance (same idiom as `installGlyphCellFit`'s neighbours
`installCursorVisibilityGate` and `installBidiRender`), clips to the exact cell
box, and maps the glyph's source box onto it — for box-drawing, block and
powerline codepoints only. Glyphs whose ink covers the whole design box (`U+2588`,
`U+E0B0`–`U+E0BF`) are fitted by their **ink box**; partial glyphs (half blocks,
box corners, shades) by the **font's line box**, so they keep their proportions.
Installed in `TerminalView.tsx` next to the cursor gate.

Full-cell glyphs are grown **one device pixel past every edge** and cut back by
the clip. Landing the measured ink exactly on the cell edge leaves the outermost
device row only ~76% covered at font size 20 — a hairline between vertically
stacked blocks. With the overshoot, a solid block area measures 1.000 coverage at
sizes 13/14/15/16/18/20; it also fixes a 0.958 seam the vendor itself had at 14.

## Risks

Box-drawing lines lose ~10–19% of their ink (measured), because a 1px line
stretched by `cellWidth / advance` ≈ 1.05 antialiases — they are slightly softer
in exchange for actually joining across rows. Relies on three private members of
`CanvasRenderer` (`renderCellText`, `fontSize`, `fontFamily`), so a vendor bump
must be re-checked; the fit degrades to the vendor's own path if any measurement
is missing. The cell is still 2px shorter than the font's line box, so descenders
still overflow into the row below — invisible only because a black background is
skipped rather than painted.

## Alternatives considered

Correcting the cell metrics to the real line box (13→18px at size 14) fixes
alignment and descender clipping but costs every user ~38% of their rows; parked
as a separate decision. A procedural sprite table for the ~40 block and powerline
glyphs (what native Ghostty does) is exact but would have to duplicate the
vendor's selection/inverse/faint colour logic to pick a fill colour; the
overshoot-and-clip reaches the same pixels without it. Upstreaming to
`coder/ghostty-web` was declined for now.
