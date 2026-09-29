# Sequential PRs: one current PR plus a ledger beside the legacy PR fields

## Context

A task stored exactly one PR (`prNumber`, `prUrl`, `prStatusCache`), and the last open PR found for its branch overwrote it. A task that kept working after its PR merged hit three problems. The PR poller offered "is the task complete?" on every follow-up commit, because it trusted a MERGED state with no head check (the merge watcher already had one). A merged or closed PR still hid Create PR. Merge promised "Merge PR #N" and then failed. The replaced PR also vanished without a trace.

## Investigation

`tasks.json` keeps unknown top-level fields across older versions: `rawLoadTasks` is `JSON.parse(...) as Task[]`, updates spread `{...task, ...updates}`, and saving is `JSON.stringify`. The same pattern appears in the source of v1.45 through v1.55.2; no old build was run against a file with the new field. Old pollers keep writing only the legacy trio, and they replace `prStatusCache` wholesale. Concurrent PRs do not fit a task at all: one worktree has one checked-out branch, and discovery keys on that branch.

## Decision

- **One current PR plus history.** The legacy trio stays the current PR. `Task.pullRequests` is a new top-level, append-only ledger of every PR the task has had.
- **Ledger writes.** `recordPullRequestSighting` (`src/shared/task-pull-requests.ts`) updates the ledger inside the single PR writer, `persistPrStatus` in `executor.ts`.
  - It records the PR being replaced from the fields about to be overwritten. So a PR an older build saw first still enters the ledger the next time a newer build replaces it.
  - It returns null when nothing changed, so a poll adds no write.
- **Reset** to To Do clears the ledger with the trio.
- **Only an OPEN PR is actionable.** `BranchStatus.prState` together with `isPullRequestFinished` / `isLivePullRequest` gate Create PR and the Merge route. A finished PR stays displayed.
- **Merge prompt gate.** `mergedPrCoversHead` in `activities.ts` offers completion only when the merged PR's head is HEAD, or the branch has nothing of its own left, and the worktree is clean.
- **UX placement.** The history is a read-only "Earlier pull requests" list in the PR popover and a PR row in the archived task view. Nothing was added to the card or the sidebar, and there is no per-PR switcher. This follows the existing budgets, so the UX manifest is unchanged.

## Risks

- **An older build overwrites PR #1 with PR #2 before any newer build has seen #1.** #1 is then lost. Nothing on disk recorded it.
- **An older build's reset clears the trio but leaves the ledger.** The stale entries show up as "earlier" PRs.
- **`isLivePullRequest` treats an unknown state as live.** An offline inspector therefore behaves as it did before this change.

## Alternatives considered

- **First-class concurrent PRs:** per-PR pollers, selectors and "all merged" completion. Rejected for now: it contradicts one branch per worktree and exceeds the card, sidebar and inspector budgets.
- **A list inside `prStatusCache`:** old pollers would drop it.
- **Clearing the PR on merge:** loses the badge and the review threads of the PR the user just shipped.
