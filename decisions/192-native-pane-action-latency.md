# 192 — Native pane actions answer through one state bus, and ownership probes are async

## Context

On a native-backend task, clicking Split or a layout preset looked inert for roughly
2–3 seconds. The suspicion was slow backend work. Measurement said otherwise.

## Investigation

`scripts/measure-native-pane-latency.ts` (real hosts, macOS, idle) put the backend at
20 ms for a 2-pane layout change and 130–230 ms for a split including the host spawn —
nowhere near the reported delay. Two separate causes explained the rest:

1. **Two unconnected copies of `TaskPaneState`.** `TaskPaneControls` (inspector) owned
   the buttons and wrote the action's authoritative response into its own `useState`.
   `TaskTerminal` draws the geometry and learned about the change only from its own
   2500 ms poll. Click-to-settled was therefore *real work + 0–2500 ms of waiting*, and
   there was no click-to-feedback at all: no busy state, no duplicate suppression.
2. **`ps` on the click path, synchronously.** `classifyOwnership` proves a recorded PID
   was not reused by reading `ps -p PID -o lstart=`, twice per pane. The probe used
   `spawnSync`, so `Promise.all` over a pane set could not overlap anything — it also
   blocked the whole Bun event loop. Profiling a 6-pane read: 121 ms total, of which
   ~64 ms was one classification pass and ~64 ms the second one; the coordinator file
   lock was 0.13 ms, i.e. not a factor.

## Decision

- `src/mainview/pane-state-bus.ts` is the single arrival point for a task's pane state.
  Reads and actions go through `fetchPaneState` / `runPaneAction`, and the **server's own
  response** is broadcast to every subscriber; polling stays purely as reconciliation.
  Each request takes a ticket, and a response older than one already delivered is
  dropped, so a slow poll cannot reinstate pre-action geometry. Nothing on this path
  computes a tree locally — `renderer_only_layout_state` stays forbidden.
- `TaskPaneControls` holds every mutating control (`disabled` + `aria-busy`) for the
  duration of one action, keyed off a ref so two clicks in one frame cannot both fire.
  Capability is kept separate from busy, so the "needs two panes" tooltip never fires
  for a control that is merely in flight. No speculative pane slot is drawn.
- `readProcessStartSignature` is async (`spawn`, not `spawnSync`), and
  `classifyOwnership` starts the host and shell probes together. `recover()` and
  `listPanes()` fan out over the pane set, bounded by the pane count.
- `nativePaneAction` reads the layout only (`nativeTaskPaneLayout`) instead of the full
  state: every action decides from the tree, so the per-pane ownership sweep the full
  state carries was a second `ps` pass nothing read. Recovery still runs, so dead-pane
  reconciliation is unchanged.

Measured after (6 panes, same harness): layout p50 60 → 44 ms, split p50 228 → 168 ms,
read p50 119 → 81 ms, single `ps` probe 4.9 → 0.5 ms.

## Risks

- The bus is `window`-scoped, so a state for the wrong task must be filtered by id; the
  ticket counter is per task and reset only in tests.
- Reading the layout instead of the full state means an action's decision no longer sees
  per-pane liveness. No action consulted it — `close` used the pane count, which the tree
  carries — but a future action that needs liveness must read the full state explicitly.
- Async `ps` raises the number of simultaneous forks to twice the pane count. Bounded by
  the pane set, and each fork is short-lived.
- `readState` p50 at 6 panes is 81 ms, still above the 50 ms target, because a read
  classifies the pane set twice: `describeSession` recovers (and reconciles), then
  `listPanes` snapshots. Collapsing them into one pass would touch dead-pane
  reconciliation, so it is deliberately left for its own change.

## Alternatives considered

- **Optimistic local geometry** on click: fastest to write, and exactly the
  client-invented layout the native pane surface forbids — two viewers of one task would
  disagree until the poll healed them.
- **A push message from the main process** instead of a renderer bus: the action already
  returns the authoritative state to the caller, so a push would be a second delivery of
  data the renderer holds, with its own ordering problem.
- **Caching ownership verdicts with a short TTL**: would have cut the probes without the
  async conversion, at the cost of a window where a dead pane still reads as alive.
- **A spinner or a placeholder pane for a split**: at 170 ms the geometry itself arrives
  before a spinner would earn its animation; the existing terminal attach state already
  covers the connection.
