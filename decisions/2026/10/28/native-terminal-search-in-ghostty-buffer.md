# Native-terminal ⌘F searches ghostty's buffer in the renderer

## Context

⌘F used to drive tmux copy-mode (`decisions/2026/07/20/terminal-cmdf-tmux-copy-mode-search.md`). A native-backend task has no tmux session, so the bar showed "0" for every query. The native backend now keeps a long scrollback inside ghostty itself, so the renderer can search it.

## Investigation

- `Terminal.select(col, row, len)` takes a **viewport** row and stores `viewportY + row` as the absolute row. ghostty's own conversion is `scrollback + row - viewportY`, so the two disagree unless the viewport sits in one particular place.
- `scrollToLine(n)` sets `viewportY = n` directly, i.e. it counts **from the bottom** (0 = live output), despite the docstring saying 0 is the top of scrollback. It clamps to `[0, scrollback]`.
- `scrollback` is a **byte cap**, not a row count: `1e4` is about 600 rows; `5e7` (`NATIVE_SCROLLBACK_BYTES`) is about 33k rows at 120 columns, measured on the wasm.
- ghostty-web has no buffer-changed or write-parsed event (`onRender` also fires on our own scrolls and selects).
- `translateToString` drops empty and spacer cells, so its string index is not a cell column; `getCell(x).getChars()` returns only the base code point.

## Decision

`TerminalSearchBar` takes an optional `term`. When set it makes no `tmuxSearch*` call and searches locally; without it the tmux path is unchanged. `TerminalView` passes `term` only when its `native` prop is set (from `task.terminalBackend`) and never falls back to tmux for a native task.

- `src/mainview/terminal-search.ts`: `buildSearchLine` flattens a line per cell (spacer cells skipped, empty cells as spaces, string index to cell column map, per-code-point case fold that keeps UTF-16 length); `findMatches` returns `{row, col, length}` in cells.
- `TerminalSearchBar.revealNativeMatch`: `scrollToLine(anchor)`, `select(col, row - anchor, length)`, then `scrollToLine` to centre the match. The first scroll makes `select`'s `viewportY + row` equal the true absolute row.
- Cursor starts at the newest match; Enter goes older, Shift+Enter newer, both wrap. Every step re-reads the buffer because there is no change event. Enter inside the debounce window commits the typed query first.
- `TerminalView.searchOwnsSelectionRef` (set through `onHighlightChange`) skips `clearStaleSelectionOnWrite` while the highlight is the selection, because an agent on a mouse-tracking primary screen otherwise wipes it on its next write. The bar follows a recreated terminal via `setSearchTerm`.

## Risks

- A full re-read per step is about 0.2 s at maximum scrollback.
- Only the current match is highlighted; ghostty-web has no decoration API.
- Decomposed accents (combining marks) are not searchable, since `getChars()` returns the base code point only.
- Wrapped scrollback rows are not rejoined, so a match split by a soft wrap is missed.
- A filled native pane holds up to about 66 MB of scrollback.
- ghostty scrolls to the bottom on any write while `viewportY > 0`; a native pane puts the view back after each write (`decisions/2026/10/29/hold-native-terminal-viewport-on-write.md`).
- `select()`'s quirk is worked around, not fixed; a ghostty-web fix of its row base would make the first scroll harmless but redundant.

## Alternatives considered

- Search in the bun process over the PTY byte log: a second terminal state to keep consistent with what ghostty renders.
- A search addon: ghostty-web ships none.
- Select via the internal SelectionManager: reaches private fields of a vendored library.
