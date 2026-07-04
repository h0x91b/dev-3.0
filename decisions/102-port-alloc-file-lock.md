# 102 — Serialize port allocation with a cross-process file lock

## Context

`allocatePorts()` (`src/bun/port-pool.ts`) is async and `await`s an OS-level
`isPortFree()` bind probe between reading the assigned-port snapshot and
persisting the result. dev3 creates task variants in parallel, so two callers
ran concurrently: each took the snapshot before either wrote, a port one just
probed as free read as free to the other, and both could pick it — handing two
tasks overlapping `DEV3_PORT0` values (dev-server bind clashes).

## Decision

Wrap the whole read-decide-write section of `allocatePorts()` in
`withFileLock(ASSIGNMENTS_FILE, ...)` — the same lock primitive the data layer
uses. Inside the lock we re-read the assignment map from disk (`readFromDisk()`)
so a peer's just-persisted picks (another variant, or a second app instance
sharing `~/.dev3.0`) are visible. `releasePorts()` and the sync getters keep
using the in-memory cache; only allocation is contended.

## Risks

The lock is held across the `isPortFree()` walk. In the normal case (a handful
of free ports) that's milliseconds; only near-exhaustion — where allocation is
already failing — could approach the 5s lock timeout. Acceptable.

## Alternatives considered

- **In-process async mutex only** — fixes the parallel-variant case but not two
  app instances writing `port-assignments.json`. `withFileLock` covers both and
  matches the established data-layer pattern.
- **Reserve ports in the shared set before awaiting** — narrower, but still
  leaves the cross-process write race and the stale-cache read.
