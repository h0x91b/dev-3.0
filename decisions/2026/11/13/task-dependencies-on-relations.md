# Task dependencies: `blocked-by` relations, with start-after as the same link

## Context

A board with an order (this before that, this after those three) had only `--start-after`: one prerequisite, an automatic start, and nothing on the card. A task now names the tasks it depends on. A dependency orders and warns; it never starts or refuses anything.

## Investigation

- `--start-after` stores `Task.launchAfter`: one prerequisite id and seq, `until`, an agent, the arming agent and a time. It is a launch trigger with a single target, so a list of dependencies does not fit in it, and other installed builds read it as it is.
- `Task.relations` (`TaskRelation[]`, kinds `blocked-by` and `relates-to`) has been on disk since the task-linking foundation: backfilled to `[]` on load, kept by board copies, and unused. Older builds keep the field through their `{ ...task, ...updates }` writes.

## Decision

- A dependency is a `{ type: "blocked-by", taskId }` entry in `Task.relations`. No new stored field. The seq and title are read from the board when shown, so nothing goes stale.
- One graph: `dependencyIds` in `src/shared/task-dependencies.ts` returns the `blocked-by` targets plus the `launchAfter` prerequisite. The card, `task show`, the start warning and the cycle check all read it. `launchAfterRefusal` in `src/bun/launch-after.ts` dropped its own cycle walk for the shared `dependencyWouldCycle`, so a loop that mixes both links is refused from either side.
- State (`summarizeDependencies`): a dependency is done once any variant of it completed, or once every variant is finished. A cancelled dependency therefore stops blocking, and `task show` still prints its status. A deleted dependency is ignored. `blocked` means at least one is open; `ready` means all are done.
- Writes go through `addDependencies` / `removeDependencies` in `src/bun/task-dependencies.ts` (`updateTaskWith`, under the tasks-file lock). The CLI is the only editor in the first cut: `task create|update --depends-on`, `task update --no-depends-on [refs]`. A seq shared by a variant group names its lowest variant.
- The card shows a read-only chip in the signals zone (`TaskCard.tsx`): "Blocked by #3, #5" in muted ink on any open task. Once every dependency is done the card shows nothing, like a card with no dependencies: a To Do card without the chip can be started. `tasks list` and `task show` still say `ready`. The start-after prerequisite keeps its own chip and is left out of the blocked list. `BoardHost` resolves the state once per board (`dependencyMap`).
- Starting a blocked task warns and proceeds: an inline note in the launch modal and in the agent launch approval dialog (`OpenDependenciesNote.tsx`), and a stderr warning from `dev3 task move` (`startedBlockedBy` on the answer).
- Moving a To Do task to another board drops its `blocked-by` relations, like its start-after condition.

## Risks

- A cancelled dependency reads as ready. Work that was cancelled because it failed must be re-linked by hand.
- Extra variants created at launch do not copy the source's dependencies; only variant 1 (the source task) keeps them.
- The cycle check reads the board before the write and is not inside the lock. Two concurrent opposite links could both pass. The result is two blocked cards and a visible loop in `task show`, not a stuck launch: start-after has its own claim.

## Alternatives considered

- Widening `launchAfter` to a list: older builds read one `taskId` and would start early or never. Rejected.
- A new `dependsOn` field with a stored seq: a second field beside the reserved `blocked-by` kind, and a seq that can go stale.
- Auto-start once every dependency is done: asked not to. `--start-after` stays the one way to start a task by itself.
- A "Ready" chip on the card once every dependency is done: built, then removed. It named no task, and an absent "Blocked by" chip already says the same with less on the card.
- A graph view and an in-app editor: left out of the first cut.
