# A click is never held — only CLI and queued messages wait for a quiet pane

## Context

`decisions/2026/08/23/hold-the-agent-message-not-just-its-enter.md` moved the hold
from the Enter to the whole message: nothing is typed until the pane goes quiet
(15 s of message traffic, 60 s after a human keystroke). It asked for that hold at
`scheduled-message-scheduler.deliverToTarget` — the seam every message path shares —
and that seam turned out to carry click paths too.

The visible consequence: a user pressed "Send to agent" under a review comment and
the terminal stayed empty. The button reported success, nothing appeared, so they
re-clicked, tried the other send buttons, and finally copied the text and pasted it
by hand — at which point it went in. Reported over Telegram the day after the merge.

## Investigation

`sendAgentMessageNow` (the RPC behind all four send buttons in `TaskDiffViewer`) and
`deliverLaunchHandoff` both go through `sendMessageImmediately`, which asked for the
hold unconditionally. Before the 08/23 change the text was typed at once and only
the Enter waited, so the button always *looked* like it worked; after it, the whole
message sat in dev3's memory with no trace on screen. The chip's "Send now" on a
queued message had the same shape.

## Decision

`hold` becomes the caller's call. `deliverToTarget(task, message, hold)` takes it as
a required argument, `sendMessageImmediately(..., { hold })` defaults it to **true**
(the CLI path, which is what #1495 was about), and the three paths that exist because
a user just clicked something pass `hold: false`:

- `rpc-handlers/pr-comments.sendAgentMessageNow` — the review / PR-thread send buttons.
- `sendScheduledMessageNow` — the scheduled-message chip's "Send now".
- `agent-launch-handoff.deliverLaunchHandoff` — the note a just-booted child agent
  hears; nobody has typed into that pane yet and its launcher is waiting on the reply.

`dev3 message` (immediate and `--in`/`--at`) and the scheduler's own due fires keep
the hold, so issue #1495 stays fixed for the traffic it was about: agent-to-agent
bursts and anything arriving while the user types.

## Risks

- **A click can still land in a half-written line.** If the user has an unfinished
  prompt in the agent's input box and then clicks "Send to agent", the review text is
  appended to it and submitted together. That was the behaviour for months before
  08/21 and it is the price of a button that visibly does something.
- **Five review comments sent in five clicks are five agent turns.** The coalescing
  that a hold would give up is real; a "send all comments" control already exists for
  the batch case, and Claude Code queues text typed during a turn.
- **The handoff note now submits ~800 ms after the pane appears.** If an agent CLI is
  slower than that to accept input the note is lost; the poll only proves the pane is
  alive, not that the TUI is ready. Pre-08/21 timing, so not a new class of failure.

## Alternatives considered

- **Type immediately, hold only the Enter, for clicks** — the user's own fallback
  ("как минимум писаться, а Enter попозже"). Keeps burst coalescing, but the agent
  still does nothing for up to a minute after a click, and the mid-line risk is
  identical, because the text goes in either way.
- **Gate on `message.source`** (hold agent-to-agent only). Rejected once already in
  `decisions/2026/08/21/hold-the-enter-behind-dev3-message.md`: a human sending three
  `dev3 message` lines in a row has the same burst problem. Origin, not authorship,
  is the axis that actually separates these cases.
- **Keep the hold and show pending messages in the UI.** A queue indicator is more
  machinery than the problem needs, and the user asked for the button to be instant.
