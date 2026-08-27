# One short root for every test unix socket

## Context

`configureTestIsolation` moves each test process's `TMPDIR` into a sandbox
(`test-isolation.ts`). On macOS that root is already ~82 bytes — the per-user
`/var/folders/…` temp dir costs ~48 before the worktree hash, suite and pid are
added. A unix socket path is capped by the kernel at `sun_path` = 104 bytes on
macOS (108 on Linux), so an ordinary fixture name under that root does not fit,
and the failure is a bare `EINVAL` on `listen` that reads like a broken fixture.

Four suites had independently discovered this and answered it four different
ways: a guard inside `testScopedPath` that threw over 100 bytes (leaving 2 bytes
of headroom, purely by luck), a hand-rolled `socketTempDir()` on `/tmp`, a bare
`mkdtempSync("/tmp/d3sw-")`, and — in `native-pane-owner-forward.test.ts` — no
answer at all: a 119-byte path under a comment claiming it was "short enough for
the 104-byte sun_path limit".

## Investigation

The 119-byte path binds fine on this machine: both Node 22 and Bun 1.3.14 accept
unix paths of 160 bytes, because libuv works around the struct limit, while
Python's stdlib (which enforces `sizeof(sun_path)` itself) refuses at 111. So
the suite that prompted this was green here, in a real dev3 worktree, on
`origin/main` — the mechanism is real but the runtimes currently paper over it.
That makes it worse, not better: the arithmetic is 15 bytes over a documented
kernel limit and nothing in the suite would say so on a runtime or platform that
enforces it.

## Decision

One socket root per run, short by construction: `deriveTestSocketRoot`
(`test-isolation.ts`) puts it at `/tmp/d3s/<hash8>/<suite>-<pid>` on POSIX —
independent of `$TMPDIR`'s depth — and inside the run root on Windows, which has
no such limit. It is exported as `DEV3_TEST_SOCKET_ROOT` and removed by
`cleanupTestIsolation`.

Tests get it through `testSocketPath(name)` / `testSocketRoot()`
(`test-scoped-path.ts`); `testSocketPath` keeps the per-test keying that stops a
timed-out zombie rebinding its successor's path, and asserts the result against
`MAX_UNIX_SOCKET_PATH_BYTES` (103). `testScopedPath` now refuses a `.sock` name
outright and points at the socket helper. Three guards in
`src/bun/__tests__/`: the length holds even with a 180-byte temp root, the helper's
path really binds, and `test-isolation-audit.test.ts` fails any test file that
builds a `.sock` path from `tmpdir()` or `DEV3_TEST_ROOT` (its file sweep also
now reaches nested `__tests__` dirs, which it previously missed).

## Risks

Socket files live outside the sandbox `TMPDIR`, so a run killed before its global
teardown leaves a directory under `/tmp/d3s/`. It is keyed by worktree hash,
suite and pid, so it can never collide with a live run, and the next full run of
that suite removes its own.

## Alternatives considered

Shortening the sandbox root itself saves ~13 bytes and stays luck-based on
`$TMPDIR`. Skipping the suites when the path does not fit means nobody runs them
locally, which this project does not do to its tests. Leaving each suite its own
workaround is what produced the 119-byte path in the first place.
