# Release task ports under the assignment lock

Supersedes part of
[`decisions/2026/07/04/port-alloc-file-lock.md`](../../07/04/port-alloc-file-lock.md),
which stated that only allocation is contended.

## Context

`allocatePorts()` has taken `withFileLock(ASSIGNMENTS_FILE, ...)` and re-read
`port-assignments.json` from disk inside the critical section since the
concurrent-allocation fix. `releasePorts()` did neither: it mutated the
in-memory cache and wrote the whole map back. Two app instances share
`~/.dev3.0` (installed app plus a dev build is a supported setup), so a release
in one instance could overwrite an allocation the other had just persisted — a
lost update. The erased task's ports then read as free and could be handed to a
second task, which is exactly the overlapping-`DEV3_PORT0` failure the allocate
side was hardened against.

## Decision

`releasePorts()` (`src/bun/port-pool.ts`) mirrors `allocatePorts()`: the whole
read-decide-write section runs inside `withFileLock(ASSIGNMENTS_FILE, ...)` with
a fresh `readFromDisk()` under the lock. The function is now `async`; its single
production caller, the `releasePorts` lifecycle effect in
`src/bun/lifecycle/executor.ts`, awaits it.

A `FileLockTimeoutError` is caught and logged rather than thrown. Release runs
inside teardown, whose effect policy is `continue`, so a rejection would only
produce a generic lifecycle warning while the task record disappears anyway.

The sync getters (`getPortAssignments()`, `getAllAssignments()`) deliberately
keep reading the in-memory cache. They sit on hot paths — every dev-server
start, every agent launch, every env build — and a stale read there costs at
worst one redundant allocation, which the locked allocate path then resolves
correctly.

## Risks

- **A timed-out release orphans its record.** Nothing else prunes
  `port-assignments.json`, so those ports leave the allocatable map for good.
  Bounded and cheap: at most `MAX_PORT_COUNT` (20) ports out of a 10000-port
  range per occurrence, nothing is held at the OS level, and the explicit
  `"Ports left assigned"` error line makes a growing file diagnosable.
- **Older installed builds do not take this lock on release.** Until every copy
  on the machine is updated, the race survives in the old copy. Inherent to any
  fix of a shared-file protocol; no on-disk format changed, so old and new
  builds read and write the same file.
- **Teardown now waits on a lock** (5s per attempt, 3 attempts, stale locks
  broken at 10s) where it previously never blocked. Contention here is a
  millisecond-scale map rewrite, except against an allocation walking a nearly
  exhausted range — where allocation is already failing.

## Alternatives considered

- **Prune orphaned taskIds at boot** (`rehydrateTaskLifecycles()` already loads
  every project and task). Rejected: the task list is a snapshot, so a peer
  instance creating a task and allocating between the snapshot and the prune
  would have its ports revoked — reintroducing the very lost update this record
  fixes, in a worse form.
- **Make the release effect `"abort"`** so a failed release stops teardown.
  Rejected: it trades a few leaked ports for a task stuck mid-teardown with a
  live worktree.
- **Move the sync getters onto disk reads too.** Rejected as unnecessary churn
  on hot paths for a stale read the locked allocate path already corrects.
