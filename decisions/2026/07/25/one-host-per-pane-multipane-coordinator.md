# 169 — One registry-owned host per logical pane, not a multi-PTY daemon

## Context

Seq 1283 (LAY-003/004/005) needed a native multi-pane terminal session: N panes,
splits, directional focus, zoom, writer-owned resize, and restart recovery —
without tmux. The persistent native-session registry (seq 1214) already gives a
detached host that owns exactly one PTY, publishes a versioned record, and can be
rediscovered from disk by a fresh controller. The open question was whether to
generalize protocol v1 into a multi-PTY daemon or to compose N single-PTY hosts.

## Investigation

Protocol v1 hard-codes one PTY per connection: `hello`/`welcome` carry a single
`sessionId`, `status` returns one `paneId`/`shellPid`/`cols`/`rows`, and writer
ownership (`WriterOwnership`) arbitrates one PTY per host. Making it multiplexed
would mean a pane id on every frame, per-pane writer leases, per-pane ownership
evidence in one record, and a partial-failure story for "3 of 5 panes died" — all
inside the one component whose single-PTY crash/restart/reattach behavior is
already proved by four e2e suites. Composition needs none of that: pane teardown
is process teardown, ownership evidence stays per process, and a dead pane is
just a session that no longer classifies as `owned`.

## Decision

One logical pane === one registry session, named deterministically
`<coordinatorId>-<paneId>` (`paths.paneSessionId`). `NativeMultipaneCoordinator`
(`src/bun/native-terminal-multipane/coordinator.ts`) owns only the shared
`SplitTree` and the pane→session binding, persisted as a minimal versioned record
in a new additive namespace `~/.dev3.0/native-multipane/` — atomic tmp+rename
writes, removal guarded by a compare-and-swap on the record `epoch`. Host pid,
shell pid, endpoint, ownership evidence, and PTY size are never copied here; they
are read from each pane's own registry record. Protocol v1 is untouched.

Three layers stay deliberately distinct: pane membership and geometry are shared
(`SplitTree`, normalized by `focus-mapping.normalizeSharedLayout` so its
single-renderer `activePaneId`/`zoomedPaneId` never become shared state); focus
and zoom are client-local (`CoordinatorClientView` over
`shared/native-terminal-client-layout`); cols/rows belong to whichever client the
host made writer, and an observer attachment is refused with
`ObserverMutationError` instead of silently ignored.

## Risks

Six panes mean six host processes rather than one, so per-pane memory and boot
latency add up (measured well under the registry's 15s boot budget in the
harness). A coordinator record can also drift from reality if a pane host dies
while no controller is attached; `recover()` handles this by reconciling dead
panes out of the layout deterministically and returning `null` (plus dropping the
record) when none survive.

## Alternatives considered

- **Generalize protocol v1 to multi-PTY.** Rejected: re-litigates crash,
  restart, ownership, and backpressure semantics that are already proved, with no
  behavior the composition cannot deliver.
- **A supervisor process owning N PTYs.** Rejected: reintroduces the exact
  single-point-of-failure and attach/reattach complexity that killing tmux was
  meant to remove.
- **Store host/shell pids in the coordinator record.** Rejected: two sources of
  truth for liveness; the registry record is already authoritative and
  ownership-verified.
