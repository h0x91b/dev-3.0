# Separate the messages inside one burst

## Context

Issue #1608 reported that a long `dev3 message` arrives with its head missing. Seq 1760
measured the channel clean (67 transport sends, 8 real-agent deliveries) and shipped the
receipt in PR #1612, which makes a lost head *detectable* without claiming it cannot
happen. This task went looking for the case that actually reproduces.

Nothing reproduced a lost head. What did reproduce, on the first look at the current
coalescing path, is a different defect in the same subsystem: two messages that share one
turn arrive **welded**. `release()` types each body back to back and `wrapAgentMessage`
ends without a newline, so the receiver's turn contains
`</dev3-ai-message><dev3-ai-message>` on one line.

## Investigation

- Transcript-verified live against Claude Code 2.1.236 over tmux: the junction is
  literally `</message>\n</dev3-ai-message><dev3-ai-message>\n<from-task>…`.
- Independently confirmed from the board coordinator's own inbox, which is the heaviest
  consumer of this channel: every multi-part report it received that day arrived welded
  (2-part reports from two tasks, a 3-part report from a third). Welding is the *normal*
  shape of a multi-part report, not an edge case.
- Head loss, by contrast, did not reproduce on any axis: five receivers (codex 0.147.0,
  gemini 0.46.0, opencode 1.18.15, Claude Code 2.1.236 and 2.1.112) all took a 3 KB
  message whole, and bursts of 3 and 6 messages — idle and mid-turn — were byte-exact.
  Measurements are banked as notes on the originating task.

## Decision

`AGENT_MESSAGE_BURST_SEPARATOR` (`src/shared/agent-message-envelope.ts`) is a **blank
line**, and `release()` in `src/bun/agent-message-hold.ts` passes it to `deliver` for
every message except the one that opens the burst. Position in a burst is knowable in the
hold and nowhere else, so the hold hands the separator down rather than each adapter
guessing. Both adapters prepend it (`agent-prompt.ts`, `agent-prompt-native.ts`), and the
board-snapshot epilogue now uses the same constant instead of its own single newline.

A blank line rather than one newline: the tags already delimit for a parser, so what was
missing is a boundary a *reader* can see. A louder separator — a rule line, or a
`<burst>` wrapper around the group — was rejected because it would add a second framing
vocabulary next to the envelope that #1612's receipt and every agent's skill text already
describe.

Guarded by `src/bun/__tests__/agent-message-burst-separator.test.ts`, which asserts on the
BOUNDARY through `holdMessageForPane` — the entry a real `dev3 message` uses. Byte counts
are deliberately not the subject: a welded burst has exactly the right number of bytes.

## Risks

A literal newline inside a paste could in principle submit the turn early on some
harness, which would split the burst — the defect the hold exists to prevent. Measured
against a real Claude Code receiver before shipping: both envelopes arrived in ONE user
entry with the blank line intact, so the separator does not submit. The epilogue has been
prepending a newline the same way since it shipped, so this is not a new class of risk.

## Alternatives considered

- **One newline.** Restores the line structure but leaves two reports visually
  continuous, which is the complaint the coordinator actually has.
- **Lowering `AGENT_MESSAGE_SPILL_THRESHOLD_BYTES` from 4 000.** Rejected here as it was
  in #1612: it degrades a channel that measures clean, and it names no mechanism.
- **Leaving it to the receipt from #1612.** The receipt proves a *body* is complete; it
  says nothing about where one message stops and the next starts.
