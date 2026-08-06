# 102 — "Shutting down" is a transient, non-persisted task flag

## Context
Completing/cancelling a task runs a multi-second teardown in `moveTask`
(`task-lifecycle.ts`: `destroySession` → `runCleanupScript` → `removeWorktree`).
Until it finishes, the board card sat in its column, fully clickable, with no
indication — the agent-approved completion path (`App.tsx` `onAgentCompletionRequested`)
sets no local `moving` flag, so the existing `isCompleting` grayscale never fired.
We wanted a "shutting down" card state that also blocks opening.

## Decision
Added `Task.shuttingDown?: boolean` but kept it **transient**: `moveTask` decorates
`{ ...task, shuttingDown: true }` onto a `taskUpdated` push at the *start* of the
teardown branch, and the terminal `taskUpdated` (fresh task from `data.updateTask`,
no flag) replaces it wholesale in the reducer and clears it. The flag is **never**
passed to `data.updateTask`, so it never touches disk. `TaskCard` renders a muted,
indeterminate overlay (grey, no progress bar) and folds `isShuttingDown` into
`isDisabled` + the `handleClick` open-guard.

## Risks
An unrelated `taskUpdated` push for the same task mid-teardown (e.g. PR-status poll)
would clear the overlay early; acceptable — it self-heals and teardown is short.
A crash mid-teardown loses the flag, which is the *desired* outcome (no stuck card).

## Alternatives considered
- **Persist it like `preparing`** — rejected: violates the `~/.dev3.0/` no-stuck-state
  intent (a crash/reload would strand a card as "shutting down"), and `preparing`
  already needs `preparingStartedAt` + stuck-detection to compensate.
- **Reuse `isCompleting` only** — rejected: it is local React state, so it misses the
  agent-approved path and other clients (remote browser) watching the same board.
