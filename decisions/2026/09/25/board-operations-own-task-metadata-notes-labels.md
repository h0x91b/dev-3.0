# Board operations own task metadata, notes and labels

## Context

Every task-metadata, note and label mutation existed twice: once in the GUI RPC handlers
(`rpc-handlers/notes-labels.ts`, `rpc-handlers/task-lifecycle.ts`) and once in the CLI socket
(`cli-socket-server.ts`, four "Mirrors the RPC … handler" comments). The copies had drifted: GUI
note and label edits pushed nothing, so other windows, browser clients and peer instances stayed
stale; the GUI persisted unknown label ids the CLI refused; the CLI checked the user-edited-title
guard on a pre-lock snapshot; and who made a change was inferred from which door it came through.

## Decision

`src/bun/board-operations/` owns the rules per aggregate — `task-metadata.ts`
(`updateTaskMetadata`, `planTitleAndDescription`, `isScratchPlaceholderDescription`),
`task-notes.ts`, `labels.ts`. Each operation evaluates its rules on state read inside the file
lock, returns a verdict (`applied | noop | guardRejected`), and pushes at most one event per
aggregate it changed, only when applied (`deleteLabel`: one `projectUpdated`, none per task —
the renderer drops ids naming no label). Side effects go through `BoardPorts`; production
`runtime.ts` resolves `getPushMessage()` at call time, which already fans out to every client
and peer instance. The actor is fixed by the door (RPC `user`, CLI `agent`), never read from
params; a note's `source` is only a note attribute. RPC and CLI handlers are adapters: parsing,
prefix/`seq:` resolution, error wording, response shape. `editTask` shares the title/description
planner and keeps only its draft/todo guards and draft-only fields. `updateProjectWith` now skips
the save on an empty patch, like `updateTaskWith` (2026-08-16 no-op record).

Deliberate behaviour changes: GUI pushes (notes, task labels, label CRUD); introduced unknown
label ids refused on every door; same-value writes are no-ops (no save, no `updatedAt` bump);
clearing a custom title recomputes the auto title on every door; `labelIds` order counts
(chips render in that order).

## Risks

- A stale window that sends a just-deleted label as a new one now gets an error toast.
- Label delete vs a concurrent `changeTaskLabels` can still leave one dangling id: validation
  reads `projects.json`, the write locks the tasks file. Not fixed; needs a cross-file lock.
- The completion-policy flip still writes lifecycle-owned `mergeCompletionPrompt` and clears the
  merge reservation outside the lifecycle mailbox — borrowed, as both doors did before.
- Pushes fire after the lock, so two concurrent applied ops may deliver out of order.

## Alternatives considered

- **A class/service object with injected dependencies** — same seam, more ceremony; plain
  functions over `ports` keep call sites one line.
- **Leaving `editTask` title/description outside** — rejected: two owners of the title rule is
  the drift this removes.
- **Deriving the actor from `--source`** — rejected: a self-declared field must not become a
  policy input once a remote principal exists.

Tests: `src/bun/__tests__/board-operations-{notes,labels,metadata,parity}.test.ts` on a real
temp board with no data or socket mocks.
