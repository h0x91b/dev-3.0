# Task dependencies: `blocked-by` relations, with start-after as the same link

## Context

A board with an order (this before that, this after those three) had only `--start-after`: one prerequisite, an automatic start, and nothing on the card. A task now names the tasks it depends on. A dependency orders and warns; it never starts or refuses anything.

## Investigation

- `--start-after` stores `Task.launchAfter`: one prerequisite id and seq, `until`, an agent, the arming agent and a time. It is a launch trigger with a single target, so a list of dependencies does not fit in it, and other installed builds read it as it is.
- `Task.relations` (`TaskRelation[]`, kinds `blocked-by` and `relates-to`) has been on disk since the task-linking foundation: backfilled to `[]` on load, kept by board copies, and unused. Older builds keep the field through their `{ ...task, ...updates }` writes.

## Decision

- A dependency is a `{ type: "blocked-by", taskId }` entry in `Task.relations`. No new stored field. The seq and title are read from the board when shown, so nothing goes stale.
- One graph: `dependencyIds` in `src/shared/task-dependencies.ts` returns the `blocked-by` targets plus the `launchAfter` prerequisite. The card, `task show`, the start warning and the cycle check all read it. `launchAfterRefusal` in `src/bun/launch-after.ts` dropped its own cycle walk for the shared `dependencyWouldCycle`, so a loop that mixes both links is refused from either side.
- State (`summarizeDependencies`): a dependency is `done` once any variant of it completed, `cancelled` once every variant finished without one completing, and `open` otherwise. A deleted dependency is ignored. `blocked` means at least one is open; `ready` means none is.
- A cancelled dependency stops blocking, because a dependency warns and never holds work back, but it is never reported as done: `task show` says "ready, but #N was cancelled", `tasks list` says "(ready, #N cancelled)", and the JSON carries `state: "cancelled"`. The card shows no chip for it. Start-after keeps its own rule for a cancelled prerequisite: nothing starts and the card says "Did not start".
- Writes go through `planDependencyChange` + `writeDependencyPlan` in `src/bun/task-dependencies.ts`. `task.update` checks the whole request before its first write: every dependency refusal and the start-after refusal (`launchAfterRefusal`). A refused update therefore changes nothing, not even its title. The removals and additions then land in one `updateTaskWith` under the tasks-file lock. The CLI is the only editor in the first cut: `task create|update --depends-on`, `task update --no-depends-on [refs]`. A seq shared by a variant group names its lowest variant.
- The card shows a read-only chip in the signals zone (`TaskCard.tsx`): "Blocked by #3, #5" in muted ink on any open task. Once every dependency is done the card shows nothing, like a card with no dependencies: a To Do card without the chip can be started. `tasks list` and `task show` still say `ready`. The start-after prerequisite keeps its own chip and is left out of the blocked list. `BoardHost` resolves the state once per board (`dependencyMap`). Resolving many tasks goes through `indexDependencies` (by id, by variant group, and who depends on whom), built once per board, so `tasks list` stays linear in the board size.
- Starting a blocked task warns and proceeds: an inline note in the launch modal and in the agent launch approval dialog (`OpenDependenciesNote.tsx`), and a stderr warning from `dev3 task move` (`startedBlockedBy` on the answer).
- Start-after does not wait for the other dependencies. `task create|update` warns on stderr when a To Do task has both a start-after condition and other dependencies. When an agent-armed condition fires, the approval dialog names the open ones. A person-armed condition starts directly, as before.
- Moving a To Do task to another board drops its own `blocked-by` relations, like its start-after condition. Links from tasks left on the old board stay on disk but no longer resolve there, so they are ignored.

## Risks

- A cancelled dependency no longer blocks. It is labelled cancelled everywhere it is listed, but work cancelled because it failed must still be re-linked by hand.
- The cycle walk follows exact task ids, not variant groups. A loop that closes only through another variant of a group is not refused.
- Extra variants created at launch do not copy the source's dependencies; only variant 1 (the source task) keeps them.
- The cycle check reads the board before the write and is not inside the lock. Two concurrent opposite links could both pass. The result is two blocked cards and a visible loop in `task show`, not a stuck launch: start-after has its own claim.

## Alternatives considered

- Widening `launchAfter` to a list: older builds read one `taskId` and would start early or never. Rejected.
- A new `dependsOn` field with a stored seq: a second field beside the reserved `blocked-by` kind, and a seq that can go stale.
- Auto-start once every dependency is done: asked not to. `--start-after` stays the one way to start a task by itself.
- A "Ready" chip on the card once every dependency is done: built, then removed. It named no task, and an absent "Blocked by" chip already says the same with less on the card.
- A graph view and an in-app editor: left out of the first cut.
