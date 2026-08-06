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

Measured with `scripts/measure-native-pane-latency.ts`, real hosts, macOS. It
answers two different questions and they must not be mixed:

**Deterministic probe count (counting on).** A shim first on `PATH` tallies every
`ps` exec. Six-pane read: **24 `ps` processes before, 12 after** — two sweeps
versus one, two pids per pane. Per pane count, before → after: 1 pane 4 → 2,
2 panes 8 → 4, 4 panes 16 → 8. This number is load-independent and is the real
evidence. Its wall clock is **not** usable: the shim forks a `/bin/sh` per probe
and roughly doubles both arms (it read p50 209 → 107 ms, an inflated figure).

**True latency (`DEV3_PANE_LATENCY_COUNT_PROBES=0`).** No shim, base and fix
interleaved in one run, n=15 per point, machine load 3–6, two rounds:

| Six-pane state read | Before | After |
|---|---|---|
| p50 | 75.5 / 82.3 ms | **40.4 / 38.1 ms** |
| p95 | 140.2 / 128.4 ms | 60.3 / 83.3 ms |
| min | 64.8 / 65.2 ms | 31.0 / 32.3 ms |

One sweep is the floor, and it sits at ~38–40 ms p50 for six panes on macOS.

The obvious next step — one batched `ps -p <csv> -o pid=,lstart=` per sweep
instead of 2N single-pid forks — was implemented, covered and then **dropped**,
because on macOS `ps` with a pid list is pathologically slow:

| Invocation | Cost |
|---|---|
| `ps -p <one pid> -o lstart=` | ~10 ms |
| `ps -p <pid>,<pid> -o pid=,lstart=` | ~120 ms |
| `ps -p <pid> -p <pid> -o pid=,lstart=` | ~120 ms |
| `ps -ax -o pid=,lstart=` | ~50 ms |

One batched call therefore cost more than twelve single-pid forks. Measured in
the same counting-on round, so both figures carry the shim's inflation and only
their ratio matters: six-pane read p50 148.8 ms batched versus 107.2 ms
unbatched, and 150.4 versus 25.8 ms at a single pane, where the batch is pure
overhead. The probe count did drop to exactly 1 `ps` per sweep — the batch
worked, it was simply slower.

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
