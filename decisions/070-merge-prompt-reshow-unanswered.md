# 070 — Merge-completion popup: re-show unanswered prompts, don't time-mute

## Context
A PR squash-merged while its task sat in `review-by-user`. The merge detector
worked correctly (`isContentMergedInto` via `merge-tree`), reserved the prompt,
and pushed `branchMerged` to the renderer — but the popup was never answered
(`dismissedAt: null`). The user reported the popup never appeared and never
came back.

## Investigation
Confirmed via app logs + `tasks.json`: detection and the push fired at the
right moment; the prompt slot was reserved (`promptedAt` set) but unanswered.
Two things then hid it permanently: (1) `shouldSuppressMergePrompt` muted any
prompt for `MERGE_PROMPT_FALLBACK_SUPPRESS_MS` (1h) based on `promptedAt`,
including unanswered ones; (2) both detection loops (the 60s poller and the
front-end panel poll) only consider `MERGE_COMPLETE_ELIGIBLE_STATUSES`, so once
the task flipped to `in-progress` (an agent resumed) it was excluded entirely.
The in-memory throttle is already cleared on every status change
(`clearMergeNotification` in `moveTask`), so the DB-level 1h window was the sole
remaining blocker on return to an eligible status.

## Decision
`shouldSuppressMergePrompt` now returns `false` for any prompt with
`dismissedAt === null` (extracted to the pure module
`src/bun/rpc-handlers/merge-prompt-suppression.ts` for testability). Only an
explicit user dismissal suppresses — permanently for a precise head, or for the
1h window under a non-precise fingerprint. Unanswered prompts re-offer
completion on the next poll once the task is eligible again. The in-memory
reservation still prevents the 60s poller from re-pushing every tick within a
session.

## Risks
While a task genuinely sits in an eligible status with the popup open but
unanswered, the in-memory reservation (1h TTL, cleared on status change)
prevents re-push spam; the renderer also de-dupes by fingerprint
(`runMergeCompletionPromptOnce`). No on-disk format change.

## Alternatives considered
- Add `in-progress` / `review-by-ai` to the eligible set (Option A): would nag
  completion while an agent is actively working — rejected.
- Persistent in-card "merged" banner instead of a one-shot push: larger change;
  deferred. This fix restores the intended re-show behavior with one decision.
