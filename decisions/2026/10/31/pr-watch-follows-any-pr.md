# `dev3 pr watch --pr <N>` follows any open PR of the repository

Extends `decisions/2026/10/22/pr-watch-opt-in-subscription.md`, whose "own branch only" rule this replaces.

## Context

A coordinator that hands a fix to another task (a review task pushing onto a contributor's fork, then auto-merging) had no way to hear when that PR's CI finished or it merged: `--pr N` was only a safety check against the caller's own branch PR and exited 38 otherwise. The restriction existed because the poller only sampled the branch's open PR, and that sample also drives the task's PR identity, badge and merge-completion offer — none of which may be pointed at somebody else's PR.

## Decision

A watch for a PR that is not the task's own branch PR is **pinned** (`PrWatch.pinned`, `src/shared/pr-watch.ts`). `pr.watch.add` (`src/bun/cli-socket/pr-watch-commands.ts`) reads PR N by number (`readTaskPullRequest(project, worktree, "", N)`), so fork heads work. When N is open, its head branch is the current branch, the task is not `foreignCode` and the branch lookup returns the same number, the watch is the ordinary branch watch, exactly as without `--pr`; anything else is pinned. A pinned watch never becomes the task's PR identity. The PR poller (`checkOpenPRsForPromotion`, `src/bun/lifecycle/activities.ts`) also takes tasks that only have pinned watches; `pollPinnedPrWatches` reads each pinned number in parallel with the own-branch poll and hands each sample to `runPrWatches(..., pinnedPr)`, which judges only that PR's watches (the branch run judges only branch watches, so a pinned watch is never "replaced"). Delivery goes to the subscriber as before.

Head semantics: a pinned watch starts at the PR's `headRefOid`, not the local HEAD, and is judged against `PINNED_PR_WATCH_GIT` — no remote tips, no local commits. GitHub's head is the PR's head: a changed head is a push and moves the watch, a force-push back included, and the CI verdict is for whichever head is current when it is confirmed twice. A watch made before the push one waits for may report the old head's CI; the message names the short SHA and the help says to subscribe after the push. A merged pinned PR says it offers no completion (`completion: "pinned"`), never starts or holds the merge-completion offer, and does not count in `mergeOfferHeld` or the poller's saved-merge shortcut. Watches are one per `--until` and PR (`upsertPrWatch`), up to `PR_WATCH_MAX_PINNED_PRS` (10) followed PRs per task; `--off --pr N` drops one PR's watches. An already merged or closed PR exits 43 (`CLI_EXIT_CODE_PR_WATCH_PR_FINISHED`), a PR the repository does not have (or a gh timeout) exits 38.

## Risks

Each followed PR is one GitHub read per minute, which is why the count is capped. A PR whose read keeps failing (repo transfer, lost access) keeps its watch until `--off`; after three failed reads in a row it is read with exponential backoff (5 min doubling to 6 h, `pinnedPrBackoffMs`), per task and PR, on top of the per-repository backoff of `github-pr-status.ts`. A transient outage of three minutes delays that PR's notice by up to the first backoff. An older dev3 reading a pinned watch treats it as a branch watch and may end it with a "replaced" notice. A task in a virtual project cannot watch, since it has no repository to read from.

## Alternatives considered

Treating every `--pr` as pinned would have changed today's `--pr <own PR>` behaviour (tips at subscribe, merge-offer hold). A separate poller for pinned PRs would duplicate the tick, its deadlines and cadence. Using local remote tips for fork heads was rejected: the commit is usually not in the worktree, and GitHub's head is the only authority on a PR the task does not push.
