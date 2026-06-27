# 082 — Verify task-create persistence before reporting success

## Context
Agent vents reported that `dev3 task create` printed `Created task <id> (seq N)` and exited 0,
but the task never appeared in `dev3 tasks list` / `dev3 task show` — the seq was consumed yet
the task was lost. An agent trusts that success line and tells the user "task created" when it
wasn't.

## Investigation
The single-instance data layer is sound: `addTask` reads fresh under a cross-process
`mkdir` file lock (`file-lock.ts`), writes via `atomicWriteFile` (temp + `rename`), and
invalidates the read cache. No public `saveTasks(fullArray)` caller exists outside `data.ts`,
so there is no stale read-modify-write clobber within one process. The read cache is
stat-validated and adds always grow file size, so a stale cache cannot hide a freshly added
task. The reproducible permanent-loss paths are out of scope here: multiple app instances
clobbering the shared file (`wontfix` — niche dev-only setup) and macOS Full Disk Access loss
mid-write (separate FDA issue). What we *can* fix is the dishonest success.

## Decision
`addTask` (`src/bun/data.ts`) now re-reads the tasks file fresh (`rawLoadTasks(..., { strict:
true })`, bypassing the cache) after the save and throws if the new task id is absent. The error
names the likely causes (FDA / multi-instance clobber) and the file path. Because the RPC layer
turns a thrown handler error into `{ ok: false, error }`, the CLI now exits non-zero with a clear
message instead of printing a false "Created task". This also guarantees the "id is immediately
resolvable" contract: if create returns, the task is confirmed on disk.

## Risks
One extra fresh read per task creation (negligible — task creation is a rare, user/agent-driven
action and the file is small). The guard does not catch a *later* clobber by another instance
(that happens after `addTask` returns); it only guarantees the write landed at creation time.

## Alternatives considered
- Verify in the RPC handler `createTask` instead of the data layer — rejected: would only cover
  the create RPC path, not every `addTask` caller (UI, variants).
- Chase the multi-instance / FDA root cause — out of scope (wontfix / separate FDA track).
- Block/retry until queryable — unnecessary; the write is synchronous under the lock, so a
  single read-back is authoritative.
