# Back off repositories that are gone, not just branches

## Context

A health audit found repositories that were deleted or never had an `origin` polled about 287 times a day each. The PR status read (`readTaskPullRequest`) had no failure memory at all, so a GitHub `NOT_FOUND` on `repository` repeated on every 5-minute poll, plus a second metadata-only query per poll. `fetchOrigin` did back off, but per `projectPath:branch` key with a 30-minute cap, so every branch of a dead repo retried on its own clock and a combined multi-branch fetch fanned out into one failing fetch per branch.

## Decision

- `src/bun/github-pr-status.ts`: a GraphQL `NOT_FOUND` whose path is exactly `["repository"]` puts that account+repository into a backoff (5 min base, doubling, 6 h cap). Reads during it return `null` without a network call or a log line; the metadata fallback query is skipped for this error. A forced refresh bypasses it; any successful read clears it.
- `src/bun/git.ts`: fetch stderr matching `repository not found` or `does not appear to be a git repository` also records a per-remote failure (`isRemoteInBackoff`, 2 min base, doubling, 6 h cap) that every branch and full fetch of that remote honours. `fetchOriginBranches` stops instead of retrying each branch on such an error. `force` bypasses; any successful fetch of the remote clears it.

## Risks

- State is in memory only, so an app restart retries immediately once. Persisting it would mean new on-disk state for a log-volume fix.
- A repository that comes back is noticed up to 6 h late by background polling; any explicit refresh (force) or a user-triggered git operation that forces finds it at once.
- Matching git's English stderr is brittle under a non-English locale; a miss only falls back to the old per-branch backoff.

## Alternatives considered

- A persisted "repo unreachable" flag per project with UI: more visible, but needs on-disk state and a new surface for a P3 problem.
- Raising the per-branch cap only: still multiplies by branch count and leaves the PR read unbounded.
