# 194 — One ownership sweep per native pane state read, and why the `ps` probe is not batched

## Context

Reading a native task's pane state (`nativeTaskPanesState`) ran the ownership
sweep twice: `describeSession` → `NativeMultipaneCoordinator.recover()` classified
every pane, then `buildState` → `listPanes()` classified the identical pane set
again. Each classification forks two `ps` processes (host + shell start
signature), so a six-pane read cost 24 `ps` subprocesses. Phase profiling of that
read put 110–125 ms in the sweep, 0.1 ms in the file lock and 0.5 ms in record IO
and tree work — the read was entirely probe-bound.

## Investigation

Measured with `scripts/measure-native-pane-latency.ts`, which now counts real
`ps` invocations through a shim first on `PATH`. Six-pane read: 24 `ps` before,
12 after collapsing the duplicate. Wall clock on an idle machine: p50 209 → 107 ms.

The obvious next step — one batched `ps -p <csv> -o pid=,lstart=` per sweep
instead of 2N single-pid forks — was implemented, covered and then **dropped**,
because on macOS `ps` with a pid list is pathologically slow:

| Invocation | Cost |
|---|---|
| `ps -p <one pid> -o lstart=` | ~10 ms |
| `ps -p <pid>,<pid> -o pid=,lstart=` | ~120 ms |
| `ps -p <pid> -p <pid> -o pid=,lstart=` | ~120 ms |
| `ps -ax -o pid=,lstart=` | ~50 ms |

One batched call therefore cost more than twelve single-pid forks: measured
six-pane read p50 148 ms batched versus 107 ms unbatched, and 150 ms versus
26 ms for a single pane, where the batch is pure overhead.

## Decision

Keep exactly one sweep per read: `NativeMultipaneCoordinator.recoverPaneSet()`
(`src/bun/native-terminal-multipane/coordinator.ts`) returns the reconciled
controller **and** the `PaneSnapshot`s that same sweep proved;
`NativeTerminalBackend.readPaneSet()` exposes it and `native-task-panes`
`buildState()` consumes it. `recover()` is a thin wrapper, so reconciliation is
unchanged. No verdict is cached, stored on the coordinator, or reused across
calls — one call, one sweep.

Do **not** batch the POSIX probe into a single `ps` on macOS. The floor for a
POSIX pane-set sweep is 2 forks per pane.

## Risks

Snapshots and layout now come from one instant instead of two consecutive
passes. That closes a race rather than opening one: previously `listPanes` could
report a pane dead that `recover` had just accepted, while the tree still
contained it.

## Alternatives considered

- **Cache ownership verdicts** (per-read memo or TTL) — rejected outright: a
  stale "owned" keeps a dead pane in the layout, which is exactly what the sweep
  exists to prevent.
- **Batch the `ps` probe** — implemented, measured, dropped (above). If Linux
  `procps` turns out not to share the macOS penalty, a platform-conditional
  batch could be revisited; it would need its own measurement on Linux first.
- **`ps -ax` once per sweep** — cheaper than a pid list but still slower than
  single-pid forks at small pane counts, and it reads the whole process table to
  answer a question about 12 pids.
