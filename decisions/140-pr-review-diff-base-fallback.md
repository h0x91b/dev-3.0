# 140 — PR-review diff base falls back to the project base branch

## Context
A task created from a GitHub PR (or any "existing branch" task) checks out the PR
head branch. `deriveTaskBaseBranch` (`src/bun/data.ts`) normalizes the task's
`existingBranch` and stores it as `baseBranch`, so for these tasks
`baseBranch === branchName`. Every comparison consumer then compared the branch
against itself: the branch-mode diff ran `<branch>...HEAD` (empty), ahead/behind
was `0/0`, and rebase/merge targeted the branch itself. Users saw "No changes to
show" when clicking Diff on a PR-review task (issue reported for base44 PR #16484).

## Investigation
Confirmed against on-disk task data: `baseBranch === branchName ===
codex/remote-verification-retry-safety`, `existingBranch =
origin/codex/...`, `prNumber = 16484`. The merge-completion poller already had an
inline workaround for exactly this (`git-operations.ts`, ~line 399) — it falls back
to the project base branch when `baseBranch === live branch` — but the diff/status
paths did not.

## Decision
Added a shared pure helper `resolveTaskCompareBaseBranch(task, project)` in
`src/shared/types.ts`: returns `task.baseBranch`, except when it collapses onto
`task.branchName`, in which case it returns `project.defaultBaseBranch` (default
`main`). Routed the diff/status/rebase/merge base derivation through it in
`src/bun/rpc-handlers/git-operations.ts` (`getTaskDiff`, `getBranchStatusImpl`,
`rebaseTask`, `rebaseTaskViaAgent`, `mergeTask`) and in the renderer
`useTaskBranchStatus.ts` (so `compareRef`, `displayRef`, and the compare-ref
dropdown all use the real base). This fixes already-created tasks with no data
migration — the stored `baseBranch` is unchanged; only the comparison resolution
changed.

## Risks
The fallback assumes the PR targets the project's default base branch. If a PR
targets a non-default base, the diff shows slightly more than the PR (commits
between the real PR base and the default base). This mirrors the existing
merge-completion behavior and is far better than an empty diff. We do not query
`gh pr view --json baseRefName` to keep the path offline. The merge-completion
poller keeps its own inline fallback (it needs to *skip* rather than fall back
when the project base is also the branch itself).

## Alternatives considered
- **Fix `deriveTaskBaseBranch` at creation.** Would not repair existing tasks and
  broadens the change to worktree creation semantics.
- **Capture the PR base ref at task creation.** Most precise, but needs plumbing
  through the PR-import flow and still needs a fallback for existing tasks. Left as
  a future improvement.
