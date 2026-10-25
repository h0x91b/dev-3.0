# Removing imported tasks deletes only what is still just an import

## Context

The conversation import (`decisions/2026/08/28/import-conversations-worktree-without-agent.md`)
had no undo. Importing a busy project can create well over a hundred tasks — one real
board had 154, 55 of them with a worktree — and the only way back was deleting them one
card at a time. Project Settings → Agent conversations gets a bulk "Remove N imported
tasks…" action.

## Investigation

- `importedSessionId` is the only mark an import leaves, and it is never rewritten, so it
  stays on a task the user later launched and worked on.
- A single delete goes through the lifecycle's `deleteRequested`, which removes the
  worktree and, under the default branch policy, `git branch -D`s a `dev3/` branch. Run
  over every task with `importedSessionId`, that would destroy unpushed work in any
  imported task the user had picked up.
- The import never launches an agent, so `agentId` stays `null` until someone does.
- `git.assertWorkspaceReclaimable` already answers "does this folder hold work?" — no
  dirty or untracked file and no commit its HEAD alone reaches — for the stale-folder
  reclaim and the preparation-failure cleanup.

## Decision

`removeImportedTasks({ projectId, taskIds })` in
`src/bun/rpc-handlers/conversation-import-handlers.ts`:

- deletes only the ids the renderer counted in its confirmation, and of those only tasks
  that still carry `importedSessionId`, so a task added while the dialog was open is not
  swept up;
- keeps, and reports in `kept[]`, any task with an `agentId` or whose worktree fails
  `assertWorkspaceReclaimable`; the rest go through the ordinary `deleteTask`;
- runs the deletes one at a time (they share the repository's git locks) and refuses a
  second call for the same project while one is in flight;
- counts a task deleted elsewhere mid-loop as removed rather than as a failure.

The renderer shows one summary toast each for kept and failed tasks rather than one per
task. The conversations stay in the agents' own history, so a later import offers them
again — removing is not a "never offer this" switch.

## Risks

- A task the user only typed into through a plain shell, without launching an agent and
  without leaving a dirty file or a unique commit, is removed. Nothing of theirs is lost
  in that case, which is the property the guard protects.
- The request is synchronous. A very large removal where every worktree runs a slow
  cleanup script could outlast the renderer's RPC timeout; the backend carries on and
  the per-task `taskRemoved` pushes keep every window correct, but the toast would show
  a timeout.

## Alternatives

- **Delete every task with `importedSessionId`.** Simplest, and destroys picked-up work.
- **Delete with `branchPolicy: "unique-kept"`.** Would need a new lifecycle event option
  and still removes the worktree's uncommitted files; checking up front keeps the whole
  task instead.
- **Remember removed sessions so they are never offered again.** New persisted state in
  `~/.dev3.0` for a case the one-time auto-offer already covers.
