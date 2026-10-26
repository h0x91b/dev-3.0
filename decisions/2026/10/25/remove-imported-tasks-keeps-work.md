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
- The import never launches an agent, but `agentId` is not a reliable sign that someone
  did: opening an imported task runs `getPtyUrl` → `launchTaskPty` with `agentId === null`,
  which starts the project's default agent and persists only `sessionState`. The main
  pane in `sessionState.panes` is written on that path for every backend; the panes can
  later be pruned when the agent exits, so a live session is checked as well.
- `git.assertWorkspaceReclaimable` answers "does this folder hold work?" for the
  stale-folder reclaim and the preparation-failure cleanup, but its unique-commit count
  treats the worktree's own branch as "found elsewhere". With HEAD on `dev3/task-*` an
  unpushed commit counts as 0, and the delete then removes the branch ref (found in the
  PR #2059 review and reproduced against real git).

## Decision

`removeImportedTasks({ projectId, taskIds })` in
`src/bun/rpc-handlers/conversation-import-handlers.ts`:

- deletes only the ids the renderer counted in its confirmation, and of those only tasks
  that still carry `importedSessionId`, so a task added while the dialog was open is not
  swept up;
- re-reads each task right before its check, and keeps, reporting in `kept[]`, any task
  that has been started (`importedTaskStarted`: an `agentId` or recorded panes, in
  `src/shared/conversation-import-model.ts`, or a live `pty` session) or that fails
  `git.assertTaskWorkDisposable` — the folder check plus a unique-commit count per branch
  (`task.branchName` and the worktree's current branch) that excludes that branch itself,
  the way `ownedBranchInfo` does for branch deletion; the rest go through the ordinary
  `deleteTask`;
- runs the deletes one at a time (they share the repository's git locks) and refuses a
  second call for the same project while one is in flight;
- counts a task deleted elsewhere mid-loop as removed rather than as a failure.

The renderer counts and sends only imported tasks that have not been started, using the
same `importedTaskStarted`, so the confirmation does not promise deletes that the backend
will refuse. It shows one summary toast each for kept and failed tasks rather than one per
task. The conversations stay in the agents' own history, so a later import offers them
again — removing is not a "never offer this" switch.

## Risks

- A task whose agent ran and exited, leaving no recorded pane, no dirty file and no unique
  commit, is removed. Its conversation stays in the agent's own history, so nothing in
  git is lost, which is the property the guard protects.
- A launch that lands between a task's check and its delete is not caught. The window is
  one `deleteTask` dispatch; closing it fully would need the delete itself to refuse a
  started task.
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
