# 078 — Retry transient CLI socket connect failures

## Context

Users reported the `dev3` CLI intermittently claiming the desktop app is "not
running" (exit code 2 / `APP_NOT_RUNNING`) while the app was clearly alive
(issue #714, macOS Tahoe). Agents would then refuse to update task state or open
PRs via dev3 ("the dev3 desktop app is offline").

## Investigation

`sendRequest` in `src/cli/socket-client.ts` connected to the app's Unix-domain
socket and, on the **first** `ECONNREFUSED`/`ENOENT`, immediately rejected with
`APP_NOT_RUNNING` — no retry. A live app can momentarily fail to `accept()` when
its single event loop is busy and the socket's accept backlog briefly fills;
the kernel returns `ECONNREFUSED` even though the socket file exists and the app
is running. macOS's small default backlog makes this likely, and agent hooks
fire many `dev3` invocations in tight bursts (every prompt / tool use), so the
race triggers "too often". The socket file itself is stable for the app's
lifetime, so discovery (`discoverSocket`) is reliable — only the connect step
was fragile.

## Decision

There are two paths to `APP_NOT_RUNNING` in `main.ts`: discovery
(`resolveSocketPath()` returns `null` — no live socket) and connect
(`sendRequest` fails to connect). Both are now hardened:

- **Connect** (`src/cli/socket-client.ts`): `sendRequest` retries transient
  connect failures (`ECONNREFUSED`/`ENOENT`/`EAGAIN`, wrapped in
  `TransientConnectError`) up to 4 attempts with short increasing backoff
  (~75/150/225 ms) before throwing `APP_NOT_RUNNING`. Non-transient errors,
  socket timeouts, and real server responses (including error responses)
  propagate immediately. The last errno is attached as `connectCode`.
- **Discovery** (`src/cli/context.ts`): `resolveSocketPathWithRetry` re-probes a
  few times with backoff so a one-off empty `readdir`/`kill(pid,0)` doesn't
  declare the app offline.
- **Diagnostics**: `socketDiagnostics()` reports `HOME`, sockets dir, each
  socket's pid + liveness, and worktree-context detection. `exitAppNotRunning`
  prints it (plus the failing stage and last connect errno) only under
  `DEV3_DEBUG=1`, so a future report can prove the real cause — wrong `HOME`
  vs busy app vs stale socket — instead of guessing. `connectAttempts`/
  `retryDelayMs`/`attempts` are exposed for tests.

## Risks

- A genuinely-down app now costs ~450 ms extra before reporting `APP_NOT_RUNNING`
  — negligible and only on the failure path.
- Retrying does not mask a real bug because only connection-level errors retry;
  a server that responds (even with an error) is never retried.

## Alternatives considered

- Increase the server listen backlog — Bun.listen exposes no backlog option, and
  it would not cover the `ENOENT` (re)creation race or be unit-testable.
- Try multiple candidate sockets in `discoverSocketIn` — addresses a different
  (PID-reuse) edge case, not the reported burst/transient failure.
- A pre-flight health ping with retry in `main.ts` — adds a round-trip to every
  invocation for the same effect as retrying the actual request.
