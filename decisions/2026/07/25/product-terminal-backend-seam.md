# 169 — Product terminal-backend seam with two real adapters (MIG-002)

## Context

Seq 1280 (parent 1141, tmux-removal roadmap) is the first step where a *product*
backend contract is allowed: MIG-001 froze the externally visible behaviors in a
test-only corpus, and seq 1254 composed the native primitives into one single-view
lifecycle. What was missing is a seam the next native task-terminal tracer can be
written against without either backend leaking into product code — and without
turning the test harness into an interface by renaming it.

## Decision

New module `src/bun/terminal-backend/`: `contract.ts` (`TerminalBackend`,
`TerminalAttachment`, session/view specs and states), `errors.ts` (one
`TerminalBackendError` with a discriminated `code`), `tmux-port.ts` +
`tmux-backend.ts`, `native-backend.ts`, `index.ts`.

The contract is derived from the corpus **plus** product needs, not promoted from
the test-only `ParityRunner`: it adds an attachment handle (the live
write/resize/read binding, obtainable from a fresh controller for reconnect),
first-class `resize`, a typed failure taxonomy, a single `describeSession` read
returning `null` for absent, and `dispose()` that never tears a session down.

tmux stays private behind `tmux-port.ts` — the only file in the module that
imports the tmux module (asserted by the isolation test); names, `%pane` ids,
`-F` formats, sockets, and argv never reach `tmux-backend.ts` or the barrel. The
native backend *wraps* `NativeSingleViewAdapter` and imports nothing from the
registry; multi-view returns the typed `unsupported` code until LAY-003/LAY-004.
There is no capability negotiation, flag, selector, fallback, or persisted
identity, and no production caller (isolation test).

Two small extensions were needed to express the contract honestly rather than
faking it: `TmuxClient.sendKeys({ literal })` (`send-keys -l`, raw input bytes)
and `TmuxClient.resizeWindow` (`resize-window -x -y`), plus
`NativeSingleViewAdapter.writeInput` / `resizeView` / `detachSession`.

## Investigation

`resize-pane -x/-y` is a no-op for a single-pane detached session (verified on
tmux 3.6a: geometry stayed 80x24), while `resize-window -x -y` sets it (120x50) —
tmux switches the window to manual sizing. `send-keys -l` with a literal CR
delivers the line to the shell verbatim. Both are proved against a real tmux
server in `__tests__/tmux-backend.live-e2e.test.ts`; the same contract suite runs
against both adapters over in-memory worlds in the fast suite.

## Risks

- tmux resize applies to the window, so it is session-wide rather than per-view.
  That matches the corpus's recorded intentional difference, but a future
  multi-view product caller must not expect per-view geometry from tmux.
- `openSession` rejects an existing id instead of adopting it; a rollout that
  wants "attach if present" must ask for it explicitly (`describeSession` then
  `attachView`) — deliberate, to keep double spawn/attach impossible.
- The seam has no callers yet, so its ergonomics are only proven by tests. The
  next tracer may need additions; adding a method is cheaper than unwinding a
  premature capability-negotiation layer.

## Alternatives considered

- **Promote `ParityRunner` to the product interface** — rejected by MIG-002 and by
  shape: it is a test harness (no attach/resize, no typed errors, disposal that
  kills sessions).
- **Put streaming output on the contract** — rejected: bytes belong to the
  PTY/host layer above the seam, and a tmux implementation would mean
  re-implementing `pty-server`. The contract exposes point-in-time captures.
- **A `capabilities()` probe so callers can branch on multi-view** — rejected by
  the roadmap's non-breaking invariants; the typed `unsupported` failure carries
  the same information without a negotiation protocol.
