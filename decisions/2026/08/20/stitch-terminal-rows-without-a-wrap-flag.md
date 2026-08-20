# Terminal path links stitch rows by geometry, not by the wrap flag

## Context

File-path links in the terminal reassemble soft-wrapped rows before running path detection (`src/mainview/terminal-file-links.ts`). A path that wrapped onto the next row was only ever detected up to the row's last column — which produced a link only when the truncated prefix happened to be an existing directory, and no link at all otherwise.

## Investigation

Replaying real tmux output into a headless `ghostty-web` terminal settled two things the code assumed wrongly:

- `IBufferLine.isWrapped` is documented as "this line wraps to the next line" but actually reports "this row is a continuation of the previous" (xterm semantics) — the existing reading was right.
- In a window with a **vertical split**, tmux redraws each pane row by row, so no wrap ever reaches the terminal: both rows of a wrapped path report `isWrapped: false`. A separate gap: ghostty-web's buffer hardcodes `isWrapped: false` for every scrollback row (`getScrollbackLine` path in its bundle).
- The case the bug report actually showed is a third one: **an agent CLI reflows its own output**. Claude Code emits a real newline plus a 6-space indent and breaks a column short of the true edge, so there is no wrap to detect and the continuation row does not even start at the band's first column. Replaying that output into a headless ghostty buffer reproduces it exactly.

## Decision

`getLogicalLines` (replacing `getLogicalLine`) splits each row into column **bands** at box-drawing verticals — the pane borders — and stitches per band. Inside a band the wrap flag still wins when present; when it is absent, `seamBetween` joins two rows if the upper one runs out within `MAX_WRAP_SLACK` (4) columns of the band's right edge, the lower one starts within `MAX_CONTINUATION_INDENT` (12) columns of its left edge, both sides of the seam read as path characters, and at least one of those seam tokens carries a `/`, `\` or `.` — prose wraps too, and that separator is what tells a path fragment from a sentence. The seam columns are also what the rows are sliced at, so the upper row's padding and the lower row's indent never land inside the reassembled path.

Because a geometric seam is a guess, `computeLinks` scans every row of a guessed logical line on its own as well and keeps those candidates wherever the stitched read produced no link over the same cells. A wrong merge therefore costs nothing: the merged token fails the on-disk check and each row's real link still surfaces. `mapRangeToBuffer` returns one range **per row**, because ghostty's `isPositionInLink` treats a multi-row range as covering whole rows and would otherwise hand the right pane's link to a click in the left pane.

## Cost per repaint

The overlay recomputes every viewport row on each frame, so the added work was measured against the shipped version (A/B in one process, min of 300 repaints, 160×48). A typical agent viewport: **0.21 ms → 0.26 ms**. A screen that is nothing but full-width paths with no wrap flags — every row stitches into one logical line: **0.21 ms → 0.87 ms**. Buffer reads are unchanged at one per cell.

Two memoisations keep that worst case from being quadratic: `RowCache.lines` stores a finished logical line under every row it covers, and `linksForRows` carries a `done` set so a viewport-sized line is scanned once instead of once per row. Without them the same screen cost 4.0 ms. Skipping the per-row rescan on rows that already carry a link would drop it to 0.67 ms, but it lost 36 of 94 links on that screen — not worth it.

## Risks

Guessed seams fire more often than real wraps do, so a stitched line costs one extra `resolveTerminalPaths` entry per row fragment (batched, cached, gated to the allowed roots). Rows joined by the terminal's own wrap flag skip the per-row rescan entirely, so the common case pays nothing. Pane borders are only recognised in UTF-8 box-drawing form (tmux's default here), not the ASCII `|` fallback.

## Alternatives considered

Asking the backend for tmux pane geometry would be exact, but it plumbs tmux state into the renderer and still leaves the native backend and full-screen TUIs uncovered. Doing nothing about scrollback and fixing only splits would have left wrapped paths dead as soon as they scrolled off the active screen.
