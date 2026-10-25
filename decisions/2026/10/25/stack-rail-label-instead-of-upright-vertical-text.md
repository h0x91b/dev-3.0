# Stack the task rail label per grapheme instead of upright vertical text

## Context

The task card rail (`TaskCardRail.tsx`) printed its status word with `writing-mode: vertical-rl; text-orientation: upright`. On Linux the letters overlapped (issue #2040). The reporter suspected fonts; they load fine.

## Investigation

Measured in a real WebKitGTK 2.50.4 (Ubuntu 25.04, the reporter's version) against Chromium with the same CSS and the bundled JetBrains Mono: WebKitGTK steps each upright glyph by its horizontal advance (7 letters of WORKING = 51.8px, 7.4px per letter), Chromium and WKWebView by the vertical em box (100.8px, 14.4px per letter). The glyphs are upright but ~13px tall on a 7.4px step, so they overlap. DejaVu Sans Mono, weight 400 and `letter-spacing: 0` overlap the same way; `text-orientation: mixed` lays out correctly but rotated.

## Decision

`RailWord` renders one span per grapheme (`splitGraphemes`, `Intl.Segmenter` with a code-point fallback) in a flex column, each cell `1.44em` tall — exactly the step the other engines gave an upright letter, so heights, `RAIL_LABEL_MAX` and the `autoLabel` fit maths are unchanged. Spaces keep a cell; combining marks and ZWJ emoji stay in one cell. The same path runs on every platform. `shortenForRail` now counts and cuts by grapheme too.

## Risks

Within a pixel of the old layout on Chromium (subpixel rounding of the summed cells). A grapheme wider than the 20px rail (none in shipped locales) would overflow sideways exactly as before.

## Alternatives considered

- A Linux-only CSS override behind a platform class: two layouts to keep in sync, and the bug follows the engine, not the OS — a WebKitGTK browser (Epiphany) opening remote mode would miss a desktop-shell platform class.
- The reporter's `horizontal-tb` + `width: 1ch` + `word-break: break-all`: collapses spaces in multi-word custom column names and lets a wide grapheme wrap oddly.
- `text-orientation: mixed`: correct glyph spacing, but the word reads rotated, which the rail was designed to avoid.
