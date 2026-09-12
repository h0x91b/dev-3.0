# "Preserved" also means reachable from a local ref, not just a remote one

## Context

The completion dialog warned "N commits never pushed — will be lost" for a task branch that
had been fast-forwarded into the **local** base branch and simply not pushed (issue #1684,
reported by @vit-pavlenko). The commits stay reachable from `main` after the branch ref is
deleted, so completing lost nothing; only the push was missing.

`decisions/2026/08/27/preserved-means-reachable-from-any-remote.md` had already widened
"preserved" once, from `origin/<branch>` to any remote ref. This is the same failure one step
further out: `getUnpreservedCount` asks `git rev-list HEAD --not --remotes`, and a local branch
is not a remote ref, so a fully merged branch keeps the `-1` sentinel. `getUnsavedWork` then
falls back to `ahead`, measured against `origin/<base>`, which a pending push leaves non-zero.

A warning that fires on every completion is the worst outcome for a safety dialog: it trains
people to click through the one message that must never be ignored, and the day the commits
really are unreachable it looks identical.

## Investigation

Reproduced with raw git. The three commands the code runs all answer "at risk"
(`origin/<branch>` missing, `rev-list HEAD --not --remotes` = 3, `ahead` = 3) while
`git merge-base --is-ancestor HEAD main` says every commit is already on the base. Only repos
that **have** an `origin` are affected: with no remote, `resolveCompareRef` falls back to the
local base, `ahead` becomes 0 and the dialog is already silent.

`git rev-list --count HEAD --not --exclude=<branch> --branches --remotes --tags` answers the
real question, "what still reaches HEAD once this branch ref is gone", in one command.
`--exclude` takes the name with `refs/heads/` **already stripped** and applies only to the
`--branches` that follows: spelling it `--exclude=refs/heads/<branch>` matches nothing, leaves
the task branch in the negative set, and makes HEAD answer for itself, so every branch reads as
preserved. That reverses the dialog's polarity, and a mocked-spawn test cannot see it — hence
the real-git suite.

Measured on a synthetic monorepo fixture (500,000 commits; 35,003 refs — 20,000 branches,
10,000 tags, 5,001 remote-tracking; task branch 5 commits ahead), median of 7 runs:
**86-93ms with no commit-graph, 38ms with one**, the same in all four preservation states. For
comparison, `getUnpreservedCount`'s existing `--not --remotes` costs 24ms / 13ms on the same
repo. `git for-each-ref --contains HEAD --count=1` expresses the identical question and was
rejected outright: it exceeded a 180s bound on that fixture, because `--contains` is evaluated
per ref.

## Decision

New `isPreservedOutsideBranch` (`src/bun/git.ts`) runs that sweep with a 2s `run({ timeoutMs })`
bound, ~20x the measured worst case and inside the dialog's own 4s confirm gate. It returns
`false` for every doubt — a failed or timed-out git, an empty branch name (a detached HEAD leaves
nothing to exclude), a repo with no other refs — because the flag's only power is to make a
data-loss warning quieter, so unproven must never read as safe.

It surfaces as `preservedOutsideBranch` on `BranchStatus` and `UnsavedWork`
(`src/shared/types.ts`), filled by both completion-dialog feeds in
`src/bun/rpc-handlers/git-operations.ts`. `unsavedWorkWarnings`
(`src/mainview/utils/confirmTaskCompletion.ts`) then picks `task.warnUnpushedButKept*` over
`task.warnNeverPushed*`/`task.warnUnpushed*`, which still says the work is unpushed but drops the
loss claim.

`unpushed` keeps its exact meaning and its `-1` sentinel; this adds a fact rather than redefining
one, so merge detection and PR polling are untouched.

## Risks

- Remote-tracking refs are deliberately **not** excluded from the sweep. `removeWorktree`
  (`src/bun/git.ts`) deletes only the local branch and dev3 never runs `push --delete`, so
  `origin/<branch>` outlives the task — but a user who deletes the remote branch by hand
  afterwards is outside what this check models.
- The 2s bound is generous against the measured 93ms worst case, yet a repo far larger than the
  fixture, or one under heavy IO, can still hit it. That degrades to the loud warning, never to a
  silent one.
- One more `git` on the completion path. It is cheaper than two checks already there, and runs
  inside the same `Promise.all`.

## Alternatives considered

- **`git merge-base --is-ancestor HEAD <local base>`** only. Cheaper and can name the base branch
  in the message, but misses a tag or another local branch holding the work; the maintainer asked
  for the broad check from the start.
- **Folding local refs into `getUnpreservedCount`.** Rejected: it would make `unpushed === 0`
  mean "safe somewhere", erasing the pushed/local distinction the dialog exists to draw.
- **`git for-each-ref --contains`.** Same answer, rejected on the measurement above.
