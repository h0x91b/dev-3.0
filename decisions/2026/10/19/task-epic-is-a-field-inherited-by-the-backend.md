# Task epic: a plain field, inherited by the backend from the creating task

## Context
A user runs several coordinators ("epics") in parallel and wants to filter the board to one. Children only got whatever labels the creating agent invented, and labels are per-project while epics span repos.

## Decision
`Task.epic?: string` (`src/shared/types/task.ts`) — one kebab-case name per task, normalized by `normalizeEpic` so the same epic typed two ways groups as one. Inheritance is done in `task.create` (`resolveNewTaskEpic` in `src/bun/cli-socket/task-resolution.ts`): the CLI sends `sourceTaskId` from the worktree context, the backend resolves it across projects and copies its epic, so no agent action or prompt compliance is involved. An explicit `--epic` wins and `--epic ""` opts out. Scratch peers and variant groups inherit through the same field. A coordinator sets its own epic via a line in `COORDINATOR_PROMPT`.

## Risks
- The field is additive in tasks.json (absent when unset, key dropped on clear), so older versions ignore it, per the on-disk rules in AGENTS.md.
- Setting an epic on a coordinator does not retro-tag children it already created; only tasks created afterwards inherit.
- The coordinator brief is at 6441 of its 6500-character cap; the next addition must cut prose.

## Alternatives considered
- Reusing project labels: rejected, they are per-project and cannot express one epic across repos.
- Having the coordinator pass `--epic` on every create: rejected, it depends on the agent remembering; inheritance is deterministic.
