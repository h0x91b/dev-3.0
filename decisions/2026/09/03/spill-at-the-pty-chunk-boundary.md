# Nothing longer than one pty read is ever typed into an agent pane

## Context

Issue #1608: a `dev3 message` between two tasks arrives with its BEGINNING missing.
Two earlier passes shipped detection — a `<full-copy>` receipt beside the task
([`agent-message-receipt-survives-a-lost-head`](../../08/31/agent-message-receipt-survives-a-lost-head.md))
and a separator between welded envelopes
([`separate-the-messages-inside-one-burst`](../../08/31/separate-the-messages-inside-one-burst.md)) —
without a mechanism, because dev3's own transport measured byte-exact every time.

The mechanism is now known and it is not ours (upstream anthropics/claude-code#90910, two
independent fleets): the pty hands the receiving CLI about **1 022 bytes per read**; Claude Code
folds the first chunk into a `[Pasted text #N +M lines]` attachment, appends later chunks inline,
and **intermittently drops that attachment at submit** — roughly 38% of arrivals on an affected
build (n = 361), against 7% on Codex panes (n = 30). It is a regression: 2.1.220 and 2.1.227 never
truncate, 2.1.252 and later do.

Confirmed here rather than taken on trust. A message from this task to Seq 1786 (body 863 bytes,
one line; typed envelope 1 186 bytes) arrived as exactly the bytes from offset 1 022 to the end —
predicted with `wrapAgentMessage` **before** comparing with what the receiver held, and the
receiver's own count matched to the byte. The 1 500-byte receipt threshold missed it, so that
message had no copy on disk at all.

## Decision

**Stop typing anything that cannot arrive in one read.** Detection is replaced by prevention.

- `AGENT_MESSAGE_SPILL_THRESHOLD_BYTES` (`src/shared/types.ts`) goes 4 000 → **1 000**, and is
  measured on the **typed envelope**, not the body: `spillOversizedAgentMessage`
  (`src/bun/agent-message-spill.ts`) takes the sender/subject and wraps the body with the real
  `wrapAgentMessage` to size it. The header is 200–400 bytes of what the pty chunks, so a
  700-byte body under a long title was exposed while measuring as safe.
- The pointer that replaces a long body is ~450 bytes of envelope — one chunk, by construction.
- **A burst obeys the same cap.** The receiver chunks one *read*, not one paste, so three
  600-byte envelopes released together are 1 800 bytes of one stream. `release()`
  (`src/bun/agent-message-hold.ts`) now types only the messages that fit 1 000 bytes
  (`burstFitCount`, always at least one), submits them as one turn, and re-holds the rest for the
  next quiet window as their own turn. The board trailer is offered the remainder and dropped by
  the adapter when it does not fit — a stale snapshot costs a snapshot, a split stream can cost
  the ruling.
- **The receipt code is deleted outright**: `writeAgentMessageReceipt`,
  `AGENT_MESSAGE_RECEIPT_*`, the `<full-copy>` tag, and its test. The spill file is the copy, and
  the protocol text (`src/shared/agent-skill-content.ts`) now says a long message arrives as a
  path to read, while a closing tag with no opening line still means "truncated, do not act".

Both guards are proven by mutation: deleting the sum check in `burstFitCount` fails
`agent-message-hold.test.ts`, and measuring the body instead of the envelope fails
`agent-message-spill.test.ts`.

## Risks

- **Every inter-task report over roughly 650 bytes of body is now a two-step read.** Deliberate,
  and Arseny's explicit ruling when offered 1 250 or 1 500: those protect nothing, because 1 023
  bytes already carries the full failure rate.
- A burst of many short messages becomes several turns instead of one, each with its own Enter —
  slower for the receiver, and the "one burst, one Enter" invariant now means "one *read*, one
  Enter".
- 1 022 is a macOS measurement; Linux ptys buffer 4 KiB, so there we spill earlier than needed.
- The cap cannot see a human typing in the same window, nor another program writing to the pane.

## Alternatives considered

- **Keep the receipt and just lower its threshold** (the previous plan, PR #1634 as first pushed).
  Detection only: 38% of long messages still arrive beheaded and the receiver must notice.
- **1 250 or 1 500 bytes.** Asked for explicitly; refused with the measurement, then ruled on.
  Anything above 1 022 is two reads, so the number is a cliff, not a dial.
- **Bracketed paste through a tmux buffer** (PR #1636, @mcaldas — `paste-buffer -d -p`). Makes one
  message one attachment, which is elegant, but the object being dropped IS the attachment, and
  the evidence is n = 1 against a 38% failure rate. Seq 1786 is running 4 arms × 30 with ground
  truth from the session JSONL; if bracketed paste proves lossless, this threshold can go back up
  by one constant and that PR carries the text. Orthogonal, not a rival.
- **Shrink our own header** to leave more body inside 1 022 bytes. Real (+30% of usable body),
  offered, and deferred by the coordinator.
