# Completion asks: a dialog by default, a bar in the agent's pane on request

## Context

`completion-offers-render-inline-not-modal` (#2215) moved merge and agent completion asks from the modal to a card at the top-right of the task's terminal, and `revert-inline-completion-offers-to-modal` (#2256) took it back out: the objection was the card's placement. The maintainer then asked for both styles behind a setting. Every open task holds an agent, a tmux session and memory, so the default must be the style that gets an answer soonest, and the inline style must sit where the eye already is: the agent's prompt at the bottom.

## Investigation

On a 145×38 Claude Code pane, a footprint of 80 columns × 6 rows covered 13% text at the top-right (stale output), 29% directly above the input box (the agent's own completion summary), 39% at the bottom-left and 48% at the bottom edge (the input box). A two-row bar at the bottom edge covered only the right end of the status and hint rows. QA then found three more limits: on a split task the terminal's corner is over the shell pane, a 52 px bar clips the input box's bottom border (the third row up in Claude Code's default layout), and a bar whose centred buttons move when its note opens loses the click aimed at Complete.

## Decision

A global setting `completionOfferStyle` (`"dialog"` default, `"inline"`) picks the surface. `src/mainview/completion-offers.ts` holds the pending merge and agent offers and the style, and every surface reads both live, so a switch moves waiting offers. In dialog mode `CompletionOfferDialogHost` asks each offer through `confirm()`, with the agent-request identity, the manual-completion action for merges and the gated `getUnsavedWork` check; the offer stays in the store, so card and sidebar markers (`CompletionOfferMark`) keep showing and an answer from any client closes the modal. In inline mode `TaskCompletionStrip` is a 36 px bar at the bottom-right of the agent's pane (`agentPaneInsets`: the first pane by index; the whole terminal for one pane or a zoomed one), capped within 72rem of the pane's left edge; its note opens upward on hover or focus while the title and buttons stay on the bottom line. Merge offers replay after a reload through `listPendingMergeOffers`. The user's own Complete/Cancel is not an offer: it asks beside the clicked button or in the modal (`user-completion-confirm-anchored-not-modal`).

## Risks

The dialog interrupts at detection time; users who prefer that it does not pick "On the task". A task whose agent is not in its first pane gets the bar over the wrong pane; dev3 launches the agent first, so this needs a user rearranging panes. No dialog is asked before the host's settings load, so a stored "On the task" never flashes a modal. An ask on the task can wait longer than an agent's own shell timeout: opencode gives up on `dev3 task move` after 120 s and runs it again. The retried request replaces the first, and an answer then still completes the task (checked live).

## Alternatives considered

- Pinning the bar above the input box: the box sits 3 to 8 rows from the bottom depending on harness and status line, and the rows above it are the agent's summary.
- The #2215 card at the top-right: rejected by the maintainer on the live build.
- A full-size card at the bottom: it covers the input box.
