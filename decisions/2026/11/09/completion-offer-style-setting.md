# Completion offers: a dialog by default, a bottom bar on request

## Context

`completion-offers-render-inline-not-modal` moved merge and agent completion offers from a modal to a card at the top-right of the task's terminal. The maintainer pushed back on two points. First, every open task holds an agent, a tmux session and memory, so an offer that waits unnoticed keeps them alive longer than needed. Second, the card sits at the top-right while the eye reads the agent's output at the bottom, so it is missed.

## Investigation

On a 145×38 Claude Code pane, a footprint of 80 columns × 6 rows covered 13% text at the top-right (stale output), 29% directly above the input box (the agent's own completion summary, the text the user needs to decide), 39% at the bottom-left, and 48% at the bottom edge (the input box itself). A two-row bar at the bottom edge covered 27-31%, and only the right end of the status line and hint rows. While an offer waits, the agent is blocked on `dev3 task move` or idle, so those rows carry the least.

## Decision

A global setting `completionOfferStyle` (`"dialog"` default, `"inline"`) picks the surface. `src/mainview/completion-offers.ts` holds it and every surface reads it live, so a switch moves waiting offers. In dialog mode `CompletionOfferDialogHost` asks each store offer through `confirm()`, with the agent-request identity, the manual-completion action for merges and the gated `getUnsavedWork` check; the store entry stays, so card markers keep showing and an answer from anywhere closes the modal. In inline mode `TaskCompletionStrip` floats at the terminal's bottom-right; an unsolicited offer is a one-line bar whose note opens on hover or focus, and warnings always show. The user's own Complete/Cancel stays where they clicked in both modes.

## Risks

The dialog interrupts at detection time, which the inline design removed; users who prefer that pick "On the task". The bar covers the right end of the bottom rows, which on some harnesses is a hint line. No dialog is asked before the host's settings load, so a stored "inline" choice never flashes a modal.

## Alternatives considered

- Pinning the card above the input box: the box sits 3 to 8 rows from the bottom depending on harness and status line, and the rows above it are the agent's summary.
- Keeping only the inline card: the maintainer asked for the faster-freeing modal back.
- A full-size card at the bottom: it covers the input box.
