# Board Active | All switch replaces status-token persistence

## Context
`decisions/2026/11/09/persist-board-status-filter.md` (never released) saved the `status:` tokens of the board query, but Esc or × in the search box cleared the query and saved an empty list, so filters looked like they kept resetting. The owner also did not want standing state living in a search box. `decisions/2026/10/28/board-filters-in-memory-per-board.md` had rejected persistence because a fresh launch silently hiding tasks is worse than re-typing a filter.

## Decision
The query is in memory only again; one per-board Active | All choice persists in `board-filters.json` / `space-board-filters/<id>.json` as `{ "visibility" }` through the same RPCs, and a legacy `{ "statuses" }` file reads as `all`. Active drops `completed` and `cancelled` tasks from `ctx.board.tasks()` unless the query has a `status:` token, while `scopeTasks()` stays whole (`useBoardFilter`, `BoardHost`). The switch is always visible in the filter row, so it never hides tasks silently, and the board renders only once the saved value is read, so an Active board never flashes finished tasks (`BoardVisibilitySwitch`, `useTaskVisibility`). It is called "visibility" because `BoardScope` is already public in `ctx.board`, which gains a read-only `visibility()` (`EXTENSION_API_VERSION` 1.1.0, additive). A notice under the filter row (`HiddenByVisibilityNotice`) counts hidden finished tasks when a search matches only them or the board holds only them, with a "Show all" link, except on Attention, whose buckets own status visibility; a `status:` token dims the switch.

## Risks
An Active board hides finished tasks on a fresh launch; the highlighted segment shows it. A read that gets no answer within 3 s settles as All and is retried on the next mount. Builds that persisted statuses read the new file as "no saved statuses", and their write replaces it.

## Alternatives considered
Keep status persistence and only stop Esc from saving `[]`: leaves status tokens in the search box. A funnel toggle instead of a visible switch: hides the one control users flip most.
