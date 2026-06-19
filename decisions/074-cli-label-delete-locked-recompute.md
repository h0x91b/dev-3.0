# 074 — CLI `label.delete` recomputes labelIds inside the per-task lock

## Context
The CLI socket `label.delete` handler (`src/bun/cli-socket-server.ts`) removed a
deleted label from every task by filtering `task.labelIds` from a snapshot loaded
via `data.loadTasks()` *outside* the lock, then writing it back with
`data.updateTask()`. Any concurrent `labelIds` mutation landing between the load
and the write (e.g. `task.setLabels` from the UI) was silently clobbered —
a classic lost update. The RPC twin `deleteLabel` in
`src/bun/rpc-handlers/notes-labels.ts` already does it correctly; the two had
drifted.

## Decision
The handler now removes the label per task via `data.updateTaskWith(project,
task.id, currentTask => ...)`, recomputing `labelIds` from `currentTask` *inside*
the file lock — mirroring the RPC handler. `loadTasks()` is still used only to
pick which tasks are affected; the authoritative filter happens under the lock.

We deliberately did **not** delegate to the shared `deleteLabel`: it is not
exported standalone, lacks the CLI's short-prefix resolution and
`{ deleted: id }` response shape, and importing it would drag the electrobun
chain into the CLI test setup. The surgical mirror keeps the CLI protocol
byte-identical (method, params, response) and the on-disk format unchanged, so
downgrades stay safe.

## Risks
Low. No format/protocol change. The extra `updateTaskWith` mutator runs the same
filter as before, just on fresh state.

## Alternatives considered
- **Delegate to shared `deleteLabel`** — kills duplication but changes response
  shape / prefix behavior and complicates tests; rejected.
- **`task.setLabels` unknown-ID passthrough** (same file, line ~446) still
  persists unresolved IDs ("validation is caller's job"). Left as-is on purpose:
  tightening it could reject valid full-UUID writes for labels not yet in the
  loaded project snapshot. Noted here, not changed.
