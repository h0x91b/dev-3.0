# The message receipt arms at the pty chunk boundary, measured on the typed envelope

## Context

[`agent-message-receipt-survives-a-lost-head`](../../08/31/agent-message-receipt-survives-a-lost-head.md)
gave every long `dev3 message` a `<full-copy>` receipt, armed at a body of 1 500 bytes — "where
the field report starts". The mechanism behind the lost head was unknown at the time, so the
threshold was a guess drawn from the symptom.

@yhattav then found the mechanism (issue #1608, 2026-09-02; upstream anthropics/claude-code#90910)
and it is not in dev3: the pty hands the receiving CLI about 1 KiB per read, Claude Code folds the
first chunk into a `[Pasted text #N +M lines]` attachment and appends the later chunks inline, and
the attachment is intermittently dropped at submit. The turn then holds only the inline tail —
truncated from the start, cut mid-word at the chunk boundary. Evidence: a 1 270-byte payload cuts at
byte 1 022 every time it cuts; a human Cmd+V reproduces it with no dev3 scheduler involved; on one
machine 38% of arrivals at Claude Code panes (n = 361) were tail-only against 7% at Codex panes
(n = 30). Load amplifies it, which is why a quiet repro box never fired.

## Decision

Two changes to the gate, no change to the receipt itself.

- **The threshold drops to the chunk size.** `AGENT_MESSAGE_RECEIPT_THRESHOLD_BYTES`
  (`src/shared/types.ts`) is 1 000: anything that fits one read is never folded and needs no
  receipt; anything longer arrives as at least two chunks and is exposed. 1 500 left every
  delivery between one read and 1.5 KB unprotected — the range where the report's short
  multi-part messages actually live.
- **It is measured on the envelope, not the body.** The pty chunks what is typed, and the
  `<dev3-ai-message>` header (sender, title, subject, reply command) is 200–400 bytes of that.
  `wrapWithReceipt` (`src/bun/scheduled-message-scheduler.ts`) wraps the body once without a
  receipt, measures that, and re-wraps with the path only when the measurement crosses the
  threshold; `writeAgentMessageReceipt` (`src/bun/agent-message-spill.ts`) now takes the typed
  size explicitly instead of measuring the body it is handed.

`src/bun/__tests__/agent-message-receipt.test.ts` pins both: a body under the threshold whose
envelope crosses it gets a receipt, a delivery that fits one read does not, and the constant is
asserted to sit at or under the measured 1 022.

## Risks

- 1 022 is a macOS measurement. Linux ptys buffer 4 KiB, so there the fold happens later or not at
  all and the receipt is merely earlier than needed — a spare line, never a missing one.
- This is still detection, not prevention: the receiver is told the head is gone and where the
  whole text is. The fix proper is upstream. A burst of several short messages released in one
  hold is typed as separate writes, and whether a later message's chunk gets folded was not
  measured; each message is gated on its own envelope.

## Alternatives considered

- **Type in sub-1 KiB pieces with pauses so nothing is ever folded.** Would prevent rather than
  detect, but it relies on the paste heuristics of a closed program at one version, breaks the
  pane-input seam's one-stage-one-command invariant, and the old rejection stands: a pause
  between pieces is a window for the user's own keystrokes to land mid-message.
- **Bracketed paste for the whole envelope.** Makes the entire delivery one attachment — the
  exact object that is being dropped — so it maximises exposure rather than removing it, and
  a harness without bracketed paste would receive raw escape bytes.
- **A receipt on every agent message regardless of size.** Simple, but a receipt line on a
  200-byte reply is noise on every peer exchange for a risk that does not exist under one read.
