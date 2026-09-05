# Coordinator prompt: five headed blocks, a brief template, and "done" as a claim

> Extended on 2026-09-05 by `decisions/2026/09/05/coordinator-reads-events-from-a-cursor.md`:
> a sixth block (EVENTS) was added, so the prompt is no longer five headings.

## Context

`COORDINATOR_PROMPT` (`src/shared/types.ts`) had grown to 17 ALL-CAPS rules in one flat
list, each added after a real incident. Three of them were one theme (relay fidelity),
two another (no code / sub-agent), and the only word on briefing children was "brief".
The prompt also referred to the user as he/him/his sixteen times.

## Decision

Same rules, regrouped under five headings a reader can hold: YOUR ROLE · REPORTING TO THE
USER · RELAYING BETWEEN THE USER AND THE CHILDREN · PERMISSIONS AND OWNERSHIP · THE BOARD
RIDES IN ON MESSAGES. Every phrase `src/bun/__tests__/preset-prompt.test.ts` pins is kept
verbatim. Two things were added because they are the levers a coordinator actually holds:
a brief template (goal, done-as-artefact, boundaries, how to report back, which permissions
the child lacks) and "a child's done is a claim — landed means the artefact was seen".
The two rules the dev3 skill body already states (completion, priority) collapsed to one
pointer line. The user is "the user" / "they"; a negative regex guards it.

Net length +164 characters: the regrouping saved ~700, the two additions cost ~900.

## Risks

Any edit here can trip the model's reasoning-extraction refusal
(`decisions/2026/08/30/coordinator-prompt-reasoning-extraction-refusal.md`). This version
was sent through `claude -p --model 'claude-opus-5[1m]'` and answered normally. Repeat that
check after every substantive edit; the test only catches the one known pairing.

## Alternatives considered

Keeping the flat list and only fixing pronouns — rejected: the list was the problem, not
one word in it. Moving the brief template into the dev3 skill body — rejected: the body
is 498 characters from the Windows command-line cap on Codex, and briefing is a
coordinator-only concern.
