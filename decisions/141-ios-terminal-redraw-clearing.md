# iOS terminal redraw clearing

## Context

Pinch zoom changes SwiftTerm's cell geometry, but the iOS terminal could retain white or stale cell-sized patches instead of preserving the themed background. The corruption survived navigation and cold reattachment because each new view restored the persisted font through the same redraw path.

## Investigation

`Dev3SwiftTermView.setTerminalFontSize` assigns SwiftTerm's `font`, which calls `resetFont()` and schedules a full redraw. SwiftTerm 1.14.0 renders a non-opaque view over `layer.backgroundColor`; the retained layer raster can survive the geometry change even though the buffer and theme are still correct, and SwiftTerm's `draw(_:)` is not open for a downstream clear-before-draw override.

## Decision

Before assigning `font`, `Dev3SwiftTermView.setTerminalFontSize` clears `layer.contents`, then explicitly invalidates `bounds` after SwiftTerm recalculates the grid. A simulator rendering regression seeds a white stale raster, performs the font change, and verifies the layer redraws the dark background.

## Risks

Discarding the raster adds one full terminal repaint per pinch update, but font changes already recompute the complete grid and are much less frequent than PTY frames. Input, selection, accessibility, and the terminal buffer are unchanged.

## Alternatives considered

Overriding `draw(_:)` to clear the graphics context was rejected because SwiftTerm does not expose that method as `open`. Forking or patching SwiftTerm would fix the behavior closer to its source but adds dependency maintenance for a narrowly scoped workaround.
