# 165 — The shared parity corpus must not import side-effecting modules

## Context

PR #1111 (seq 1254, native single-view adapter) added a `Native single-view
adapter parity E2E` step to the path-gated `Packaged Bun runtime` workflow. Every
check passed in ~18 seconds and printed `ALL CHECKS PASSED` — then the process
never exited, so the job burned its full `timeout-minutes: 20` and was reported
red on macOS, Ubuntu, and Windows alike. Auto-merge does not gate on that
workflow, so it merged red and had to be reverted (#1113) and reapplied here.

## Investigation

The first line of the CI log was the tell: `[pty] PTY WebSocket server running on
ws://localhost:40905`, printed *before* the E2E's own first line — i.e. at import
time. `src/bun/pty-server.ts` calls `Bun.serve({...})` at top level, and the
shared corpus `terminal-parity/checks.ts` imported exactly one pure helper from
it (`smallestClientSize`). That single import started a WebSocket server and
pinned the event loop forever. Secondarily, the native harness handed out
`reconnect()` controllers it never disposed, so an attach WebSocket opened by a
reconnect check stayed open too. CI also logged the symptom plainly:
`Terminate orphan process: pid (…) (bun)`.

## Decision

`smallestClientSize` moved to the pure `src/shared/resize-protocol.ts` (its unit
tests moved with it); `pty-server.ts` and `checks.ts` both import it from there,
so the corpus no longer reaches into a side-effecting module. The native harness
(`native-terminal-adapter/native-runner.ts`) tracks every handed-out `reconnect()`
adapter and disposes them all. The E2E ends with an explicit `process.exit(0/1)`
like its siblings, and its CI step gets `timeout-minutes: 5`. A guard in
`terminal-parity/__tests__/isolation.test.ts` fails if `checks.ts`, `corpus.ts`,
or `runner.ts` ever imports `pty-server` again.

Verified by running the E2E with the explicit exit REMOVED: it now terminates on
its own in 19s, which proves the leak is gone rather than masked by the exit.

## Risks

- The explicit `process.exit` can truncate pending async cleanup; the harness
  `dispose()` is awaited before `main()` resolves, so teardown is already done.
- A future side-effecting import into the corpus from a module other than
  `pty-server` would not be caught by the guard, only by a step timeout.

## Alternatives considered

- **Explicit `process.exit` alone** — rejected as the primary fix: it hides the
  leaked server and orphan processes instead of removing them.
- **Re-export `smallestClientSize` from `pty-server.ts`** — rejected: the import
  chain, and therefore the load-time server, would survive.
- **Lazy `Bun.serve` in `pty-server.ts`** — a real improvement, but it changes a
  production startup path for a test-only problem; out of scope here.
