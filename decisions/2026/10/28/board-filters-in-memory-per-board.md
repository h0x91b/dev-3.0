# Board and Active Tasks filters live in memory, per board

## Context
Both surfaces kept their whole filter (free text plus every facet token) in one `useState` string, so unmounting the view — opening a task, the dashboard, settings, another project — threw it away. Users asked for filters to be remembered.

## Decision
`useRememberedFilter(key)` (`src/mainview/hooks/useRememberedFilter.ts`) backs the query with a module-level `Map`. The board keys it like its column-collapse memory (`board:<projectId>` or `board:space-<spaceId>`), so A → B → A restores A and B starts on its own. The Active Tasks sidebar uses one `active-tasks` key, matching its already-global scope setting, so the filter follows the user across tasks and projects. Clearing the query deletes the entry.

## Risks
A filter set long ago can still be hiding cards when the user comes back within the same run; the search box shows it and its × clears it, which is the existing reset control.

## Alternatives considered
localStorage (survives restart, like theme/locale/scope): rejected by the maintainer — a fresh launch opening on a board that silently hides tasks is worse than re-typing a filter. sessionStorage: same lifetime in the desktop shell but adds storage I/O and try/catch for no gain. Reducer state in `state.ts`: works, but widens the global store for state only two components read.
