# 199 — `dev3 peek`: read-only coordination glance, with declared freshness asymmetry

## Context

Coordination between tasks was push-only: a coordinator learned what a worker was doing only when the worker messaged it. A quiet worker left two bad options — interrupt it (costs the worker a turn) or wait blindly. Coordinators needed to answer "what was it last doing, is output still moving, is it waiting for input, which pane matters, how old is this observation" without touching the peer.

## Decision

`dev3 peek` (CLI → `task.peek` socket method → `src/bun/task-peek.ts`) returns a read-only snapshot: task header, one line per pane (command, alive/dead, `lastOutputAt`), and a bounded plain-text tail of one pane. The tail of a native pane comes from the seam's observational capture (`captureView`, decision 202) through `native-task-panes`; the tmux pane summary and tail come from the tmux client, because tmux needs one `list-panes` sweep for labels and liveness anyway. Default 120 lines, `--lines` up to 1000, `--pane` accepts the printed 1-based index or a raw backend pane id. Access is unrestricted across projects; terminal text is returned verbatim to the caller and never written to `~/.dev3.0/logs/`.

Three deliberate refusals: it does not classify state (no `working`/`waiting-approval` label, no pattern matching over agent output — prompt shapes change every agent release and a wrong label is worse than none); it does not invent freshness (`lastOutputAt: null` renders as `last output unknown`); and it treats "no terminal session" as a successful answer naming the reason (draft, hibernated, not running), because "is it even alive?" is the question being asked.

Anything missing is reported as a discriminated `unavailable` value with three kinds, never as prose: `no-session` (the task has no terminal), `read-failed` (a terminal may well be running — WE could not read it, and the rendered line says so outright), and `pane-not-found` (the session is fine, the named pane is not). Collapsing these into one "nothing to show" message is precisely the confusion the feature exists to remove, so a failed read must never read as a quiet worker.

## Risks

Freshness precision differs by backend and the payload says so via `granularity`:

- **native** — per pane, but only for the pane actually captured: it comes from that capture's `sourceUpdatedAt`. Timing every pane would cost one capture per pane, so the others report unknown instead of borrowing a clock.
- **tmux** — per **window**, from `#{window_activity}`. Verified against a live tmux 3.6a: `#{pane_last_activity}` and `#{pane_activity}` **do not exist**. A dev3 task normally keeps its panes in one window with dev-server work in another, so a chatty second pane in the same window can mask a stalled agent pane. The CLI prints `(window-level)` per pane plus one explanatory line.

**Native peek is operationally empty in production today.** Per decision 202 the host publishes no capture artifact (`artifacts: none`), so `captureView` answers `not-enabled` for every native pane and peek surfaces that verbatim as `could not read the terminal — not-enabled: …`. The coordinator-facing contract is identical on both backends and the tmux path works fully; native text arrives the day capture activation is decided, with no change to this command. Reporting `not-enabled` beats an empty tail that would read as a silent worker.

Per-pane cost was not measured; if a sweep over several workers turns out slow, the "fast glance" premise needs revisiting before the payload grows.

## Alternatives considered

- **A background per-pane activity tracker for tmux** (poll each pane's screen hash on a timer to synthesize per-pane times). Rejected: a permanent CPU and tmux cost paid continuously for a rare read.
- **Two captures 400 ms apart inside each peek** to report progressing/static per pane. Rejected: every glance costs half a second and a slow agent reads as static.
- **Building the whole command on the `TerminalBackend` seam.** Originally rejected because the seam had no production callers and peek would have doubled as a migration. Decision 202 then replaced `TerminalAttachment.capture()` with a purpose-built observational `captureView`, so the native tail now goes through it — while the tmux path stays on the tmux client, whose `list-panes` sweep peek needs regardless and whose `#{window_activity}` the seam deliberately reports as unknown.
- **Falling back to the session-wide `PtySession.lastOutputTime`** when a per-pane time is missing. Rejected: it is per session, exists only while the app streams that task, and would silently turn "we do not know" into a confident number.
- **Reading `parser-state.json` directly** for native text and freshness. Written that way first, then removed: it bypasses the capture seam that owns the honest `not-enabled` answer, and in production it silently returns nothing because no artifact is published.
