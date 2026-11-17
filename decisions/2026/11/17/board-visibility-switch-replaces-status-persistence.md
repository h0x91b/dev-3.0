# Board Active | All switch replaces status-token persistence

## Context
`decisions/2026/11/09/persist-board-status-filter.md` saved the `status:` tokens of the board search query. It lived only in unreleased builds. Esc or × in the search box cleared the whole query and saved an empty list, so the filter looked like it kept resetting, and the owner found status tokens in a search box the wrong place for a standing view. `decisions/2026/10/28/board-filters-in-memory-per-board.md` had rejected persistence because a fresh launch silently hiding tasks is worse than re-typing a filter.

## Decision
The search query is in memory only again (`useRememberedFilter`). What persists is one per-board choice, Active | All (`BoardVisibilitySwitch`, `useTaskVisibility`, `useBoardFilter`). Active hides `completed` and `cancelled` tasks from `ctx.board.tasks()`; `scopeTasks()` stays whole, so parent lookup and "nothing here" messages are unaffected. An explicit `status:` token wins, so the funnel's "Completed" still shows them. Unlike a stray search word, the switch is always visible in the filter row, so a hidden-by-default board is never silent. The board renders only after the saved value has been read, so an Active board never flashes finished tasks. Storage reuses `board-filters.json` / `space-board-filters/<id>.json` and the same RPC names; the file holds `{ "visibility": "active" | "all" }` and a legacy `{ "statuses": [...] }` file reads as `all`. The name avoids the public `BoardScope` of `ctx.board`.

## Risks
An Active board hides finished tasks on a fresh launch; the highlighted segment shows it. Builds that persisted statuses read the new file as "no saved statuses", and their write replaces it.

## Alternatives considered
Keep status persistence and only stop Esc from saving `[]`: leaves status tokens in the search box. A funnel toggle instead of a visible switch: hides the one control users flip most.
