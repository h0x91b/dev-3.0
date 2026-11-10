# Board status tokens persist across restarts

## Context
`decisions/2026/10/28/board-filters-in-memory-per-board.md` kept the whole board filter in memory so a stray search word could never hide tasks after a restart. The maintainer then approved a separate JSON state for the part users actually want back: the set of statuses (for example everything except completed), which is a deliberate standing view.

## Decision
Only the `status:` tokens of the board query persist. `usePersistedStatusFilter` (`src/mainview/board-views/`), called from `useBoardFilter`, reads them once on first open of a board and writes only when the user changes the status list (a failed or dropped read, or a jump preset, never overwrites the file); free text, priority, label and other tokens stay in the in-memory `Map` of `useRememberedFilter`. An in-memory filter (earlier visit, or a `rememberFilter()` preset) wins over the file, and any user edit wins over a pending read, even one that clears the query back to where it started (the read is dropped and the typed statuses are saved against an empty baseline). Per-board state lives at module level so it survives remounts: a board left before its read landed and not edited is read again, an edited one is saved anyway. Writes go through one serialized request per board, newest list wins, and an unmounted board still finishes its last write, because the host file lock is not FIFO. Storage is a new file per board, written like `board-views.json`: `data/<projectSlug>/board-filters.json` and `space-board-filters/<id>.json` (`src/bun/board-filter-state-data.ts`, RPC `getBoardFilterState` / `setBoardFilterState`). The Active Tasks sidebar is unchanged.

## Risks
A saved status set can hide cards on a fresh launch; the funnel badge shows it and the search box × clears it. A failed read or write only logs a warning.

## Alternatives considered
localStorage: renderer-only, not a per-board file, lost in browser/remote mode. Adding the list to `board-views.json`: the author asked for a separate file, and it keeps view layout apart from the filter. Persisting the whole query: brings back the stray-text risk.
