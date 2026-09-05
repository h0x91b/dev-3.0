# The coordinator reads events from a cursor, at the start of a turn

## Context

`dev3 events` shipped (Seq 1738) as a POSITION — a millisecond cursor, a cap that keeps the
oldest matches and reports the newer ones it dropped, and a footer that counts what a
window cut off. `COORDINATOR_PROMPT` never adopted it, so a coordinator's only source of
"what happened" stayed the `<dev3-board>` snapshot, which reports what IS and never what
changed while the coordinator was away.

## Decision

A sixth block in `COORDINATOR_PROMPT` (`src/shared/types.ts`): read `dev3 events --from
<saved cursor>` before composing any substantive status; bootstrap a bounded window openly
when there is no cursor and say what was cut off; drain every `Capped at --limit` page; open
the notes that matter with `dev3 note show <id> --task seq:<owner>`, since `note show`
defaults to the caller's own task; advance only the returned cursor and only after consuming
the results; treat a failed read as a failed read. It is pulled inside a turn that already
started — no timer, hook, wake-up or poll, which would make the coordinator chatter
(`src/shared/coordinator-board.ts`: board state is a passenger). The block names no event
kind of its own and points at `dev3 events --help` instead: v1 records notes only and Seq
1675 is adding movements, so any list written here would be false the day it lands.
Pinned by `src/bun/__tests__/preset-prompt.test.ts`.

The block is paid for out of the prompt, not out of the user: the events text costs ~1 700
characters and the rest of the prompt was condensed by as much, so `COORDINATOR_PROMPT` is
6 176 characters against 6 210 before. No rule was dropped to get there — the cuts are
rationale sentences, section headings and duplicated clauses.

`dev3 note show` applies to NOTE rows only. Seq 1675's movement kind lands with ids that are
not note ids, so the instruction names the row kind rather than assuming every event id can
be opened. The kinds themselves stay unnamed here.

## Risks

The preamble is prepended to a coordinator task's description, which travels on the command
line for every agent without a prompt file, so its length is launch capacity spent — and the
5 000-character reserve in `agent-command-line-budget.ts` is not enforced anywhere on input:
no validation or truncation exists on `--description`, and `task-lifecycle.ts` only measures
its length for telemetry. That is why raw length was not the target. Measured on win32 by
binary-searching the largest task description that still launches: gemini 26 536 → 26 561 and
the custom-agent adapter 26 525 → 26 550, both BETTER than before; claude's inline fallback,
codex, cursor `agent` and opencode were already past the ceiling with an empty description
(33 374–34 610) and still are, unchanged by this work. An earlier revision of this change
carried a real regression here (capacity down to 24 896) and was condensed until it did not.
The guard is `agent-command-line-budget.test.ts`, which asserts the pre-change capacity
directly on the serialized command line — raw length is only a proxy, because the launch
dialect escapes quotes and backticks. Any edit here can also trip the reasoning-extraction
refusal (`decisions/2026/08/30/coordinator-prompt-reasoning-extraction-refusal.md`); this
version was sent through `claude -p --model 'claude-opus-5[1m]'` and answered normally.

## Alternatives considered

A hook or scheduled wake-up that pushes events into the pane — rejected for the reason the
board block is a passenger: it would wake a coordinator to say nothing changed. Telling the
coordinator to fall back to `dev3 events --from 2h` when it loses its cursor — rejected: a
short relative window silently skips exactly the stretch the cursor was covering.
