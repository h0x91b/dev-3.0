# Terminal path links stitch rows by geometry, not by the wrap flag

## Context

File-path links in the terminal reassemble soft-wrapped rows before running path detection (`src/mainview/terminal-file-links.ts`). A path that wrapped onto the next row was only ever detected up to the row's last column — which produced a link only when the truncated prefix happened to be an existing directory, and no link at all otherwise.

## Investigation

Replaying real tmux output into a headless `ghostty-web` terminal settled two things the code assumed wrongly:

- `IBufferLine.isWrapped` is documented as "this line wraps to the next line" but actually reports "this row is a continuation of the previous" (xterm semantics) — the existing reading was right.
- In a window with a **vertical split**, tmux redraws each pane row by row, so no wrap ever reaches the terminal: both rows of a wrapped path report `isWrapped: false`. A separate gap: ghostty-web's buffer hardcodes `isWrapped: false` for every scrollback row (`getScrollbackLine` path in its bundle).

## Decision

`getLogicalLines` (replacing `getLogicalLine`) splits each row into column **bands** at box-drawing verticals — the pane borders — and stitches per band. Inside a band the wrap flag still wins when present; when it is absent, rows join if the upper row fills the band to its last column and both sides of the seam read as path characters. `mapRangeToBuffer` now returns one range **per row**, because ghostty's `isPositionInLink` treats a multi-row range as covering whole rows and would otherwise hand the right pane's link to a click in the left pane.

## Risks

A line that exactly fills its band and is followed by path-looking text now stitches even when it was not a wrap; the merged token simply fails the on-disk existence check, so the cost is a missed link rather than a wrong one. Pane borders are only recognised in UTF-8 box-drawing form (tmux's default here), not the ASCII `|` fallback.

## Alternatives considered

Asking the backend for tmux pane geometry would be exact, but it plumbs tmux state into the renderer and still leaves the native backend and full-screen TUIs uncovered. Doing nothing about scrollback and fixing only splits would have left wrapped paths dead as soon as they scrolled off the active screen.
