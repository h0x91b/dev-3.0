# Link underlines read the screen once per repaint

## Context
ghostty-web 0.4.0's `buffer.active.getLine(y)` for a screen row calls `update()` + `getViewport()` — a copy and parse of all `cols × rows` cells — then slices one row. The underline overlay scanned every visible row twice (file paths, deep links), so a 221×70 repaint paid 141 full-screen copies; measured in Chrome at ~23 ms per frame while streaming (#1962).

## Decision
`createRowScan` (`src/mainview/terminal-file-links.ts`) takes ONE copy of the screen through the public `term.wasmTerm.getViewport()` on its first screen row and serves every screen row from it; scrollback rows keep the vendor path, which reads only that row. `sharedScanLinks` (`terminal-link-underlines.ts`) hands the same scan to both providers, so their row/logical-line cache is shared too. Hover (`provideLinks`) and touch (`linkAt`) build a scan per call. The bidi proxy holds the cursor row across frames while it is not dirty, dims are unchanged and no full or forced redraw happened.

## Risks
The reader re-derives the vendor's screen/scrollback split (`buffer.length - rows`); a ghostty-web bump that changes `getLine`'s semantics must keep `terminal-link-viewport-reads.test.ts`, which compares against the vendor's own per-row reads on the real WASM terminal, green. The bidi hold trusts render-state dirty flags, the same ones the renderer trusts for repainting.

## Alternatives considered
Only sharing the row cache between providers: halves the copies, still one per row. Keeping a cache across repaints: content changes every streaming frame, and once scrollback hits its cap every line shifts absolute indices, so invalidation is fragile for no gain. Throttling repaints to ~100 ms with a trailing redraw: would save ~4% of a core after this fix, but leaves underlines behind text that scrolls under them for up to 100 ms.
