> Superseded on 2026-11-09 by `decisions/2026/11/09/revert-inline-completion-offers-to-modal.md`: reverted, completion asks through the blocking modal again.

# Completion offers render inline on the task, not as a modal

## Context

Two things asked the user to complete a task: merge detection ("the branch is in the base branch") and an agent running `dev3 task move --status completed`. Both opened the global `confirm()` modal: a full-screen backdrop, no backdrop dismiss, autofocused decline, queued one at a time. Users reported that it fires too early, while follow-up work remains (review comments, a deploy check, a second PR), and that it blocks the board and every other task until answered. "Not now" only held until the next merge, so every later merge or rebuild of an integration branch asked again. The agent dialog also never ran the unsaved-work check that the user's own ✓ and the agent cancellation dialog run, so the only guard was the "preservation gate" sentence in the agent protocol.

## Decision

The offer becomes task state, shown where the task already is. `src/mainview/completion-offers.ts` holds the pending offers: `offerCompletion()` resolves with the answer and is a drop-in for the old `confirm()` call in `offerMergeCompletion` and in the `App.tsx` agent-request effect, so reservation, dismissal, manual completion, cross-client abort and replay on connect are unchanged. `TaskCompletionStrip` renders the offer as a card floating over the top-right of the task's live terminal viewport (every viewport branch of `TaskTerminal`, immersive fullscreen included), so the terminal never resizes. Where no terminal viewport is live (a session-ended screen) the same strip renders as a row under the inspector instead; `registerCompletionOverlayHost` decides which one shows. It takes no focus, ignores pointer clicks for 600 ms and gates Complete on `getUnsavedWork` (skipped where `completionSkipsGitCheck` says nothing can be lost, which covers no-worktree and virtual-project tasks). `CompletionOfferMark` puts a passive marker (agent glyph or merge glyph, never the ✓ of quick-complete) on the card and the sidebar row. Every offer also rings the task's bell, and when no strip for the task is mounted (another task, the board, immersive fullscreen) a toast names the task and opens it. Complete re-runs the git check on click, because an offer can wait for hours; losses that appeared meanwhile show first and need a second click. A second offer of the same kind on a task joins the first instead of stacking. The CLI contract (blocking, exit code 6 on decline, a later approval still completes) does not change.

## Risks


- Offers live in renderer memory, so every client replays them on connect and reconnect: agent requests through `listPendingCompletionRequests`, merge offers through `listPendingMergeOffers` (`lifecycle/activities.ts`), which returns an undismissed offer only while its reservation is live and the branch head still matches the merged fingerprint. After an app restart no reservation exists, and the poller offers again on its next tick.
- The floating card covers the top-right corner of the terminal while it waits; that corner is usually empty, and the card goes the moment it is answered.
- An ignored offer no longer forces an answer, so a blocked agent can wait out its 10-minute CLI timeout more often. A later approval still completes the task.

## Alternatives considered

- The fire-and-forget push with a persisted board badge that decision 067 rejected: this is not it. The CLI still blocks and gets the verdict in the same call, and the marker lives only in renderer memory beside a live request.
- Moving agent cancellation and reset inline too: kept as modals on purpose. They destroy uncommitted work with no "done" claim behind them, so interrupting the user is the right cost there; completion follows a claim that the work is preserved.

- A toast with a Complete button: rejected, a destructive move from a message on screen for seconds.
- A row between the inspector and the terminal everywhere: it resized the terminal (and reflowed tmux) twice per offer.
- A global pending-approvals tray: a new surface for a rare event, and it still takes the user away from the task the decision is about.
- Keep the modal but allow dismissing it to a chip: still interrupts at detection time, which is the reported problem.
- Changing what counts as merged (PR state only): detection is correct for every project type (remote, local-only, no PR flow), so the fix belongs in how the offer is shown, not in when it is detected.
