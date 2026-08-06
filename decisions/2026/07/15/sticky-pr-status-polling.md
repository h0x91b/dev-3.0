## Context

Users need CI, review, and unresolved GitHub discussion state to remain visible while an agent leaves a review column to fix feedback. The existing PR poller only considered review-by-user and review-by-colleague tasks and only exposed a collapsed CI/review signal.

## Investigation

`gh pr list/view --json` exposes check and review-decision data but not review-thread resolution, so unresolved counts require `gh api graphql` and the `pullRequest.reviewThreads` connection. GitHub's check rollup also mixes CheckRun and StatusContext shapes, so the renderer needs a normalized per-check contract.

## Decision

Persist additive `prNumber` and `prUrl` fields on `Task` whenever branch or board PR lookup associates an open PR, then poll that task in every non-terminal status. Keep background promotion discovery review-scoped, use a one-minute active cadence only while CI is pending, paginate GraphQL thread pages against the PR URL's host, and send normalized checks plus mergeability through `taskPrStatus`; the shared renderer popover owns links, manual refresh, and a ten-row scrollable check list. The task inspector triggers one initial rich-status refresh after it learns a PR identity so opening a task does not depend on a prior push event.

## Risks

A GraphQL request adds one network call per successful PR poll and may fail independently of the REST request, so the unresolved count is nullable and never blocks CI/review badges. Old task files remain readable because the new fields are optional and no on-disk paths change.

## Alternatives considered

Using REST `gh pr view/list --json` for thread counts was rejected because it does not expose resolution. Keeping PR state only in renderer memory was rejected because it loses visibility as soon as a task moves to in-progress or the app reloads.
