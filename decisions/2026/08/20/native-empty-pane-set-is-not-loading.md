# An empty native pane set means "gone", and must say so

## Context

With the native terminal backend, killing the `dev3-terminal-host` process from a
shell and re-entering the task left the terminal on "Connecting..." forever.
Reproduced 3/3 on macOS 15.7.7 (SIGKILL and SIGTERM, mid-session and
never-viewed, immediate re-entry and 14 minutes later, across a full page reload).

## Investigation

`taskPaneState` answered with a well-formed, successful `TaskPaneState` carrying
`panes: []` — the same value the renderer sees while a session is still being
created. `TaskTerminal`'s native branch rendered that as `// No panes yet
(loading).`, so "nothing is there" and "not loaded yet" were indistinguishable on
the wire and the optimistic reading won. No timeout existed: the file's only
timeout (`PTY_CONNECT_TIMEOUT_MS`) is wired to an empty callback and belongs to
the tmux path.

Two suspects were ruled out. There is no stale socket or stale registry record —
`~/.dev3.0/native-sessions`, `native-session-locks` and the coordinator's
`native-multipane` dir were all emptied within ~8s of the kill. And no WebSocket
is ever opened on re-entry; `TerminalView` is never constructed, so the hang is
above the transport.

## Decision

`TaskPaneState` gains an optional `sessionAbsent` flag (`src/shared/task-panes.ts`),
set only by the native branch of `taskPaneState` when `nativeTaskPanesState`
returns null (`src/bun/rpc-handlers/task-panes.ts`). `TaskTerminal` counts
consecutive absent reads and, at `NATIVE_ABSENT_READS` (2, so ~5s worst case),
replaces the spinner with a restart offer (`terminal-host-gone-screen`).

The button reuses the server's existing recovery machine: `getPtyUrl({ resume: true })`
already destroys the dead session and either relaunches it or offers the stored
agent session, which the native path simply never called. `handleResumeSession`
and `handleStartFresh` became backend-aware — on native the canvas is driven by
pane state, so they re-read panes instead of setting a single `ptyUrl`.

Restart is offered, never automatic: silently respawning an agent the user killed
would hide the death rather than show it.

## Risks

Two reads, not one, because a session still being created also answers absent for
about a second; a slower machine could in principle stretch that past 5s and flash
the card at someone whose terminal is opening. The counter resets on any live
read, so the card would correct itself on the next poll.

## Alternatives considered

- **A plain timeout on the spinner** — cheapest, but it guesses instead of knowing,
  and cannot tell a dead host from a slow launch.
- **Client-side inference** (treat empty-after-first-success as dead) — no protocol
  change, but it re-derives on the client a fact the server already has.
- **Automatic restart** — rejected: it hides that anything died, which is the
  opposite of what a working-looking-but-dead state needs.
