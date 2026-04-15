## Context

`src/bun/data.ts` stored projects, tasks, and preferences with `Bun.file(...).json()` and `Bun.write(...)`. While fixing `src/bun/rpc-handlers/notes-labels.ts` races, concurrent locked updates still reloaded stale project/task snapshots inside the same process.

## Investigation

`withFileLock` serialized the writes correctly, but a new regression test showed two sequential `updateProjectWith` and `updateTaskWith` calls both saw the original JSON state. Running the same flow outside Vitest confirmed the lock was not the problem; the bad behavior was tied to Bun-managed JSON file reads inside one process.

## Decision

`src/bun/data.ts` now reads and writes JSON state with `readFile` and `writeFile` from `node:fs/promises` instead of `Bun.file(...).json()` and `Bun.write(...)`. The new `updateProjectWith` and `updateTaskWith` helpers keep read-modify-write logic inside the lock, and `src/bun/__tests__/data-race.test.ts` covers concurrent project/task mutations.

## Risks

This depends on Node fs semantics staying consistent across Bun-supported platforms, but that is a safer contract than stale cached JSON reads. If Bun fixes or changes its file caching behavior later, these helpers still remain valid and easier to reason about.

## Alternatives considered

Keeping `Bun.file(...).json()` and only wrapping more handler code in locks was rejected because the stale-read problem survived even with correct lock scope. Adding retries or version checks on top of cached reads was rejected because it treats the symptom while leaving the underlying persistence layer untrustworthy.
