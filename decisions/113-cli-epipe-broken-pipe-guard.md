# 113 — Tolerate a broken stdout pipe in the dev3 CLI (EPIPE guard)

## Context

Piping CLI output into a consumer that closes the read end early — `dev3 ui state | head`,
`| grep -m1`, quitting a pager mid-output — made the CLI print a raw
`EPIPE: broken pipe, write` stack trace and exit non-zero. Piping through head/grep is an
extremely common agent pattern, so the trace polluted otherwise-clean tool output and read
like a real failure. Reported twice (2026-07-04, 2026-07-05).

## Investigation

Bun throws a **synchronous** EPIPE from `process.stdout.write` once the read end is gone.
Because stdout is flushed on a later tick, the throw escapes the awaited handler chain and
lands in `process.on("uncaughtException")` — not in `main().catch` (verified: a heavy-write
loop piped to `head` surfaced via `uncaughtException`, not the promise rejection). A real
shell pipe always yields code `EPIPE`; Node's macOS socketpair-based `stdio: "pipe"` can
instead surface `ENOTCONN` under load, but that is a test-harness artifact, not the
production signal.

## Decision

Added `src/cli/epipe.ts`: `isEpipeError()` + `installEpipeGuard()`. The guard registers
`process.stdout`/`process.stderr` `'error'` listeners and an `uncaughtException` handler that
`process.exit(0)` on EPIPE; any other error is printed and exits with
`CLI_EXIT_CODE_INTERNAL_ERROR` (4). Rethrowing from the `uncaughtException` listener was
rejected: Bun then terminates with exit code 7, which collides with
`CLI_EXIT_CODE_DOCTOR_PROBLEMS` in the documented exit-code contract.
`src/cli/main.ts` installs it at the top of `main()` for every command **except** `remote`
and `gui` (long-running; they register their own log-and-continue crash handlers, which an
exiting listener would defeat), and `main().catch` also exits 0 on an EPIPE rejection.

The guard matches **only** `code === "EPIPE"`, deliberately not `ECONNRESET`/`ENOTCONN`:
those can also come from the app Unix-socket client, and swallowing them globally would mask
a genuine socket failure as success.

## Risks

- Exit 0 (not 141/SIGPIPE) on a broken pipe — chosen for clean agent tooling; the consumer
  asked us to stop, so success is correct.
- The `uncaughtException` handler is process-wide; scoped away from `remote`/`gui` to avoid
  clobbering the headless server's own handlers.

## Alternatives considered

- **Wrap every `process.stdout.write` call site** in a helper — rejected: invasive across all
  command files; the ask was an explicitly central fix.
- **Broaden the guard to the whole broken-pipe family** (ECONNRESET/ENOTCONN) — rejected: risks
  masking real app-socket errors. Kept strict to the production EPIPE signal.
