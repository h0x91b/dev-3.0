# Coordinator prompt keeps variants isolated

## Context

Variants of one task exist to produce independent results the user can compare afterwards. Runtime isolation
already covers what a variant can read (`agent-skill-content.ts`: never read a sibling's transcript, the
conversation search excludes siblings). The remaining hole was social, not technical: the coordinator is the only
party that knows a variant group exists, and two of its own rules read as permission to talk across it — facts may
go child-to-child, and overlaps are resolved by briefing both sides.

## Decision

`COORDINATOR_PROMPT` (`src/shared/types.ts`) gained a `== VARIANTS ==` section: never tell a variant a sibling
exists or pass its identity, findings, hypotheses, progress, artefacts, transcript or recommendation; no invitation
to inspect or collaborate; child-to-child facts and overlap work are for independent tasks only; address one
variant privately by `--variant <i>` or its task id, never fan a summary into variant inboxes; compare results for
the user only, never back into a running variant, and relay the user's decisions and the original task's facts with
no sibling named as their source. The `FACTS MAY GO CHILD-TO-CHILD` line now carries the exclusion inline, because
that is the line a coordinator acts on. Guarded by `src/bun/__tests__/preset-prompt.test.ts`.

## Risks

The prompt is a preamble on the task DESCRIPTION, so it ships only to coordinator tasks created (or re-typed with
`dev3 task update --type coordinator`) after this change — already-running coordinators keep the text they launched
with. A user who overrode the prompt in Settings or per project never gets it at all; that is the existing
override contract, not a regression.

## Alternatives considered

A runtime mechanism (refusing `dev3 message` between members of a variant group) was out of scope and would also
break the legitimate case of addressing one variant directly. Putting the rule in the shared skill body was
rejected: every agent carries that body on its command line, and the rule only binds the coordinator role.

Budget note: adding ~700 characters to this preamble was paid for by condensing prose across the other sections,
the method Seq 1804 recorded in its notes — the guard in
`agent-command-line-budget.test.ts` measures the SERIALIZED Windows command line, not raw length, and it stayed
green (gemini max brief 26 551 vs the 26 536 the guard requires).
