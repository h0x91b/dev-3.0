# 079 — PR CI / review status badges via the existing PR poller

## Context

Tasks already detect an open PR (the green `#N` badge) and auto-promote
`review-by-user → review-by-colleague` when one appears, but the app then went
blind: it never reported whether CI passed or how the PR review went. We wanted
CI-passed/failed and review (approved/changes-requested/commented) signals on
the card, feeding the existing attention machinery.

## Decision

- New CI/review state is fetched inside the **existing** background poller
  `checkOpenPRsForPromotion` (`git-operations.ts`) by widening its one
  `gh pr list --head` call to `--json number,isDraft,url,statusCheckRollup,reviewDecision`
  — **no new gh invocation, no new polling loop**. Pure collapse logic lives in
  the dependency-free `rpc-handlers/pr-status.ts` (`rollupCiStatus`,
  `mapReviewDecision`, `computeSignalKey`) so it is unit-testable in isolation
  (the `git-poll-throttle.ts` pattern).
- The poller now keeps `review-by-colleague` tasks as candidates (previously a
  task was dropped from polling the moment it was promoted). `prPromotedTasks`
  still gates only the one-shot promotion, not candidacy.
- Status is pushed to the renderer via a new passive `taskPrStatus` message
  (drives the badges; **not** Focus-Mode gated). On a *transition* to a worthy
  signal (settled CI or any review state — deduped via `prSignalState`), the
  poller raises the attention bell (`cliAttention`) and a watched-task native
  notification — both **gated on Focus Mode**.
- A `review-by-colleague` task enters the attention sidebar only while it has a
  live bell, so opening the task (which clears the bell) drops it from the pane.
- Clicking a badge moves the task to `review-by-user`.

## Risks

- `review-by-colleague` tasks are now polled indefinitely (5 min active / 15 min
  background) until they leave that status — more `gh` calls than before. Bounded
  by the existing throttle + the `peerReviewEnabled` gate.
- `statusCheckRollup` shape varies (CheckRun vs StatusContext); `rollupCiStatus`
  handles both but unknown future node shapes fall through to `pending`/`null`.

## Alternatives considered

- Enriching the frontend `getProjectPRs` 60s poll instead — rejected: the user
  wanted the gh fetch to live in the background job, not a more-aggressive
  renderer poll.
- Persisting CI/review state on the Task — rejected: it is live/ephemeral and
  would add tasks.json churn every poll. Pushed via event instead.

## Open questions (for PR review)

- Exact per-signal click target (e.g. approved+green → completed; failure →
  back to in-progress) — currently every badge click → `review-by-user`.
- Whether the bell is the right channel vs. a dedicated indicator.
- Whether a `sortTasks.ts` priority tier should also float signalled tasks.
- Whether watched-task native notifications should respect Focus Mode globally
  (this feature gates them; the older status-change notify does not).
