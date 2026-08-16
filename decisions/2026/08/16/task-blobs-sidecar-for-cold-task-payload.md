# Cold per-task payload moves to a task-blobs sidecar

## Context

`~/.dev3.0/data/<slug>/tasks.json` reached 14 MB on base44 (501 tasks) and 9.7 MB
on dev-3.0 (1654 tasks). The whole file is parsed and rewritten on every task
mutation, so its size is a direct cost on the UI thread — the 2026-08-16 freeze
record already traces a UI stall back to it.

## Investigation

Measured per-field bytes across both real files. Two findings dominated base44's
14 MB:

| Contributor | Bytes | Share |
|---|---|---|
| `completedDiffStats.fileStats` | 5.49 MB | 39% |
| JSON indentation (`JSON.stringify(tasks, null, 2)`) | 3.48 MB | 25% |

`fileStats` is a per-file diff breakdown — 7056 entries (780 KB) on the worst
single task. It is **not declared** on the `CompletedDiffStats` interface; it
reaches disk through the object spread in `captureCompletedDiffStats`
(`src/bun/lifecycle/executor.ts`), because `git.getBranchDiffStats` returns it.

Nothing reads it, and nothing ever has:

- `git log --all -S 'completedDiffStats.fileStats' -- src` returns nothing.
- `ProductivityStatEvent` (`src/shared/types.ts`) carries only `files` /
  `insertions` / `deletions` — the stats dashboard cannot express a per-file
  breakdown.
- The only UI that shows per-file `+N −M` is `TaskDiffViewer`, which reads the
  live diff response, not the task.

## Decision

`src/bun/task-blobs.ts` owns a new sibling directory
`~/.dev3.0/data/<slug>/task-blobs/<taskId>.json` — the rule-5 additive
parallel-path pattern from `AGENTS.md`, same shape as `automations.json`.
`rawSaveTasks` (`src/bun/data.ts`) calls `splitTaskBlobs`, persists the sidecars,
then writes tasks.json compact.

Three properties make the split safe rather than merely smaller:

1. **Sidecar first, tasks.json second.** A crash between the two writes leaves
   the data in both places, never in neither.
2. **Nothing is deleted.** `fileStats` is archived, not dropped, so the split is
   reversible and a future per-file feature still has its history.
3. **Blob writes are proportional to what changed.** `splitTaskBlobs` reports
   `changed: false` when a task has nothing to archive, so most saves touch no
   sidecar at all. A save that appends a history entry writes exactly one small
   sidecar (~1.6 KB) instead of pushing that entry through a multi-megabyte
   rewrite.

Compaction is a separate, independent win: `JSON.parse` is indifferent to
whitespace, so a compact file is the same document to every reader.

`Task.history` (title/overview snapshots) moved into the same sidecar. It is
1.2 MB on dev-3.0 spread across 830 tasks — p90 is 9 entries, so a retention cap
would have recovered almost nothing (7.91 → 7.83 MB) and only the full split
pays. No renderer reads it; the two readers that exist —
`dev3 task show --history` via the `task.show` socket handler, and conversation
search in both its backend and CLI form — hydrate from the sidecar.

History is **unioned** on every blob write, never replaced. A task loaded after
the migration carries an empty in-memory history, so a replacing write would
erase the archive on the next unrelated save; and a downgraded version appends
its entries to tasks.json, which the union folds back in on the next save.
Entries are keyed on `at` + `changed` + `title` + `overview` and re-sorted by
`at`, so a late arrival lands chronologically.

Measured by running the real `updateTask` path against a copy of the live store:
base44's tasks.json went 14.59 → 5.00 MB on the migrating save (153 ms, 277
sidecars written), and each subsequent edit took ~23 ms. dev-3.0 goes 9.81 →
6.72 MB (−31%).

Separately, `Task.notes` stays in tasks.json but is now capped at the 50 most
recent (`MAX_TASK_NOTES_KEPT`, `appendTaskNote` in `src/shared/types.ts`),
applied at both insert sites. The cap recovers little today — notes are also
spread thin, median 1–2 per task — but it bounds a list that one long-running
agent could otherwise grow without limit (251 on one task already).

`atomicWriteFile` moved from `data.ts` to its own `src/bun/atomic-write.ts` so
`data.ts`, `automations-data.ts` and `task-blobs.ts` can share it without
importing each other.

## Risks

An older app version reading the new file sees `completedDiffStats` without
`fileStats` and an empty `history`. Verified against `v1.39.0`, `v1.42.0` and
`v1.45.0`: no unguarded `task.notes` / `task.history` access, no
`prStatusCache.<member>` access, and no reader of `fileStats` at all — so nothing
can throw. If an old build rewrites tasks.json it never touches `task-blobs/`,
and the archive survives.

The one visible cost of a rollback is that `dev3 task show --history` and the
history signal in conversation search go quiet on the old build until the user
upgrades. No entry is lost: the union write folds the rollback window's own
entries back in.

A partially written sidecar leaves an unparseable blob; `readTaskBlob` swallows
that and returns `null`, so a search or a `--history` read degrades to empty
rather than failing.

The notes cap deletes data by design. A task past 50 notes loses its oldest ones
the next time a note is added to it — notes are surfaced to future agents by
`dev3 conversations search`, so the agent skill now states the limit and tells
agents to consolidate rather than narrate.

## Alternatives considered

- **Delete `fileStats` outright.** Same size win, no sidecar machinery — rejected
  because the data is genuinely expensive to recompute (it needs the worktree,
  which is gone once the task completes).
- **Archive completed tasks into `tasks-archive.json`.** Bigger win, but an older
  version that rewrites tasks.json would permanently erase every completed task —
  a direct violation of the N-2 readability rule.
- **One file per task for the whole record.** Rewrites the entire data layer and
  turns a board load into ~1600 `open()` calls.
