# Task message draft

## Context

The only place to write to a task's agent was its terminal input line. A held `dev3 message` waits for the user's typing to go quiet (`decisions/2026/08/23/hold-the-agent-message-not-just-its-enter.md`), but after that window it is typed behind a half-written line and its Enter submits both. Users also wanted to park a follow-up until the agent finished its turn, without a notepad (issue #2281).

## Decision

One optional `Task.messageDraft` (`{ text, sendOnStop?, updatedAt }`, `src/shared/types/scheduled-messages.ts`), edited in the existing Send later dialog (`ScheduleMessageModal`), which autosaves it and gains **Now** / **When agent stops** beside In/At (`SchedulePicker` now takes a list of extra modes). An armed draft is sent from the lifecycle `notifyStatusChange` effect when the task enters `review-by-user` or `user-questions` (`fireArmedMessageDraft` in `scheduled-message-scheduler.ts`), through the hold, because the user may be typing in that pane. It is disarmed inside the tasks lock before sending, so two quick stops send it once. A failed send keeps the text, disarmed, with a toast and an attention badge. The draft is cleared only if it was not edited while going out (compared by `updatedAt`). It renders in the `ScheduledMessagesChip` slot rather than a new badge.

## Risks

A draft handed to the hold is cleared at once; if the hold later drops it (the pane went away inside the quiet window) the hold's own drop report is the only trace, the same as any held message. `review-by-ai` deliberately does not fire it: a message to the main agent while the AI reviewer works would race the review.

## Alternatives considered

Detecting a non-empty agent input box before releasing a held message: per-harness screen scraping, fragile, and it does not cover parking a message for later. Storing drafts as scheduled messages without `at`: older versions read `at` as required and would render an invalid countdown. A new card badge and session-bar button: the bar is at its four-control budget and the card already has one deferred-work chip slot.
