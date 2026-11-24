# Named saved views are presets beside the working view

## Context

`board-views.json` was designed as a list of saved views (spec D21, `pluggable-board-views-on-cordis`), with one implicit entry per board until named saved views ship. Named views needed an edit model: does a change made while a named view is shown save into it, and does the board reopen on it with its query after a restart?

## Decision

- A named view is a `SavedBoardView` with a non-null `name`. Slots never point at one: `normalizeBoardViewState` keeps both slots on unnamed working views and re-adds a working view if a hand edit left none (`src/shared/board-view-state.ts`).
- Named views live in their own file, `board-saved-views.json` beside `board-views.json` (`~/.dev3.0/space-board-saved-views/<spaceId>.json` for a space), as `{ version: 1, views: [...] }`. `board-views.json` keeps only working views and slots, in the shape v1.64.0 to v1.65.1 already read and write. Those builds rewrite that whole file from a copy read once per session, so a named view stored there would be dropped by their next view or layout change. They never open the new file (AGENTS.md on-disk rule 5). The host reads both and merges them (`withNamedViews`); a named entry found in `board-views.json` is ignored.
- Applying copies the named view's view type and layouts into the form factor's working view (`withNamedViewApplied`) and the host sets the board query from it. Later edits change only the working view and the in-memory query; the switcher shows the name with a dot while `namedViewModified` is true, and offers Update and Revert.
- Which named view is applied is session memory per board and form factor (`appliedNamed` in `useBoardViewState.ts`), like the query. A fresh launch opens the working view with an empty query, as `board-host-cordis-provision` requires.
- Picking a view type in the switcher leaves the applied named view. Names are unique per board, case-insensitive, capped at 60 characters. Delete goes through `confirm()`.
- The host enforces unique names too (`namedViewChangeTakesName`): a window's list can be older than the file, so its name dialog can pass a name another window just saved. `changeNamedBoardView` then answers `rejected: "name-taken"`, the window shows its own toast and re-reads. Opening the switcher re-reads the named views in the background, which narrows that window and shows views other windows saved; it leaves the working view alone, so another window's view change never moves this board.
- Named edits are their own RPC, `changeNamedBoardView`, applied to the presets file under its lock (`src/bun/board-view-state-data.ts`). A plain `setBoardViewState` writes only `board-views.json`, so a window or a timed-out read holding an older copy cannot add or drop a named view. Ids are random (`newNamedViewId`), never reused. A named view whose id a working view also uses (a hand edit) is hidden but kept in its file, and deleting it never touches the working view.
- A named view whose view type the board does not offer (narrow, disabled or uninstalled extension) is a disabled row that explains itself with a toast.

## Risks

An older app version never sees named views, so it cannot show, edit or drop them. The query is shared by both form factors, so a view applied in one can read as edited in the other. With one offered view and no saved views the switcher stays hidden, so Save is not offered there. Two files mean two locks: a named change and a plain save never need to be atomic together, because neither writes the other's file.

## Alternatives considered

Live named views that auto-save every change, as the working view does: rejected because a throwaway search would silently rewrite a saved view. Pointing a slot at the named view and persisting its query: rejected because a restart would open a filtered board. Named views as extra entries in `board-views.json`, which older builds ignore: rejected because those builds also rewrite that file and drop the entries. One global list across boards: rejected because queries name per-board labels, projects and epics.
