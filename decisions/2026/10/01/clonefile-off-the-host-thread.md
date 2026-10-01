# clonefile(2) runs in a worker thread

## Context
Users with large clone paths (a monorepo `node_modules` or build tree) reported that creating a task froze the whole app until setup finished. `cow-clone.ts` called macOS `clonefile(2)` through synchronous Bun FFI on the host thread; one call clones a whole tree and runs as long as the tree has entries.

## Investigation
Disposable fixture, 60 000 files: the clone took ~560 ms and the host event loop was stopped ~540 ms of it. Scoped QA instance, 186 604 entries: one host HTTP request waited 4 519 ms and the app's own detector logged `Event loop stall detected {"stallMs":4356}`. After the change: same fixture, worst request 67 ms, no stall logged. `git worktree add` (spawned) and `cp -cR` were measured too and do not block the loop. `cp -cR` is ~17x slower than `clonefile`, so dropping FFI was rejected.

## Decision
`tryClonefile` posts `{ src, dst }` to `src/bun/workers/clonefile-worker.ts` (bundled to `dist/workers` by `scripts/build-cli.ts`, configured by `index.ts` and `headless-entry.ts` via `configureClonefileWorker`). The host resolves only on the worker's `exit`, never on its message, so the `cp -cR` fallback can never write into a destination the thread may still be cloning into; there is no timeout because a syscall cannot be interrupted. A missing worker bundle skips straight to `cp -cR`. Clone work across all preparing tasks shares `MAX_CONCURRENT_CLONES = 2` slots.

## Risks
A clone that hangs in the kernel holds its slot forever; before, it hung the whole app. The limit of 2 is a judgement, not a measurement. Windows and Linux paths are unchanged and were not exercised.

## Alternatives considered
Drop FFI for spawned `cp -cR` (non-blocking but ~17x slower). A helper subprocess running clonefile (no reliable bun executable path in the packaged app). A worker timeout with fallback (would race the still-running syscall).
