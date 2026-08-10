# Spill oversized agent messages to a file

## Context

`dev3 message` accepted up to 10 000 characters, but a message well under that died with
`TmuxError: tmux if-shell failed (exit 1): command too long` — an error that names no limit,
so neither the sender nor the agent could tell how much text was actually sendable. The
message-length guard and the pane-input size guard both claimed far more headroom than tmux
has, and the size that really mattered was never checked anywhere.

## Investigation

Measured against tmux 3.6a on a live server. A whole tmux command line rides ONE
client↔server imsg frame of 16 KiB: 16 344 bytes are accepted, 16 345 answer
`command too long`. This binds `if-shell` and a bare `send-keys` alike, so it is not
something the guarded send introduced.

`send-keys -H` spends 3 bytes of hex per byte of text, which puts the real ceiling of a
single send at ~5 440 bytes of UTF-8. `PANE_INPUT_LIMITS.maxStageBytes` was 40 000, sized
against Linux's `MAX_ARG_STRLEN` of 131 072 — a real limit, just not the tighter one, so the
size guard never fired and every large message reached tmux only to be refused there.
`AGENT_MESSAGE_SPILL_THRESHOLD` (8 000) also counted characters rather than UTF-8 bytes, so
a Cyrillic body passed the check at twice its real size.

## Decision

`MAX_SCHEDULED_MESSAGE_LENGTH` is 80 000 characters, and anything past
`AGENT_MESSAGE_SPILL_THRESHOLD_BYTES` (4 000 UTF-8 bytes) is written to
`<taskDir>/messages/message-<stamp>.md` and replaced by a pointer to that file —
`spillOversizedAgentMessage` in `src/bun/agent-message-spill.ts`, the one seam every message
path now goes through (`sendMessageImmediately`, `scheduleMessage`, and the diff viewer's
`sendAgentMessageNow`, whose private copy of the spill was deleted). Cross-task messages keep
their `<dev3-ai-message>` envelope: the pointer is the body, so the receiving agent still sees
who wrote it and how to reply.

Scheduled messages spill at queue time rather than at delivery, because the queue lives in
`tasks.json` and 20 pending messages at the full length would put megabytes in there.

`PANE_INPUT_LIMITS.maxStageBytes` drops to 5 000 and `maxProgramBytes` to 8 000, both now
sized against tmux's frame; `pane-input-tmux.test.ts` asserts the worst-case guarded command
against the measured 16 344-byte ceiling, which is the check that was missing.

## Risks

The 16 KiB frame is measured, not documented, so a future tmux could move it — the assertion
is written against the measured number so a change fails loudly rather than at run time. A
message between 4 000 bytes and the old limit now arrives as a path instead of text, which
reads differently for an agent that expected prose; the pointer says why in one line.

## Alternatives considered

`load-buffer` + `paste-buffer` carries arbitrary size through tmux (200 KB verified) and would
have kept big messages as real text, but it still pastes 80 KB into an agent's input box.
Chunking a stage into several guarded sends was rejected outright: it breaks the seam's
one-stage-one-atomic-command invariant and opens a partial-delivery window between chunks.
