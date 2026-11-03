# Stop polling a saved PR that is already merged

## Context
The state of a MERGED pull request never changes, but its review threads, reviews and checks still can; after the merge they no longer drive any action. Still, the PR watch re-read the task's saved merged PR with the full CI and review-thread selection every 60 s / 5 min forever, and the merge proof re-read it after every restart.

## Decision
`savedPrMergedFromBranch` (`src/shared/task-pull-requests.ts`) treats the persisted `prStatusCache` as proof when `mergeState.state === "MERGED"`, the cache belongs to `prNumber`, and the new additive `headRefName` equals the task's current branch. The branch check is the ownership proof: an inherited stale number may point at another branch's PR. `pollTaskPrStatus`, `checkMergedBranches` and `getBranchStatus` then skip the saved-PR read. The open-by-branch lookup keeps its cadence (cheap, usually an empty answer) so a new PR is still detected quickly. It always runs, because a missing local `origin/<branch>` ref does not prove the branch is gone on GitHub (a PR from a fork has none). The merge watch takes the saved proof before any GitHub call. A forced refresh, an active `dev3 pr watch`, a pending merge-offer hold, and CLOSED / OPEN saved PRs keep the full read.

## Risks
An older app version that rewrites the cache drops `headRefName`, which costs one extra full poll that restores it. Review threads, reviews and checks now freeze in the saved cache until a forced refresh (popover hover or refresh), which is accepted for the same reason. The post-merge completion offer from the PR poll is kept through a pr-watch hold (one more full read after the hold ends); after a restart it falls to the merge watch, which uses the content check only.

## Alternatives considered
A slower cadence for merged tasks: rejected, it delays the badge of a new PR for little gain. An in-memory-only cache: rejected, it is lost on every restart.
