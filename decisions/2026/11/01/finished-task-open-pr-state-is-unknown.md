# A finished task's stored OPEN PR state reads as unknown

## Context
prWatch stops polling once a task is completed or cancelled (`activitiesFor` in `src/bun/lifecycle/machine.ts`), so `prStatusCache` and the `pullRequests` ledger keep whatever the last poll saw. Tasks are routinely completed by git merge detection or before auto-merge lands, so the last poll saw OPEN: on the dev-3.0 board ~200 finished tasks matched `pr:open`, and their cards showed "Mergeable".

## Decision
`isTrustedStoredPrState` / `trustedPrStatusCache` in `src/shared/task-pull-requests.ts`: on a finished task an OPEN state is untrusted, and the whole `mergeState` (its mergeable/status describe an open PR) is dropped. MERGED and CLOSED are final and stay. Every reader goes through it: `taskPrState` (search tokens, preferring a trusted ledger state over a stale cache), `taskPRBadgeFromStoredData` / `mergeTaskPRBadge` (the host PR map behind cards, sidebar and table view), the inspector badge, and `allPullRequests` / `earlierPullRequests`. Stored data is not rewritten.

## Risks
`pr:merged` does not find a finished task whose PR merged after its last poll — it reads unknown, not merged. A PR genuinely still open on a cancelled task also reads unknown.

## Alternatives considered
Inferring MERGED from completion or git merge detection: a git merge does not prove which PR merged, and a cancelled task's PR may be closed. One final PR read at the terminal transition, or a background reconcile of finished tasks' non-final states: both fix the data, not just the display, but need a new lifecycle effect and network reads for terminal tasks; left as a follow-up. This display rule stays correct either way.
