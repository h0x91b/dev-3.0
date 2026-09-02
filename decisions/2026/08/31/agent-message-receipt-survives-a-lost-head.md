# A long agent message carries a receipt, because we cannot promise it arrives whole

> Superseded on 2026-09-02 by
> [`decisions/2026/09/02/receipt-arms-at-the-pty-chunk-boundary.md`](../../09/02/receipt-arms-at-the-pty-chunk-boundary.md):
> the mechanism was found (Claude Code drops the folded first ~1 KiB pty chunk at submit), so the
> receipt now arms at 1 000 bytes of the typed envelope rather than 1 500 bytes of body. The
> receipt design itself — a copy on disk, named on the last line — stands.

## Context

Issue #1608 (@yhattav, dev3 v1.35.1, tmux, macOS): roughly one in three `dev3 message`
deliveries over ~1.5 KB reached the receiving agent with its BEGINNING missing — the
prompt starting mid-sentence, the tail and the closing `</dev3-ai-message>` always intact.
A truncated delivery is worse than a failed one: the head is where the framing and the
constraints live, and the receiver cannot tell anything is gone.

## Investigation

Measured on current main, macOS, tmux backend. 67 sends through the production transport
and 8 deliveries into a real Claude Code 2.1.220, with **zero head loss**:

- Quiet pane, 1000–4800 bytes, 6 reps each (30 sends) into `stty raw; cat > sink` through
  the real `TmuxClient.sendKeysGuarded`: byte-exact every time.
- Same, with the pane also printing ~1000 lines/s (30 sends): byte-exact.
- Blocked reader — the pane sets raw mode and does not read stdin for 3 s while the
  payload lands (7 sends, 500–4800 bytes): byte-exact. tmux buffers on the master side.
- Real Claude Code: 2981 bytes idle (transcript-verified byte-exact), 2925 bytes with only
  a 30 ms gap before the Enter, 3000 bytes into a pane that had just been given work, and
  v1.35.1's uncoordinated scheme (two 3 KB messages 300 ms apart, each firing its own
  Enter) — three reps, every turn carried both messages whole. They MERGE, never truncate.

So the bytes do not die in the CLI socket, the hold queue, the paste, tmux, or the pty. The
only remaining candidate is the receiving agent CLI's input layer, which dev3 does not own.
One receiver-side behaviour is real and visible: Claude Code collapses a fast multi-chunk
raw write into `[Pasted text #N]` placeholders (three of them for 3 KB), sometimes leaving
one stray character after them — exactly the reporter's "single stray character before the
message body". On 2.1.220 those placeholders expand correctly on submit.

Version context: the reporter runs v1.35.1 (14 Jul 2026). The hold-and-coalesce path
(`agent-message-hold.ts`, one hold per pane, exactly one Enter per burst) landed 23 Aug and
first shipped in v1.48.0, so he does not have it. His Claude Code version is unknown.

## Decision

Deliver the second half of "whole, or the receiver is told": **make silent partial delivery
impossible rather than promise an integrity we cannot prove**.

- `writeAgentMessageReceipt` (`src/bun/agent-message-spill.ts`) writes any body over
  `AGENT_MESSAGE_RECEIPT_THRESHOLD_BYTES` (1 500 — where the field report starts) to
  `<taskDir>/messages/receipts/`, and prunes to the newest `AGENT_MESSAGE_RECEIPT_KEEP`
  (50). Its own directory, never beside the spill files: a spill is the only copy of a body
  that was never typed, so pruning must not be able to reach one. Best-effort — a receipt
  that cannot be written is logged and the message still goes out.
- `wrapAgentMessage` (`src/shared/agent-message-envelope.ts`) takes `fullCopyPath` and emits
  `<full-copy>…</full-copy>` as the LAST line before `</dev3-ai-message>`. Head loss by
  definition removes the beginning, so a pointer placed last cannot be eaten by the thing it
  exists to survive.
- `deliverToTarget` (`src/bun/scheduled-message-scheduler.ts`) writes the receipt for agent
  traffic only; a human watching the pane sees what happened to his own message.
- The agent protocol text (`src/shared/agent-skill-content.ts`) states the rule and its
  limit: a closing tag with no opening line means a lost head, read the named file and say
  the delivery was truncated — and this catches a lost HEAD only, never a gap in the middle.

The spill threshold stays at 4 000. Lowering it would degrade a channel that measures clean.

## Risks

- The rule is blind to a middle loss, which leaves both tags in place. Stated in the
  protocol text rather than left implied.
- One extra line in every long envelope, and one file write per long message. Bounded at 50
  files per task, and the directory dies with the task.
- Only Claude Code 2.1.220 was driven, on tmux. Another harness, another version, or the
  native backend may lose bytes differently; that axis stays open.

## Alternatives considered

- **Bracketed paste** (`ESC[200~ … ESC[201~`) so the receiver treats the payload as one
  atomic paste. It targets the placeholder collapse that was actually observed, but a
  harness that does not enable bracketed paste would receive raw escape bytes — turning a
  cosmetic problem into a real one — and no measurement shows the collapse is lossy.
- **Lowering the spill threshold to ~1 500** so nothing risky is ever typed. It moves the
  boundary without naming a mechanism, and makes nearly every peer report a two-step read.
- **A byte count in the envelope** for the receiver to verify. A model cannot reliably count
  bytes, so the check would be theatre.
