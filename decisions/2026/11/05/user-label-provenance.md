# User-set labels survive an agent's `label set`

## Context
Labels a user added to a To Do task vanished as soon as the task started. The launched agent's session-start checklist told it to attach labels with `dev3 label set`, which replaces the task's whole label set, so every compliant agent silently wiped the user's pick.

## Investigation
Reproduced on the scoped QA board: a launch with a no-op agent kept the label (so no stale write-back in the launch path), while a real Sonnet launch ran `dev3 label set <its-id>` and replaced the user's label within 15 s. Every backend label write is already a locked patch (`updateTaskWith`); the cause was the verb, not a race.

## Decision
The protocol body (`src/shared/agent-skill-content.ts`) now teaches `dev3 label add`. Independently, `Task.userLabelIds` records which labels came through the GUI door: `changeTaskLabels` in `src/bun/board-operations/labels.ts` takes a `BoardActor`, and an agent's replace (`set`, `set --clear`) keeps every user-owned label. Only `label remove <id>` naming a label drops it; a user edit owns what it adds and disowns what it drops (`labelPatch`, also used by `editTask`). A task written before the field existed treats all its labels as the user's. The CLI prints which labels it kept.

## Risks
A label an agent set on a pre-existing task now counts as the user's until removed explicitly. An older app version rewriting tasks.json may drop `userLabelIds`; that only falls back to the legacy rule above.

## Alternatives considered
Protocol text alone: agents in already-running sessions and habits elsewhere would still wipe labels. Making CLI `label set` always merge: breaks the documented contract and stops an agent from correcting its own wrong label with `set`.
