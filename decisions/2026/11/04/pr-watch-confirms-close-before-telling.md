# pr watch confirms a close before telling the agent

## Context
h0x91b/dev-3.0#2168: a squash-merged PR was reported to its watching agent as "closed without merge", although `gh pr view` showed `MERGED` with a `mergedAt`. `evaluatePrWatches` (`src/bun/pr-watch.ts`) took GitHub's GraphQL `state` from a single poll as final, and firing removes the watch, so one wrong look could never be corrected.

## Investigation
Every reader (`readTaskPullRequest` in `src/bun/github-pr-status.ts`) maps GitHub's `state` straight through; there is no head-on-base inference. The maintainer's own logs only ever show squash merges as `MERGED`, so the reporter's sample most likely caught GitHub mid-merge, reading `CLOSED` before the merge landed. Not reproduced directly; the fix does not depend on the exact GitHub timing.

## Decision
Two layers. The GraphQL read also asks for `mergedAt` and reports any PR that has one as `MERGED` (`completePR`). And a `CLOSED` sample only marks the watch (`closedSeenAt`); "closed" fires when a poll at least `PR_WATCH_CONFIRM_GAP_MS` later still says `CLOSED`, the same two-look rule CI verdicts use. A `MERGED` sample fires at once; an `OPEN` one clears the mark.
Badges, `pr:` search tokens and the merge-completion offer already re-read every poll and act only on `MERGED`, so a transient `CLOSED` heals there on the next poll and needs no change.

## Risks
A genuine close reaches the agent about one poll later than before.

## Alternatives considered
Only adding `mergedAt`: it helps if `state` lags `mergedAt`, but not if GitHub reports both as not-yet-merged. A forced immediate re-read on `CLOSED`: a re-read seconds later can see the same transient state, and it costs an extra GitHub call.
