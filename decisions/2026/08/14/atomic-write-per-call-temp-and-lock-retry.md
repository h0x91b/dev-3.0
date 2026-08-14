# Per-call temp names for atomic writes, plus a bounded file-lock retry

## Context

Two vents reported the same shape of failure: a single write to task metadata broke a task-lifecycle
operation, and an immediate manual retry succeeded. One was an `ENOENT` on the atomic rename during a
status transition; the other was `FileLockTimeoutError` from `dev3 note add` after the 5s lock deadline,
during concurrent dev-server shutdown and checks.

## Investigation

`atomicWriteFile` (`src/bun/data.ts`) named its temp file `${filePath}.tmp-${process.pid}` — keyed on the
PROCESS, not the call. Two concurrent writes to one file inside one process therefore shared a temp path:
whoever renamed first won, the loser's `rename` hit `ENOENT`, and the loser's error-path `unlink` could
delete the winner's temp file mid-flight. Neither path had any retry. `withFileLock` threw
`FileLockTimeoutError` at the deadline and no caller caught it (`note.add` in `cli-socket-server.ts` lets it
reach the CLI). For `tasks.json` the race window was narrow — mutators hold the lock — but it was not closed
by construction, and unsynchronised `rawSaveTasks` paths exist.

## Decision

1. `atomicWriteFile` derives the temp name per CALL: `${filePath}.tmp-${pid}-${counter++}`. Concurrent
   in-process writes can no longer share a temp file or clobber each other's cleanup.
2. `atomicWriteFile` retries the write+rename pair 3 extra times (10/30/90 ms) on `ENOENT`, `EPERM`,
   `EACCES`, `EBUSY`, logging a warning per retry. Any other error surfaces immediately.
3. `withFileLock` (`src/bun/file-lock.ts`) retries a timed-out acquisition `retries` times (default 2), each
   attempt with the unchanged short deadline, warning per attempt; the final error names the attempt count.

Retrying was chosen over raising the 5s deadline: the per-attempt deadline stays short, each failed attempt
is visible in the log, and a genuinely stuck holder still fails without a long silent stall.

## Risks

A hard failure now takes up to 3× longer to surface (15s worst case for a lock, ~130 ms for a write). Callers
that deliberately used a short timeout to fail fast must pass `retries: 0`. Stale-lock breaking is unchanged,
so a crashed holder is still broken at 10s rather than waited out.

## Alternatives considered

- Raise `DEFAULT_TIMEOUT` to 15s: same total wait, but hides contention — no per-attempt signal, and a stuck
  lock stalls silently for the whole window.
- Catch `FileLockTimeoutError` at each call site (e.g. only `note.add`): ~40 call sites, and it fixes the
  symptom in one place while leaving every other metadata mutator exposed.
- Serialize all writes to a path through an in-process queue: closes the in-process race but not the
  cross-process one, and duplicates what the file lock already does.
