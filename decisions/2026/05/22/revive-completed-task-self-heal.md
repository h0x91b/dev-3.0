# 053 — Self-heal worktree leftovers when reviving a completed/cancelled task

## Context

After PR #571 ("Unblock task lifecycle: replace sync spawns in destroy + cache user shell"),
dragging a card from `completed`/`cancelled` back to an active status (in-progress, etc.)
would flash on the new column for ~2 seconds and snap back. The renderer was reverting
its optimistic update because `moveTask` on the backend threw from `git.createWorktree`
with either:

- `fatal: '<path>' already exists`, or
- `fatal: a branch named 'dev3/task-XXXXXXXX' already exists`.

## Investigation

Two regressions in PR #571 combined:

1. **`runCleanupScript` in `src/bun/rpc-handlers/task-lifecycle.ts`** replaced
   `existsSync(task.worktreePath)` with `await Bun.file(task.worktreePath).exists()`.
   `Bun.file()` is documented for files; on directories `.exists()` returns `false`
   even when the directory is present. Verified with a quick Bun script:
   `Bun.file("/Users/arsenyp/.dev3.0").exists() // → false`.
   The cleanup script was being silently skipped on every move-to-done/cancel.

2. **`git.removeWorktree` in `src/bun/git.ts`** unconditionally calls
   `getCurrentBranch(task.worktreePath)` first. That spawns `git rev-parse` with
   `cwd: task.worktreePath`. When the worktree dir was missing, Bun threw
   `ENOENT posix_spawn 'git'` and `removeWorktree` aborted before deleting the
   branch — leaving a stale `dev3/task-XXX` ref behind.

The directory could disappear independently (a cleanup script `rm -rf`, manual
removal, or just `git worktree remove` partially succeeding). With the branch
left over, the next attempt to revive the task into a new worktree failed.

## Decision

Three fixes in `src/bun/rpc-handlers/task-lifecycle.ts` and `src/bun/git.ts`:

- `runCleanupScript`: import `existsSync` from `node:fs` and use it for the
  worktree-directory check.
- `removeWorktree`: check `existsSync(task.worktreePath)` first. If the dir is
  gone, skip `getCurrentBranch` + `git worktree remove`, run `git worktree prune`
  to clean stale metadata, and still attempt branch deletion using
  `task.branchName`.
- `createWorktree` default path: when `git worktree add` fails with "path already
  exists" or "branch already exists", reclaim the leftover (remove worktree dir
  via `git worktree remove --force` + `rmSync`, delete branch via
  `git branch -D`) and retry once. Safe because both the dir and the
  `dev3/task-*` branch are owned by dev3 — derived from `task.id`.

Regression tests cover all three: `git-worktree.test.ts` (removeWorktree with
missing dir, createWorktree self-heal for stale dir and stale branch) and
`rpc-handlers.test.ts` (existsSync used instead of Bun.file).

## Risks

- The `createWorktree` self-heal force-removes the leftover worktree dir before
  retrying. Anything still inside that dir is lost. In practice this dir only
  ever contains a previously-completed task's worktree that the user explicitly
  asked to revive, so the loss is intentional.
- Branch deletion uses `git branch -D` (force). Only triggers when the existing
  branch matches the task's deterministic `dev3/task-<id8>` name, so we cannot
  delete a user-owned branch by accident.

## Alternatives considered

- **Revert PR #571 entirely.** Rejected — its sync-spawn cleanup was a real
  improvement; the bug was a narrow API misuse.
- **Block the UI move with a "cleanup first" prompt.** Rejected — the user
  shouldn't have to know about stale leftovers from a previous bug.
- **Only fix `Bun.file` → `existsSync`.** Rejected — leaves users whose previous
  moves already corrupted state stuck.
