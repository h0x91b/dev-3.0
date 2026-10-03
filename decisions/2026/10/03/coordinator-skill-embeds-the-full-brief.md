# /dev3-coordinator embeds the full brief; the coordinator owns outcomes and stays quiet

## Context

The `dev3-coordinator` skill used to carry no brief at all and relied on `--print-role` output, so
the skill alone was a pointer, and an agent whose command failed or whose CLI was old had nothing to
read. Separately, the built-in `COORDINATOR_PROMPT` told a coordinator to end every reply with the
whole board, to let "facts" travel child-to-child and to brief children on "which tasks work nearby".
On 2026-10-03 that produced cross-task noise (Seq 2070's ruling: a coordinator must unload tasks, not
defocus them) and a second ask: the coordinator is a manager that delegates and trusts, not an extra
reviewer of its children's diffs.

## Decision

- `COORDINATOR_SKILL_CONTENT` (`src/bun/agent-skills.ts`) interpolates `COORDINATOR_PROMPT` in full.
  One source remains: the file is regenerated from the constant on every launch, and
  `agent-skills.test.ts` asserts the exact embedding.
- `--print-role` now also returns `rolePromptSource` (`presetPromptSourceForTaskType` in
  `src/shared/types.ts`), printed as `Brief source:`. The skill's table says the printed brief wins
  whenever it is a project or Settings override, and forbids editing a custom brief to match.
- `COORDINATOR_PROMPT` gained an OUTCOME block (checkable criterion, only accepted results count,
  every check ends in a decision, no busywork polling, no invented work) and a messaging rule
  (message a child only to change or unblock its own work; status read-only from board, events,
  peek; never brief a child to report to a sibling; same-file overlap means rebase). "End every
  message with the board" became "no whole-board recap unless asked". NO CODE now names diffs,
  design review, bug hunts, finishing and micromanaging, and says needed review is a delegated task.
- Not copied from the source manifesto: its permission to reprioritise, publish, and keep idle
  executors busy. Priority, type, launch approval and publication stay the user's.

## Risks

- The prompt is at 6 187 characters against a 6 210 cap, and the Windows launch-room test passes with
  little margin. The next rule must again be paid for out of existing prose.
- A project override that copied the old built-in text (Project Settings "copy inherited") keeps the
  old rules. That is deliberate: an override is the user's to change.
- Existing coordinator descriptions hold the old preamble; switching their type strips only the
  current preamble text, the same limitation every earlier prompt edit had.

## Alternatives considered

- **Keep the pointer-only skill.** Rejected by the user: the skill must be complete on its own.
- **Copy the text into the skill by hand.** Drifts at the first edit; interpolation gives the same
  completeness with one source.
- **Install a per-project skill with the override baked in.** Skills are installed per agent, not
  per project, and a baked override would go stale when Settings change.
