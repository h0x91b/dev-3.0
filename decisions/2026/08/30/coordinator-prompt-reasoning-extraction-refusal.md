# Coordinator prompt: never pair "reason in full there" with "send only the conclusion"

## Context

`COORDINATOR_PROMPT` (`src/shared/types.ts`) is delivered verbatim as a coordinator
task's first prompt. From 2026-08-25 (commit `ee5a0c94`, PR #1529) it contained the
sentence *"Weigh it there in full, out loud, then send the conclusion alone."* Every
coordinator task launched on Opus 5 (1M context) since then died on its first message
with `stop_reason: refusal` and `Details: [reasoning_extraction]`. Reported as
h0x91b/dev-3.0#1602.

## Investigation

Bisected the 6 025-character prompt against `claude -p --model 'claude-opus-5[1m]'`.
The paragraph alone refuses; its first two and last two sentences pass; that one
sentence refuses on its own; the full prompt with only that sentence deleted passes.
Two rewrites that keep the meaning but drop "out loud" — "Weigh it there in full, then
send the conclusion alone" and "Work it through there in full; the message you send
carries the conclusion alone" — both still refuse. The classifier reacts to the shape,
not the wording: *complete reasoning goes into the thinking channel, only the conclusion
goes to the user* is the structure of a chain-of-thought extraction attack.

## Decision

Delete the sentence. Sentences 2, 4 and 5 of the same paragraph already say it
("belongs in your thinking", "anything the user reads … is a finished statement, not
your working notes"), and each of those passes on its own. Guarded by a negative
assertion in `src/bun/__tests__/preset-prompt.test.ts`.

Talking about the thinking channel is fine. Pairing it with an instruction to send only
the conclusion is not — do not reintroduce that pairing in any wording.

## Risks

The classifier is not ours and can change; a future edit to this paragraph may trip it
again for a reason this record does not predict. The test only catches this exact
pairing, not every phrasing of it. Any substantive edit to `COORDINATOR_PROMPT` should
be sent through `claude -p` once before shipping.

## Alternatives considered

Rewording rather than deleting — tested twice, still refused. Moving the instruction to
another paragraph would carry the same shape and the same refusal. Telling users to pick
a different model treats a broken default as configuration.
