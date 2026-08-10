# Never destroy an inline review on send, and never hand a prompt to a shell pane

## Context

A reviewer pressed "Send to agent" on a diff review: the agent received nothing and
the whole review was erased. Intermittent — the next attempt worked. Reported through
Alexander Kiselyov (`@diverru`) on 2026-08-10, against `v1.42.x`.

## Investigation

Two independent defects sat on the same path.

1. **A resolved RPC was treated as proof of delivery.** `sendAgentMessageNow`
   (`src/bun/rpc-handlers/pr-comments.ts`) discards the `AgentPromptDelivery` that
   `sendMessageImmediately` returns and answers only `{ spilledPath }`. The renderer
   therefore could not tell `delivered` from `unconfirmed`, and
   `handleSendReviewToAgent` wiped `inlineComments` on every resolve — the auto-clear
   added in #1236. Even a `delivered` verdict only means tmux accepted the keystrokes;
   the agent's TUI can still drop a paste, which is exactly the intermittent shape of
   the report.
2. **A hand-off could be typed into a plain shell.** `resolveAgentPromptTargetPane`
   (`src/bun/agent-prompt.ts`) fell through to the session's *active* pane whenever a
   task had ≥2 live agent panes and no recorded last-focused agent. If the user was
   looking at a shell or dev-server split, the review went there. tmux reports
   `delivered` for any pane, so the send looked clean and the review then deleted
   itself. The pre-existing test `ignores a recorded pane that is live but not a
   registered agent pane` asserted this exact routing.

## Decision

- **The review is never destroyed by a send.** `handleSendReviewToAgent` and the
  composer's `Send now` now stamp `sentAt` on the comments they handed over
  (`markInlineCommentsSent`), the same sticky marking per-comment sends already used.
  Sent comments grey out, leave the export payload, and disable `Copy`/`Send`; the
  user clears them with the explicit, confirmed `Reset review`. This reverses the
  auto-clear of #1236 — deliberately, with the user's word: an unprovable delivery may
  not be allowed to delete the user's writing.
- **A hand-off goes to an agent pane or to nothing.** With ≥2 live agent panes and no
  recorded focus, the active pane is used only when it *is* one of them; otherwise the
  first live agent pane wins. The legacy "no agent registry at all" fallback to the
  active pane stays, and both fallbacks now log the pane they chose.

## Risks

- Reviewers who liked the self-clearing card must now press `Reset` once per round. It
  is one click (the icon-only button in the card's title line) and it asks first.
- Deterministically picking the first live agent pane can differ from the user's focus
  in a multi-agent task where the focus hook never fired. Landing in the wrong *agent*
  is recoverable; landing in a shell is not.

## Alternatives considered

- **Clear only on a proven `delivered`.** Would have required plumbing
  `AgentPromptDelivery` to the renderer, and still deletes reviews in the common case,
  because tmux says `delivered` even when the agent's input layer swallows the paste.
- **Leave the routing alone and only fix the clearing.** The review would survive, but
  the prompt would still silently land in a shell, so "I pressed send and the agent did
  nothing" would keep happening with no signal.
