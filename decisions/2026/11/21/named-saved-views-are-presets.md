# Named saved views are presets beside the working view

## Context

`board-views.json` was designed as a list of saved views (spec D21, `pluggable-board-views-on-cordis`), with one implicit entry per board until named saved views ship. Named views needed an edit model: does a change made while a named view is shown save into it, and does the board reopen on it with its query after a restart?

## Decision

- A named view is a `SavedBoardView` with a non-null `name`. Slots never point at one: `normalizeBoardViewState` keeps both slots on unnamed working views and re-adds a working view if a hand edit left none (`src/shared/board-view-state.ts`).
- Applying copies the named view's view type and layouts into the form factor's working view (`withNamedViewApplied`) and the host sets the board query from it. Later edits change only the working view and the in-memory query; the switcher shows the name with a dot while `namedViewModified` is true, and offers Update and Revert.
- Which named view is applied is session memory per board and form factor (`appliedNamed` in `useBoardViewState.ts`), like the query. A fresh launch opens the working view with an empty query, as `board-host-cordis-provision` requires.
- Picking a view type in the switcher leaves the applied named view. Names are unique per board, case-insensitive, capped at 60 characters. Delete goes through `confirm()`.
- Named edits are their own RPC, `changeNamedBoardView`, applied to the file under its lock (`src/bun/board-view-state-data.ts`). A plain `setBoardViewState` keeps the named views already on disk (`withNamedViewsFrom`), so a window or a timed-out read holding an older copy cannot add or drop one. Ids are random (`newNamedViewId`), never reused.
- A named view whose view type the board does not offer (narrow, disabled or uninstalled extension) is a disabled row that explains itself with a toast.

## Risks

An older app version on the same machine writes the whole file. If it read the file before a named view was saved, its next write drops that view; reading after keeps it. The query is shared by both form factors, so a view applied in one can read as edited in the other. With one offered view and no saved views the switcher stays hidden, so Save is not offered there. A hand-edited file that lists a named view first can, after an older build edits it, gain a same-named copy; this build never writes that order.

## Alternatives considered

Live named views that auto-save every change, as the working view does: rejected because a throwaway search would silently rewrite a saved view. Pointing a slot at the named view and persisting its query: rejected because a restart would open a filtered board. One global list across boards: rejected because queries name per-board labels, projects and epics.
