# Doctor's unmerged-branch guard reads the branch the worktree has checked out

## Context

`dev3 doctor --worktrees` and the daily 14-day prune keep a leftover worktree on an unmerged branch for 60 days
(`UNMERGED_PRUNE_FLOOR_DAYS`). The guard looked up only `dev3/task-<shortId>`, but every agent renames that branch at
session start (`feat/dev3-…`, `fix/dev3-…`). Measured on 2026-11-12: 82 of 85 live worktrees reported `branch: null`,
so for them the floor never applied, and the worktree went at day 14 with its uncommitted changes.

## Decision

`readRepoFacts` (`src/cli/commands/doctor-worktrees.ts`) now records the `branch refs/heads/…` / `detached` line of
`git worktree list --porcelain` per worktree. The entry's `branch` is that checked-out branch, falling back to
`dev3/task-<shortId>` for a worktree git no longer registers. A detached HEAD counts as unmerged (`needsForce`),
because nothing proves its commits landed. `deleteBranchIfSafe` still deletes only `dev3/task-*` refs: a renamed
branch carries a name someone chose and may have pushed, so its ref is always kept.

## Risks

- PRs here are squash-merged, which `git branch --merged` does not see, so a renamed branch of a merged PR now waits
  the 60-day floor instead of 14 days. Only leftover worktrees (teardown never ran) are affected; normal teardown is not.
- Uncommitted changes are still lost once the floor passes; a dirty-tree check is a separate follow-up.

## Alternatives considered

- Matching by branch name patterns (`*/dev3-*`): guesses, and misses user-named branches.
- Treating every unknown branch as unmerged: blocks orphans of repos that are gone, where git cannot answer at all.
