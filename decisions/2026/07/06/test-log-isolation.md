# 108 — Isolate unit-test logging from the real ~/.dev3.0/logs

## Context

`src/bun/logger.ts` unconditionally wrote daily logs to `${DEV3_HOME}/logs`.
Any vitest worker that imported a module calling `createLogger` (updater.ts,
data.ts, git.ts, …) *without* a per-file `vi.mock("../logger")` therefore
appended its synthetic INFO/WARN/ERROR lines to the **real user log**. During a
live incident these fake `[NNNN:updater] applyUpdate … aborting` errors and
`bbbb2222` update hashes (from `updater.test.ts` fixtures) were mistaken for a
broken production updater and cost real investigation time.

## Decision

`resolveLogDir(env)` (pure, testable — mirrors the existing `resolveLogLevel`)
now picks the log directory, first match wins: (1) explicit `DEV3_LOG_DIR`
override, (2) under a test runner (`VITEST` / `NODE_ENV=test`) → an isolated
`${os.tmpdir()}/dev3-test-logs`, (3) otherwise the real `${DEV3_HOME}/logs`.
`getLogDir()` in `src/bun/logger.ts` calls it. This fixes every current and
future bun/cli test at once with no per-file logger mock. The write path is
unchanged (appendFileSync still runs, just against tmp), so the existing
`logger.test.ts` fs-mocked assertions keep passing.

## Risks

If the real app is ever launched with `NODE_ENV=test` its logs would misroute to
tmp — but nothing in the app sets that; only vitest does. `VITEST` is the
primary signal. Real subprocesses spawned by tests that run compiled code
without inheriting `VITEST` would still write to the real dir, but no current
test does this (verified: a full `bun run test:full` appended zero test-worker
lines — only the concurrently-running live app kept logging).

## Alternatives considered

- **Global vitest setup mocking `../logger`** — the CLI config has no
  `setupFiles`, and mocks don't cover spawned child processes.
- **Per-file `vi.mock("../logger")`** — must touch dozens of files and is easy
  to forget in new tests; this bug was exactly that omission.
