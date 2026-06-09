# 065 — Gate the gh-PR merge-detection fallback on head commit match

## Context

The merge-detection poller showed a false-positive "Branch Merged — mark this task as
completed?" prompt on a PR-review task whose branch was *not* merged. Review tasks are the
common trigger because their worktree sits on an existing (often reused) branch tied to a PR.

## Investigation

`isContentMergedInto` (`src/bun/git.ts`) has three strategies. Strategies 1 (merge-tree) and 2
(patch-id) are content-based and were empirically confirmed to correctly return `false` for a
genuinely unmerged branch. Strategy 3 was the culprit: `gh pr list --head <branch> --state merged`
returned `true` for *any* merged PR matching the head branch *name*, with no check that the current
HEAD content was actually merged. A previously merged PR for a reused branch name (or an old merged
PR coexisting with new unmerged work / an open PR) produced the false positive.

## Decision

Strategy 3 now fetches `headRefOid` and only returns `true` when it equals the current local HEAD
(`git rev-parse HEAD`). In every GitHub merge method (merge / squash / rebase) the head ref tip is
left untouched, so a genuine merge always matches, while stale/reused-name PRs do not. See
`isContentMergedInto` in `src/bun/git.ts`. Repro tests in
`src/bun/__tests__/git-merge-detection.test.ts`.

## Risks

A genuine merge where the local branch was amended *after* merging would no longer be detected via
gh — but content strategies 1/2 still catch real merges, and a false negative (no prompt) is far
less harmful than a false positive (wrong "completed" prompt).

## Alternatives considered

- Also query open PRs and bail if one exists — weaker (doesn't cover branch-name reuse without an
  open PR) and needs an extra gh call.
- Drop Strategy 3 entirely — loses the legitimate "main diverged before AND after squash" detection
  that motivated it (decision history around PR #500/#536).
