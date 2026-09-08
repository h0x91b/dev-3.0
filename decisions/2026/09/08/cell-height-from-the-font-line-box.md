# Terminal cell height comes from the font's line box, not from the ink of an "M"

> Partly superseded on 2026-09-08 by `decisions/2026/09/08/cell-width-on-the-device-pixel-grid.md`:
> the width axis is no longer left on the vendor's `ceil`, and this record's reason for leaving it
> there — that device rounding would break the reference clamp — turned out to be backwards.
> Measurement showed the `ceil` is what breaks the clamp, in 8 of 400 font/size pairs in WKWebView.
> The height decision below stands unchanged.

## Context

Issue #1668: at terminal font size 16 with JetBrains Mono, dev3 set lines 17 CSS px
apart while Ghostty, Terminal.app, iTerm2 and VS Code all set them 21 px apart.
Descenders of one row touched the next. The reporter also measured a 10 px cell
width against Ghostty's 9.5 px.

## Investigation

`measureFont()` in `ghostty-web@0.4.0` (`dist/ghostty-web.js:1366`) is

```js
const m = ctx.measureText("M");
const asc  = m.actualBoundingBoxAscent  || fontSize * 0.8;
const desc = m.actualBoundingBoxDescent || fontSize * 0.2;
return { width: Math.ceil(m.width), height: Math.ceil(asc + desc) + 2, baseline: Math.ceil(asc) + 1 };
```

Measured over all 16 bundled fonts x 12 sizes (8-32), in headless Chromium **and** in
WKWebView — the engine the desktop app actually renders in:

- `actualBoundingBoxDescent` of "M" is **0 in 15 of the 16 fonts**, so the `||` fallback
  fires on nearly every path and replaces a legitimate zero with `fontSize * 0.2`.
- The result therefore never contains the font's own line metrics. At size 16 it is
  17 px for JetBrains Mono (designed 21), 19-ish for Hack (designed 19), and 17 for
  0xProto (designed 25) — every font within a pixel or two of the same cell.
- `fontBoundingBoxAscent + fontBoundingBoxDescent` **is** the designed line box.
  Chromium and WKWebView returned byte-identical integers in all 192 font/size pairs,
  and those integers are the font's `hhea` ascender/descender scaled per side —
  cross-checked against the woff2 tables with fontTools (JetBrains Mono: 1020/-300
  over 1000 upm = 1.32 em = 21 px at 16).

Live proof in the running app (QA board, JetBrains Mono 16, 1440x786 pane): the canvas
went from 1440x782 (46 rows x 17) to 1440x777 (37 rows x 21), columns unchanged at 144.

## Decision

`src/mainview/terminal-cell-metrics.ts` wraps the renderer's `measureFont` — the same
instance-wrapping pattern as `terminal-glyph-cell-fit.ts` and the cursor gate — and
replaces `height` and `baseline` with `ceil(fontBoundingBoxAscent)` plus
`ceil(fontBoundingBoxDescent)`. Each side is ceiled on its own so neither is cropped by this code — though both engines were
later measured returning integers already, in all 400 font/size pairs including fractional sizes,
so in practice the ceil never binds and the quantization is the engine's own.
A measurement the engine cannot answer falls back to the vendor's own cell verbatim.
`TerminalView.tsx` installs it before the glyph cell fit and disposes it after.

**The cell width is deliberately left on the vendor's `Math.ceil` in CSS pixels.**
Rounding it in device pixels would reproduce Ghostty's 9.5 px, but it lands the cell
*narrower than the glyph advance* in 67 of the 192 measured pairs (up to a full CSS
pixel), and the reference-font clamp in `terminal-font.ts` is built on that ceil —
see `decisions/2026/08/25/terminal-font-width-is-clamped-to-the-reference.md`. The
remaining 0.5 px per column is reported in the issue rather than fixed here.

## Risks

- **Fewer visible rows in the same pane.** At size 16 a 786 px pane goes from 46 rows
  to 37. That is the point — it matches every other terminal — but it is a visible
  change for every user.
- **0xProto declares 1.56 em**, so its cell grows from 17 px to 25 px at size 16. That
  is the font's own design and Ghostty renders it the same way, but it is the largest
  jump of the bundled set.
- The wrapper reaches a `private` vendor method by cast. A vendor rename breaks it
  silently — the unit suite asserts the resulting cell, which is what would catch it.

## Alternatives considered

- **Patch `node_modules`.** Not a deliverable; the next install erases it.
- **Fork ghostty-web.** Disproportionate for one formula, and the wrapper pattern for
  this renderer already exists in five places.
- **Upstream first.** Still worth doing (`||` should be `??`, and the height should come
  from the line box), but it cannot ship dev3's fix on any timeline we control.
- **`actualBoundingBoxDescent` with `??` instead of `||`.** Fixes the swallowed zero but
  keeps the cell tied to the ink of one capital letter, which is not a line metric: for
  JetBrains Mono at 16 it yields `ceil(11.68 + 0) + 2` = 14 px, worse than today.
