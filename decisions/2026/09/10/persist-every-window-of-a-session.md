# Persist every window of a session, not just the focused one

## Context

`~/.dev3.0/window-state.json` held a single window: `captureWindowState()` wrote the
focused window's geometry and `createAppWindow` restored it only for the first window
of a launch (`windows.size === 0`). A user with several `Window > New` windows got one
window back after an update restart or a quit, the rest lost.

## Investigation

Three facts shaped the design. Electrobun exposes no window identity that survives a
restart, so a restored window is geometry only — no route, no per-window context.
macOS owns a fullscreen window's frame, so the *windowed* frame must be tracked
separately per window (it already was, but in one module-level variable shared by all
windows). And `~/.dev3.0` is read by every installed version of the app, so the file
format could not simply change shape.

## Decision

`window-state.ts` now stores `{ ...firstWindow, windows: WindowState[] }` — the array is
the session, and the first window's fields are duplicated at the top level so an older
install still restores its main window from the same file (`loadWindowStates` reads
either shape). `window-manager.ts` keeps `lastWindowedFrame` per registry entry and
snapshots every open window (`captureAllWindowStates`); `index.ts` reopens one window
per saved entry at launch, focusing the first.

Close and quit are told apart by `isQuitConfirmed()`: closing a window while the app
runs re-snapshots the remaining set (so it does not come back), while a quit tears every
window down at once and must not shrink the session written by `flushWindowState()`.
An empty snapshot is never written — quitting from a window-less dock keeps the last
known geometry, matching the previous behaviour.

## Risks

macOS cannot restore a fullscreen window's Space, so several restored fullscreen windows
land in newly created Spaces in creation order, not the user's original arrangement.
Window *identity* is not restored: which task or route a window showed is not persisted,
so all restored windows open on the app's normal landing route.

## Alternatives considered

A per-window state file keyed by a generated id — rejected: the ids are meaningless
across restarts and it multiplies files under `~/.dev3.0`. Writing only the array and
dropping the legacy top-level fields — rejected: an older install would read the file as
invalid and lose main-window restore, which the on-disk layout rules forbid.
