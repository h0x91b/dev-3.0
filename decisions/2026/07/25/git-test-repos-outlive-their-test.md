# 168 — Git test repos outlive their test

## Context

`git-merge-detection`, `git-diff-recent` and `git-unicode-filenames` flaked under
concurrent load with a drifting failure count on identical code. The visible symptom
was always `Error: Test timed out in 5000ms`, which reads as "these tests are just
slow".

## Investigation

Reproduced under CPU pressure. The run also printed an unhandled error that named a
*different* test than the one that failed:

    Uncaught Exception: Error: spawn git ENOENT
    { spawnargs: ['-c','core.quotepath=false','merge-base','origin/main','HEAD'] }

`git.ts` coalesces fetches, so a git call can outlive the test that started it.
`cleanup()` then `rmSync`'d the repo in `afterEach`, and the still-running child
spawned into a cwd that no longer existed. `createSpawnMock` had no `error` handler, so
that spawn failure became an uncaught exception *and* left `exited` pending forever —
the next test awaiting it died on the suite timeout. Not slowness: a hang.

## Decision

In `src/bun/__tests__/git-test-helpers.ts`:

- `createSpawnMock` resolves `exited` with `1` on the child's `error` event, guards
  `stdout`/`stderr` being `null`, and closes (never errors) a stream that dies
  mid-read. A spawn hiccup now fails an assertion with a readable message.
- `cleanup()` retires the repo directory and removes every retired directory once on
  `process.once("exit")`, together with the worker's template repo, instead of racing
  in-flight subprocesses in `afterEach`.
- `GIT_CONFIG_ISOLATION` (`GIT_CONFIG_GLOBAL=/dev/null`, `GIT_CONFIG_SYSTEM=/dev/null`,
  `GIT_CONFIG_NOSYSTEM=1`, `GIT_TERMINAL_PROMPT=0`) applies to both the helper's own
  `git` calls and the spawns made by the code under test, so the machine's hooks,
  commit signing, templates and `init.defaultBranch` cannot change the fixtures.
- Removed the unused `setupCommonMocks()` — its nested `vi.mock` calls emitted hoisting
  warnings that vitest says will become an error.

## Risks

Temp repos now live until the worker exits, so a full bun run holds a few dozen small
directories in `$TMPDIR` instead of one. They are removed on exit; a hard `SIGKILL` of
the worker leaves them for the OS to reap, exactly as the template repo already did.

## Alternatives considered

- Raising `testTimeout` for the git suites: the awaited promise never settles, so any
  timeout only changes how long the suite waits before reporting the wrong thing.
- Awaiting `git.ts`'s in-flight map before cleanup: needs production code to expose its
  coalescing internals purely for tests, and still races anything not in that map.
