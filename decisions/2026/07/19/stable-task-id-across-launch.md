# 139 — Stable task id across variant launch (transform source in place)

## Context

`dev3 task create` printed a task id that stopped resolving minutes later: launching the todo task (Launch Variants modal or a scheduled launch — both funnel into `spawnVariants`) deleted the source task and re-created N variants via `data.addTask`, each with a fresh `crypto.randomUUID()`. Seq was carried over; the id was not. Every stored reference (agent scripts, notes, vents, linked tasks) dangled, and agents had no signal that seq was the stable handle. Reported repeatedly via vents (2026-06-23 ×2, 2026-07-12).

## Investigation

Confirmed by code reading: `spawnVariants` in `src/bun/rpc-handlers/task-lifecycle.ts` (`data.addTask` per variant + `data.deleteTask(project, params.taskId)`). `addAttempts` never had the bug (keeps the source), nor did drag-to-in-progress (`moveTask` → `activateTask` updates in place) — only the variant-launch path re-keyed.

## Decision

1. `spawnVariants` now transforms the source task **in place** into variant #1 via `data.updateTaskWith` (status, groupId, variantIndex 1, agent/config/account, preparing fields; clears `worktreePath`/`branchName`/`scheduledLaunch`/`preparationError`). The mutator re-checks `status === "todo"` under the file lock, so concurrent launches cannot double-transform. Only variants 2..N are created as new tasks (they still copy labels/notes/overview/priority/title, since each variant's agent reads its own task). `deleteTask` call removed; `fireScheduledLaunch` no longer pushes `taskRemoved` (message type + renderer listener deleted — it was the sole emitter).
2. Safety nets in the CLI socket server (`src/bun/cli-socket-server.ts`): `--task seq:<N>` resolves by the stable seq (`findTaskByRef`; ambiguous within a variant group or across projects → explicit error), and `taskNotFoundError` explains the historic re-keying and points at `dev3 tasks list` / `seq:<N>`.

## Risks

- The transformed task keeps its original `baseBranch` instead of re-deriving from the current project default — matches the drag-to-active path; differs from old behavior only if the project's default base branch changed after the task was created.
- Its worktree/branch are now named after the *original* id (`dev3/task-<short>`); a stale worktree at that path (task launched, moved back to todo, relaunched) fails preparation once, and the standard revert-to-todo cleanup removes it — same self-healing as the existing reopen path.
- History is preserved instead of regenerated per launch (previously each launch reset it); considered an improvement, not a regression.

## Alternatives considered

- Reuse the source id for the first `addTask` after deleting the source: leaves a crash window where the task vanishes entirely (a prior vent documented exactly that ghost-task failure), and loses createdAt/history. Rejected.
- Only CLI-side fixes (seq resolution + error hint) without stable ids: leaves ids semantically broken as permanent handles. Shipped as safety nets alongside the real fix, not instead of it.
