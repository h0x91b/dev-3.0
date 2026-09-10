# Coordinator prompt names the outcome, the size and the stopping point

## Context

`COORDINATOR_PROMPT` (`src/shared/types.ts`) described the role purely as traffic
control: create, brief, sequence, unblock, resolve overlaps, verify. Nothing in its
6 186 characters mentioned the goal of a task, how large a change should be, or when
to stop. The running coordinator (Seq 1801) behaved accordingly — it accumulated
bundled work across children, repeated evidence and wording corrections, and expanded
QA past the point where acceptance was met.

## Investigation

No project or global override existed (`coordinatorPrompt` unset in `settings.json`
and in every project), so the built-in text was what shipped and what ran. Four gaps
were traced to exact clauses: the role bullet named only management; the
`THE BRIEF IS YOURS ALONE` checklist had five required fields and none about the size
or shape of the result; `A CHILD'S DONE IS A CLAIM` had a verification bar but no
stopping condition; and no clause anywhere told the coordinator when *not* to step in.

## Decision

Four instructions added to `COORDINATOR_PROMPT`: a goal-and-stop paragraph directly
under the role sentence, `Leave routine engineering to the child; intervene only for
blockers, unmet requirements, material risks or scope growth` on the role bullet,
`SIZE IT TO ONE SMALL, INDEPENDENTLY REVIEWABLE OUTCOME` inside the brief checklist,
and `Verify agreed acceptance checks, then stop.` in place of the open-ended
`Read reports for honesty` sentence — the artefact/merge/CI evidence requirement
before it is untouched.

They are paid for by condensing existing prose, because this preamble rides on the
task description and therefore on the agent's command line: 6 186 → 6 185 characters,
so `src/bun/__tests__/agent-command-line-budget.test.ts` keeps the launch room a
coordinator task had, and the cap is not raised. The prose given up: the notes/overview
bullet (the injected dev3 protocol says the same at length), the
`EVENTS AND THE BOARD ARE COMPLEMENTARY` bullet, and wording in four other bullets.

Two constraints shaped the final text. `it belongs in your thinking` had to stay —
`decisions/2026/08/30/coordinator-prompt-reasoning-extraction-refusal.md` pins that
phrasing against Anthropic's `[reasoning_extraction]` refusal — and the variant
addressing sentence in `NAME EVERY TASK BY ITS NUMBER` was kept on the coordinator's
own call, so the budget was found elsewhere. Event freshness, variant independence,
the permissions rules, evidence honesty and the no-source-reading boundary are
unchanged.

## Risks

The events section lost its "complementary to the board" bullet, so the framing now
lives only in the section's opening line; the invariant it also carried — never name
the event kinds in the prompt — is now guarded by the surviving negative assertion in
`src/bun/__tests__/preset-prompt.test.ts`. Headroom against the budget guard is one
character, so the next addition to this prompt must again be paid for by a cut.
Whether the new wording actually changes coordinator behaviour cannot be measured by
a test; it is a judgement.

## Alternatives considered

Adding the four instructions without cuts: rejected, it breaks the command-line budget
guard by ~500 characters and the cap must not be raised — past it, Windows
`CreateProcess` refuses the launch with no usable error. Writing a new "how to
coordinate" section: rejected as another checklist on a prompt whose problem was that
its existing checklists never named a goal.
