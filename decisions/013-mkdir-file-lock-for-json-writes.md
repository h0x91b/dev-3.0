# 013 — mkdir-based file lock for JSON writes

## Context

Issue #142: worktrees randomly disappear. The data layer (`src/bun/data.ts`) stores all state in JSON files (`tasks.json`, `projects.json`). Every mutator does a read-modify-write cycle with no concurrency protection. When multiple processes (two dev3 windows, or agent CLI + UI) write simultaneously, the second writer overwrites the first's changes — losing tasks.

## Investigation

Identified 21 read-modify-write patterns across `data.ts` and `rpc-handlers.ts` with zero locking. Confirmed the race condition in tests: 10 concurrent `addTask` calls resulted in only 1 task surviving.

Evaluated four approaches: naive CAS (mtime check — gap between check and write), rename + CAS (reduces window but doesn't close it), flock() (not exposed by Bun), and mkdir-based lock (atomic on POSIX and NTFS).

## Decision

Implemented `src/bun/file-lock.ts` using `mkdir` as an atomic lock primitive. `withFileLock(filePath, fn)` creates `filePath.lock` directory before executing `fn`, removes it in `finally`. Features: exponential backoff with jitter (5-50ms), configurable timeout (default 5s), stale lock detection (default 10s threshold, auto-break via mtime check).

Refactored `data.ts` to have raw internal helpers (`rawLoadTasks`, `rawSaveTasks`, etc.) that don't lock, and public API functions that wrap the full read-modify-write in `withFileLock`. This avoids re-entrancy deadlocks.

## Risks

- If a process is killed mid-lock (`kill -9`), the lock directory persists. Stale detection (10s mtime threshold) handles this automatically.
- mkdir-based locks are advisory — a process that ignores the lock can still write. All code paths through the public API are protected; direct `Bun.write` calls would bypass it.
- Lock granularity is per-file: `tasks.json` and `projects.json` have independent locks. Operations spanning both files (e.g. `deleteLabel` in rpc-handlers.ts) acquire them sequentially — must always use the same order (projects → tasks) to avoid deadlock.

## Alternatives considered

- **flock()**: Would be ideal but Bun doesn't expose it. Would require FFI or a native module.
- **SQLite**: Would solve concurrency natively but requires migrating the entire data layer. Too large a change for a targeted fix.
- **In-process mutex only**: Would not protect against multi-process scenarios (two dev3 windows editing the same project).
