# Completion offers go back to the blocking modal

## Context

`decisions/2026/11/07/completion-offers-render-inline-not-modal.md` (#2215) moved the merge offer and the agent's completion request from the global `confirm()` modal into a card over the task's terminal, and `decisions/2026/11/07/user-completion-confirm-anchored-not-modal.md` (#2224) moved the user's own Complete/Cancel confirm into a popover beside the clicked button. The maintainer tried the inline "Branch merged. Is this task done?" card on the live build and preferred the modal.

## Decision

Both PRs are reverted. A merged branch, an agent's completion request and the user's own Complete/Cancel ask through the blocking `confirm()` modal again, as before #2215 (`App.tsx` `onBranchMerged` / `showCompletionDialog`, `utils/confirmTaskCompletion.ts`). `completion-offers.ts`, `CompletionOfferMark`, `TaskCompletionStrip` and the `listPendingMergeOffers` replay are gone. Changes later PRs made on top are kept; the one piece carried over by hand is the gitless wording from #1898/#2046: an agent completion request for a task without its own worktree says the folder is kept (`app.agentCompletionMessageFolder`).

## Risks

The problems #2215 addressed come back: the modal blocks the board until answered, an unanswered merge offer does not survive a reload, and the agent completion dialog again skips the unsaved-work check.

## Alternatives considered

Keeping the inline card and only restyling it was rejected; the objection was to the placement, not the look. Reverting only #2215 is impossible because #2224 builds on its strip.
