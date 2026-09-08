# Terminal cell width is quantized on the device pixel grid, not ceiled in CSS pixels

Companion to `cell-height-from-the-font-line-box.md`, which shipped the height axis of
issue #1668 and deliberately left the width alone. This record closes the width axis and
**supersedes that record's claim** that device rounding would break the reference clamp —
measurement showed the opposite.

## Context

Issue #1668 also reported a wider cell than Ghostty: 10 CSS px against 9.5 for JetBrains
Mono at size 16 on a 2x display. The height record called Ghostty's rule an inference from
that one number and declined to act on it.

## Investigation

**Ghostty's rule, read from Ghostty** (`ghostty-org/ghostty`, `src/font/Metrics.zig`,
`fn calc()`, `main` as of 2026-09-08):

```zig
const cell_width  = @round(face_width);   // in px at the render scale — device pixels
const cell_height = @round(face_height);
```

Its own comment gives the reason and accepts the cost:

> We use `@round` for the cell width to limit the difference from the "true" width value
> to no more than 0.5px. This is a better approximation of the authorial intent of the
> font than ceiling would be, and makes the apparent spacing match better between low and
> high DPI displays. […] This does mean that it's possible for a glyph to overflow the
> edge of the cell by a pixel if it has no side bearings, but in reality such glyphs are
> generally meant to connect to adjacent glyphs in some way so it's not really an issue.

So 9.5 CSS px is exactly `@round(9.6 × 2) / 2`. The inference is now a fact.

Two equivalences make the rule transferable, both measured rather than assumed:
`face_width` is the **max advance over printable ASCII 32–126**, and that equals the
advance of `"M"` — which is what ghostty-web measures — in **all 400** bundled font/size
pairs; and Ghostty's vertical metrics come from `hhea`, then OS/2 `sTypo*`, then `usWin*`,
which is what both browser engines already report as `fontBoundingBox*`.

**Our `ceil` is not merely 0.5 px coarser — it breaks an invariant we wrote ourselves.**
Sweeping the advance of `"M"` for all 16 bundled fonts at every user size 8–32, at the
fractional sizes `scaledTerminalFontSize()` actually produces, in Chromium and WKWebView
(400 pairs per engine):

| Rule | Reference-clamp violations | Desktop vs browser disagree on the cell |
|---|---|---|
| `ceil` in CSS px (before) | **8 of 400**, WKWebView only | **8 of 400** |
| `round` in CSS px | 0 | 0 |
| `round` on the device grid | 0 | 0 |

The eight are Hack and MesloLGS (`scale: 0.9966`) at sizes 15, 20, 25, 30. The trimmed
size puts the advance a hair above an integer and `ceil` promotes the hair to a whole
pixel: at size 15 Chromium measures 8.9946 and WKWebView 9.0001, so `ceil` yields 9 and
10. Confirmed end to end through the real `CanvasRenderer` — in WKWebView, Hack and Meslo
at user size 15 grid a **10 px** cell against the reference font's **9 px**, which is
precisely what `terminal-font.ts` exists to prevent, and both become 9 px under the new
rule.

## Decision

`deviceGridWidth()` in `src/mainview/terminal-cell-metrics.ts` returns
`max(1, round(advance × ratio)) / ratio`, and the `measureFont` wrapper uses it for
`width`. The ratio read is **the renderer's own captured `devicePixelRatio`**, never
`window.devicePixelRatio`: the vendor reads the window value once in its constructor and
every later `resize()` scales the canvas by that captured number, so sizing the cell from
the live window value would let the cell and the canvas transform disagree. Reading the
same field keeps them in lockstep.

The `scale` constants in `BUNDLED_TERMINAL_FONTS`, the font list, the picker and app zoom
are untouched — measurement showed the clamp holds with the current constants.

Verified through the real renderer with the full wrapper stack (cell metrics, glyph cell
fit, glyph atlas) at both ratios: stacked full blocks show zero unlit device columns and
rows across a 190×84 device-pixel band, the box-drawing vertical rule has ink on both
sides of every interior cell boundary, and every cell of a 20-column text row still
carries ink. At ratio 1 the result is always an integer, so nothing downstream meets a
fraction on a non-retina display.

## Risks

- **A fractional CSS cell width (9.5) is new.** `width × ratio` is an integer by
  construction, so every atlas source rect and cell origin still lands on whole device
  pixels, and the glyph atlas already keys its cache on the cell width and reads the same
  ratio. Verified at ratio 2; a ratio the code has never seen (2.5, 3) is untested.
- **A cell can be up to half a device pixel narrower than the glyph advance.** This is
  Ghostty's documented trade-off, and the glyph classes its comment names — the ones meant
  to join their neighbours — are exactly the ones `terminal-glyph-cell-fit.ts` pins to the
  cell.
- **Monitor switch is unchanged, and still imperfect.** The vendor captures the ratio once
  and dev3's DPR-change path only records a breadcrumb, so after moving a window to a
  display of a different scale the canvas backing scale is stale until the pane is
  rebuilt — as it was before this change. The cell now shares that staleness instead of
  contradicting it. Fixing the lifecycle is deliberately out of scope.
- **Column counts are not promised to equal Ghostty's.** The rule matches; pane geometry,
  padding and scrollbar handling are ours and were not compared against a running Ghostty.

## Alternatives considered

- **`round` in CSS pixels.** Fixes the clamp violation and the engine split, keeps integer
  cells, and would have been the fallback if the fractional-width checks had failed — but
  stays 0.5 px per column wider than Ghostty on every retina display, leaving #1668's
  width complaint half answered.
- **Keep `ceil`.** Rejected once the clamp violation was measured: it is not a cosmetic
  0.5 px, it is a broken invariant in the engine the desktop app actually runs.
- **Rewrite the `scale` constants or the clamp.** Measured as unnecessary.
- **Patch `node_modules` or fork ghostty-web.** Same reasoning as the height record: the
  wrapper is ours, the vendor's formula is not.
