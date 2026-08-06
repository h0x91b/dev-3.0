# 069 — Revert task to todo when background worktree prep fails

## Context

Issue #629: when background worktree/PTY preparation fails (empty repo, missing
base branch), the variant/attempt flow persisted the task as `in-progress` up
front, then `prepareTaskInBackground` only cleared the preparing spinner on
failure. The task stayed `in-progress` with no worktree and no PTY, so the
terminal showed a misleading dim "[session ended]" and the state survived app
restarts. No error reached the user.

## Decision

In `prepareTaskInBackground`'s catch block (`src/bun/rpc-handlers/task-lifecycle.ts`)
a genuine (non-cancellation) failure now calls `revertPreparingTaskToTodo` —
the same cleanup the cancellation path uses — moving the task back to `todo`,
removing any half-created worktree, and releasing ports. It then pushes a new
`taskPreparationFailed` message (schema in `src/shared/types.ts`), which the
renderer (`App.tsx`) surfaces as a `toast.error`, mirroring `columnAgentFailed`.

Separately, `git.createWorktree` now distinguishes an empty repository
(no commits) from a missing base branch and gives a "no commits yet" message.

## Risks

Reverting to `todo` is per-task, so a failed variant in a group lands in `todo`
while siblings may succeed — acceptable and recoverable. The drag-drop launch
path (`moveTask`) was already safe (renderer reverts optimistic update on throw);
this change targets only the fire-and-forget background prep path.

## Alternatives considered

- Keep the task `in-progress` and add a persisted `preparationError` field shown
  in the card/terminal — more invasive (new state, UI), and still leaves the task
  in a column where it can't run. Rejected.
- Only push a toast without reverting — leaves the strand (still `in-progress`,
  still "[session ended]"). Rejected.
