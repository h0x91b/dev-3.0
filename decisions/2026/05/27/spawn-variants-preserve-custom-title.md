# 055 — spawnVariants / addAttempts must preserve customTitle

## Context

Issue [#583](https://github.com/h0x91b/dev-3.0/issues/583) — reopen of [#564](https://github.com/h0x91b/dev-3.0/issues/564). User reported that even on v1.15.2 a custom title typed in the Create-Task modal still got overwritten as soon as the agent started running.

The earlier fix (decision [052](./052-preserve-user-edited-task-title.md)) protected only the agent-facing CLI path: the skill instructs agents to skip the rename and `task.update` refuses to overwrite `customTitle` without `--force`. Those guards were correct but did not cover the regression path.

## Investigation

The Create-Task modal flow is:

1. `createTaskWithBranch` (`src/mainview/components/CreateTaskModal.tsx:174`) calls `api.request.createTask({ description })`.
2. If the user typed a custom title, it calls `api.request.renameTask({ customTitle })`. At this point the task has `customTitle` set correctly.
3. On "Save and Run" the modal hands the task off to `LaunchVariantsModal`, which calls `api.request.spawnVariants` (`src/bun/rpc-handlers/task-lifecycle.ts:788`).
4. `spawnVariants` calls `data.addTask(project, sourceTask.description, ...)` for each variant and then deletes the original source task (line 841 pre-fix). The new tasks are seeded from `description` only — `customTitle` is not in the extras object passed to `addTask`, so the new task's `title` is recomputed via `titleFromDescription(description)` and `customTitle` is left null.

`addAttempts` (`src/bun/rpc-handlers/task-lifecycle.ts:876`) had the same shape and the same defect.

## Decision

Carry `customTitle` from the source task onto every new task created by `spawnVariants` and `addAttempts`.

1. Extended the `extras` parameter of `data.addTask` (`src/bun/data.ts`) with an optional `customTitle?: string | null` and forwarded it onto the new `Task`.
2. Passed `customTitle: sourceTask.customTitle` in both spawn paths (`src/bun/rpc-handlers/task-lifecycle.ts`).

Tests added in `src/bun/__tests__/rpc-handlers.test.ts` cover both call sites and assert `data.addTask` is invoked with the inherited `customTitle`.

## Risks

- `customTitle` is the only user-edited field carried across the source → variant boundary. `labelIds`, `overview`, `userOverview`, and `notes` are still reset on every variant. That matches the prior behaviour and is out of scope for #583, but it is the next logical follow-up if users report the same surprise for labels.
- The fix only takes effect for variants spawned *after* the build that contains it. Tasks already broken on disk still need a manual rename (or `dev3 task update --title ...` from the user side).

## Alternatives considered

- **Carry every user-edited field on the source task (labels, overviews, notes).** Larger blast radius, no user signal that this was wanted, and would have to make a call on per-variant divergence. Rejected — keep the change minimal and tied to the reported bug.
- **Have `spawnVariants` call `renameTask` after `addTask`.** Two writes per variant for a single inherited string, plus the second write would have to dodge the `task.update` guard. Rejected in favour of a single `addTask` call.
