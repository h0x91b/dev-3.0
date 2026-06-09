# 065 — Stop the false "Branch Merged" prompt on PR-review tasks

## Context

The merge-detection poller showed a false-positive "Branch Merged — mark this task as
completed?" prompt on a PR-review task whose branch was *not* merged. Review tasks are the
common trigger because their worktree sits on an existing (often reused) branch tied to a PR.

## Investigation

There are **two independent root causes**, on two different layers.

1. **Poller compares the branch against itself (the reported screenshot).** PR-review tasks are
   created from an `existingBranch`, and `deriveTaskBaseBranch` (`src/bun/data.ts`) stores that same
   branch as the task's `baseBranch`. The poller (`checkMergedBranches` in
   `src/bun/rpc-handlers/git-operations.ts`) then built `ref = origin/<baseBranch>` =
   `origin/<the-branch-itself>`. `isContentMergedInto` Strategy 1 (merge-tree of the branch against
   itself) is trivially `true`, so Strategy 3 was never even reached. Verified against the actual
   stored task: `existingBranch = origin/fix/deepseek-reasoning-dsml-recovery`,
   `baseBranch = fix/deepseek-reasoning-dsml-recovery`.
2. **gh-PR fallback trusts the branch name (latent bug).** `isContentMergedInto` Strategy 3 ran
   `gh pr list --head <branch> --state merged` and returned `true` for *any* merged PR matching the
   head branch *name*, with no check that the current HEAD content was actually merged. A
   previously-merged PR for a reused branch name (or an old merged PR coexisting with new unmerged
   work / an open PR) produces a false positive — but only on tasks whose base is a genuinely
   different branch (so cause 1 doesn't short-circuit first).

## Decision

Both layers are fixed; they are complementary, not alternatives.

1. **Poller (`checkMergedBranches`).** Resolve the live branch first; when the resolved base branch
   equals the current branch, fall back to the project's real `defaultBaseBranch` so a review task
   is compared against e.g. `origin/main` (and still gets a prompt when the reviewed PR actually
   lands). If even the project base equals the branch, there is no distinct base — skip.
2. **gh-PR fallback (`isContentMergedInto`, `src/bun/git.ts`).** Strategy 3 now fetches `headRefOid`
   and only returns `true` when it equals the current local HEAD (`git rev-parse HEAD`). In every
   GitHub merge method (merge / squash / rebase) the head ref tip is left untouched, so a genuine
   merge always matches, while stale/reused-name PRs do not.

Repro tests: poller behavior in `src/bun/__tests__/rpc-handlers.test.ts`; gh-fallback in
`src/bun/__tests__/git-merge-detection.test.ts`.

## Risks

- A genuine merge where the local branch was amended *after* merging would no longer be detected via
  gh — but content strategies 1/2 still catch real merges, and a false negative (no prompt) is far
  less harmful than a false positive (wrong "completed" prompt).
- The poller fallback assumes the project's `defaultBaseBranch` is the meaningful merge target for a
  review task. If a reviewed PR targets a non-default base, the prompt is simply not shown (false
  negative), which is acceptable.

## Alternatives considered

- Skip review tasks entirely when base == branch (PR #633) — kills the false positive but also drops
  the legitimate "reviewed PR landed in main" prompt. The fallback-to-project-base approach keeps
  the feature.
- For the gh fallback: also query open PRs and bail if one exists — weaker (doesn't cover
  branch-name reuse without an open PR) and needs an extra gh call.
- Drop Strategy 3 entirely — loses the legitimate "main diverged before AND after squash" detection
  that motivated it (decision history around PR #500/#536).
