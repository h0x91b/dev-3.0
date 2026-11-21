# Named saved views are presets beside the working view

## Context

`board-views.json` was designed as a list of saved views (spec D21, `pluggable-board-views-on-cordis`), with one implicit entry per board until named saved views ship. Named views needed an edit model: does a change made while a named view is shown save into it, and does the board reopen on it with its query after a restart?

## Decision

- A named view is a `SavedBoardView` with a non-null `name`. Slots never point at one: `normalizeBoardViewState` keeps both slots on unnamed working views and re-adds a working view if a hand edit left none (`src/shared/board-view-state.ts`).
- Applying copies the named view's view type and layouts into the form factor's working view (`withNamedViewApplied`) and the host sets the board query from it. Later edits change only the working view and the in-memory query; the switcher shows the name with a dot while `namedViewModified` is true, and offers Update and Revert.
- Which named view is applied is session memory per board and form factor (`appliedNamed` in `useBoardViewState.ts`), like the query. A fresh launch opens the working view with an empty query, as `board-host-cordis-provision` requires.
- Picking a view type in the switcher leaves the applied named view. Names are unique per board, case-insensitive, capped at 60 characters. Delete goes through `confirm()`.

## Risks

An older app version reads the named entries as extra saved views it never shows and keeps them on write, so no data is lost, but it ignores them. A view whose layout is rewritten on mount without a user change would show as edited right after applying; no built-in view does this today.

## Alternatives considered

Live named views that auto-save every change, as the working view does: rejected because a throwaway search would silently rewrite a saved view. Pointing a slot at the named view and persisting its query: rejected because a restart would open a filtered board. One global list across boards: rejected because queries name per-board labels, projects and epics.
