# 165 — Persist terminal backend identity on the task record (MIG-003)

## Context

Decision 164 froze the value semantics of a future "which terminal backend runs
this session" field in a pure codec with no persistence. The tmux-removal
roadmap (seq 1141) now needs an explicitly selected backend to survive a
restart, without ever rewriting the millions of legacy records under
`~/.dev3.0` that predate the field.

## Decision

- `Task.terminalBackend?: TerminalBackendIdentity` (`src/shared/types.ts`) —
  optional, additive, and never mandatory. It describes the task's **primary**
  terminal only.
- `readTaskTerminalBackend(task)` / `setTaskTerminalBackend(project, taskId,
  backend)` in `src/bun/data.ts` are the whole API. Reads go through
  `decodeTerminalBackend`, so a missing field means effective `tmux` with
  `present: false` and an unrecognized stored value returns a typed failure
  instead of a guess. `setTaskTerminalBackend` is the only writer, rejects
  unknown identities, and skips the write when the value already matches.
- `rawLoadTasks` deliberately does **not** list the field in its backfill loop:
  no load-time stamping, so pure reads and unrelated writes leave a legacy
  record byte-shape identical until something else edits it.
- The codec tests moved to `src/bun/__tests__/terminal-backend-identity-codec.test.ts`
  so the existing bun shard discovers them — the same placement `duration.ts`
  and other shared modules already use. No new vitest config or CI shard.

## Risks

- Nothing selects a backend yet: the field only ever appears after an explicit
  `setTaskTerminalBackend` call, which no production path makes today. That is
  intentional — product selection lands with its own task.
- An older build that rebuilds a task record from a fixed field list would drop
  the field; the record then degrades to effective `tmux`, never to `native`
  (covered by an old/new/old test).

## Intentional boundary

Only the **primary task terminal** is covered. Project terminals, dev-server
terminals, and every other terminal kind stay legacy tmux with no persisted
identity until their own integration tasks — a single global field would
misrepresent a task whose panes run different backends.

## Alternatives considered

- **Backfill `terminalBackend: "tmux"` on load** — rejected: rewrites untouched
  on-disk records and breaks the `~/.dev3.0` no-silent-rewrite rule.
- **A `vitest.config.shared.ts` + a fourth CI shard** — rejected: `build.yml`
  enumerates the three configs explicitly, so a new shard means editing CI for
  one test file while parallel roadmap tasks are in flight. Existing precedent
  already tests shared modules from the bun/mainview shards.
- **One backend field per project instead of per task** — rejected: migration is
  per-task, and a project-wide switch cannot express a partially migrated board.
