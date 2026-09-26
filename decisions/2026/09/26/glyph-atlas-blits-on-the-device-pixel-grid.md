# Copy cached terminal glyphs on the device-pixel grid

Superseded in part on 2026-09-26 by `decisions/2026/09/26/native-terminal-font-rasterization.md`: bundled fonts now use native rasterization and integer physical row metrics. Pixel-aligned atlas copies remain; the phase machinery still serves browser-rendered fonts.

## Context

The remote terminal looked blurred beside Windows WezTerm. In the running Windows Firefox app, the same font and text were sharper when bypassing `src/mainview/terminal-glyph-atlas.ts`; its CSS-sized padding became 3.75 physical pixels at DPR 1.25, causing `drawImage` to resample already-antialiased glyphs.

## Investigation

At 16px, a Windows Firefox sweep of normal, bold, italic and bold-italic text across eight rows found 41,437 differing alpha pixels at DPR 1.25, 49,974 at 1.5 and 62,694 at 1.75; DPR 1 and 2 matched direct rendering. The final implementation has zero differing alpha pixels at all seven tested ratios: 1, 1.1, 1.25, 1.3, 1.5, 1.75 and 2. A draft approximating unsupported row phases still changed four pixels at 1.3, so that approximation was rejected.

## Decision

`slotGeometry` gives atlas slots and padding integer physical dimensions. `rasterise` stores up to four exact vertical subpixel phases; `draw` copies the appropriate phase between equal-size, pixel-aligned rectangles, retaining the original baseline position. Row placement is cached in scalar state, avoiding per-glyph allocation; integer-scale rows require only one raster. If the row grid needs more phases than the bound permits, the entire signature uses the existing direct renderer rather than approximating positions.

## Risks

Fractional scales may require up to four times the strip memory and initial glyph rasterization work; page/style caps remain bounded and reported byte counts include every phase. Unsupported row grids lose caching, particularly relevant to WebKit's expensive direct text path; see `decisions/2026/08/19/glyph-atlas-for-webkit-canvas-text.md`. The horizontal grid still relies on `deviceGridWidth` from `terminal-cell-metrics.ts`; matching the browser's direct rendering does not imply matching WezTerm's separate native rasterizer.

## Alternatives considered

Disabling caching at every fractional DPR would discard acceleration even at common, exactly representable scales. Rounding glyph positions or quantizing unsupported phases trades blur for changed glyph placement; increasing phase storage without a bound increases memory risk. Changing terminal row height to an integer device-pixel stride would avoid phases but alter existing layout, outside this fix.
