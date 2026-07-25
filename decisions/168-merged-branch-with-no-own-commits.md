# 168 — Merged detection for a branch with no commits of its own

## Context

`getBranchStatusImpl` computed `mergedByContent` only when `status.ahead > 0` and
hardcoded `false` otherwise. A branch that was squash-merged and then rebased ends
up with `ahead === 0` (its own commit is gone, HEAD points inside the base
history) — the most merged state possible — yet reported as unmerged, and the
forced-refresh toast claimed "Branch isn't fully merged into main yet".

## Investigation

Reproduced on `fix/dev3-gh-env-token-auth` after PR #1077 landed: `ahead 0 /
behind 1`, and `git merge-tree --write-tree origin/main HEAD` equals
`origin/main^{tree}`. The guard could not simply be dropped: `ahead === 0` is
also what a brand-new branch with zero commits looks like, so the content
strategies would report every untouched task branch as merged and offer
completion for work that never existed.

`isContentMergedInto`'s existing GitHub fallback does not help either — it
requires the merged PR's `headRefOid` to equal current HEAD (deliberately, to
survive branch-name reuse), and a rebase moves HEAD off that oid. Verified:
PR #1077 `headRefOid` `1942a5bc` vs local HEAD `3ef6a493`.

## Decision

`ahead === 0` mathematically means HEAD is an ancestor of the compare ref, so no
local content check is needed — what is missing is proof that the branch ever had
work that landed. `getBranchStatusImpl` now takes that proof from the task's own
PR: `github.isPullRequestMerged(project, worktree, prNumber)` (`gh pr view N
--json state`), using the PR number recorded on the task (or the one just
detected). No PR, no GitHub, or offline ⇒ not merged. Task-scoped by
construction, so a reused branch name cannot borrow somebody else's merged PR.
Merged answers are cached for the process lifetime (a PR never un-merges),
negatives for 60 s, so the 15 s branch poll does not hit the API repeatedly.

The merge-watch activity (`src/bun/lifecycle/activities.ts`) gained the same
fallback on its `unpushed === -1` path, gated on `ahead === 0` so post-merge
commits are never mistaken for a finished branch.

## Risks

- Only GitHub-hosted repos get the merged-and-rebased signal; other remotes stay
  at "not merged" (safe direction, no false completion offers).
- A task whose PR merged but whose `prNumber` was never persisted stays "not
  merged" until a PR is detected again.

## Alternatives considered

- Drop the guard and always run `isContentMergedInto` — one line, but reports
  every brand-new branch as merged. Rejected.
- Persist a sticky "this branch had commits at some point" flag on the task —
  works offline and for non-GitHub remotes, but adds persisted state and is
  blind to tasks created before the field existed.
- Fix only the toast wording — removes the lie, leaves genuinely merged branches
  unable to be completed from the panel. Shipped alongside, not instead.
