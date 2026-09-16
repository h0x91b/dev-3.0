# Attach glyph atlas strip canvases to the document

## Context

Issue #1786: terminal text in dev3 on macOS looks heavier than the same JetBrains
Mono 16 in native Ghostty, while character width, line pitch and cap height all
match exactly. The reporter measured ~48% more bright pixels per row of `M`.

The app applies `-webkit-font-smoothing: antialiased` globally
(`src/mainview/index.css`). The glyph atlas (`src/mainview/terminal-glyph-atlas.ts`,
introduced in #1420) rasterises each glyph once onto a strip canvas built with
`document.createElement("canvas")` and never attached to the document.

## Investigation

Measured in a real WKWebView (a Swift harness around `WKWebView`, the same engine
Electrobun renders in), with the app's global CSS rule on the page and
`JetBrainsMono Nerd Font` 16, counting total ink (sum of the red channel over an
opaque black background, so coverage is measured rather than area):

| canvas the glyphs were rasterised on | computed `-webkit-font-smoothing` | ink vs. the attached canvas |
|---|---|---|
| attached, visible | `antialiased` | baseline |
| detached | none — no computed style | **+30.6%** (regular, 1×) |
| detached + inline `style.webkitFontSmoothing` | none | +30.6%, byte-identical to plain detached |
| attached under `display: none` | `antialiased` | byte-identical to baseline |
| attached under `visibility: hidden`, off-screen, or a 0×0 clip | `antialiased` | byte-identical to baseline |

A detached element has no computed style at all, so WebKit falls back to the
platform default (subpixel) when rasterising canvas text. Attachment is what
fixes it; an inline style on a detached node does nothing, and no forced style
flush (`offsetWidth`, `getComputedStyle`) is needed before the first `fillText` —
measured identical with and without.

Driving the **real** atlas module end to end in the same harness, 40 cells of `M`
blitted onto a destination canvas versus the same row drawn with `fillText`:

| | before | after |
|---|---|---|
| 1×, regular | +29.95% ink | +0.08% |
| 1×, bold | +22.87% | −0.04% |
| 2×, regular | +13.19% | +0.02% |
| 2×, bold | +11.75% | −0.03% |

Steady-state frame cost on a 200×46 grid with 30 colours was unchanged
(~21 ms both ways; whichever version benchmarks first measures ~11 ms, so run
order dominates and the change does not).

## Decision

Strip canvases are appended to a single shared `<div>` carrying
`data-dev3-glyph-atlas`, `aria-hidden="true"` and `display: none`, created lazily
on the first page and removed once the last strip leaves
(`atlasHostElement` / `attachPage` / `detachPage` in `terminal-glyph-atlas.ts`).
Attachment happens before `getContext`, so the very first `fillText` is already
smoothed correctly; `reset()`, `uninstallGlyphAtlas()` and a failed
`getContext("2d")` all remove the node.

`display: none` over the other four working options: it resolves style — which is
all that is needed — while costing no layout box, no paint, no compositing layer
and no accessibility node. The alternatives put up to 512 wide canvases per
terminal into layout.

## Risks

- The strips are now real DOM nodes, so a leak would be visible in the node count
  rather than left to the collector. Covered by tests asserting the host is gone
  after reset, after dispose, after a context failure, and across eight terminals
  with several pages each.
- The evidence is WKWebView-only. happy-dom rasterises nothing, so the unit tests
  assert the attachment contract, not pixels; Chromium does not reproduce the
  original difference at all, so no browser-based test can guard this.
- This closes the gap between cached and direct rendering inside dev3. It does
  **not** establish pixel parity with native Ghostty, which was never measured.

## Alternatives considered

- **Inline `-webkit-font-smoothing` on the detached canvas** — measured
  byte-identical to doing nothing. WebKit needs the node in the document.
- **Drop the global `* { -webkit-font-smoothing: antialiased }` rule** — would
  change every surface in the app to fix one canvas, and would move the terminal
  the wrong way (towards the heavier rendering, not away from it).
- **A global font-weight compensation in the terminal** — treats the symptom,
  breaks as soon as the smoothing situation changes, and cannot be right for both
  regular and bold at both scales.
- **`visibility: hidden` / off-screen / 0×0 clip** — all measured to work, all
  pay for layout the hidden host does not.
