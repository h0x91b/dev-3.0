# 205 — Cleanup-script teardown watchdog: orphaned tmux client, then a hard cap

## Context

`runCleanupScript` spawned the project cleanup script in an attached `dev3-cl-<short>` tmux
session and awaited `proc.exited` with no bound. That await sits in the middle of the teardown
effect chain, before `captureCompletedDiffStats`, `removeWorktree` and `persistTerminalTask`, so
a client that never exits strands the task in `tearing-down` forever: the card keeps the
`shuttingDown` overlay (greyed, `pointer-events: none`) and the worktree is never removed.

Reported in [issue #1251](https://github.com/h0x91b/dev-3.0/issues/1251) with an exact
correlation: 43 live `dev3-cl-*` clients ↔ 43 tasks persisted as `tearing-down`, 391 leaked
worktrees / 142 GB in one project. The scripts themselves had completed; the tmux **client**
process stayed alive (`Ss+`) for days after its session was already gone from
`list-sessions`.

## Investigation

The lifecycle actor is a strictly serial FIFO mailbox per task (`src/bun/lifecycle/actor.ts`),
so the reporter's suggestion of a periodic reconciler for stale `tearing-down` tasks cannot
work: a sweep event would queue behind the wedged effect chain and never run. Only bounding the
await itself unwedges the task. That is why this fix lives at the source and no watchdog sweep
was added.

A flat timeout is the obvious bound but has to choose between cutting off a legitimately slow
cleanup script and leaving the card stuck for minutes. The reported failure has a much sharper
signature — session gone, client alive — which distinguishes the two cases directly.

## Decision

`awaitCleanupSession` in `src/bun/lifecycle/executor.ts` polls every
`CLEANUP_SESSION_POLL_MS` (5 s) while racing `proc.exited`:

- Two consecutive `has-session` misses ⇒ orphaned client: warn, best-effort
  `kill-session`, `kill(9)` the client, continue teardown (~10 s to recover).
- `CLEANUP_SCRIPT_HARD_TIMEOUT_MS` (10 min) ⇒ same abandonment path, for a script that is
  genuinely still running.
- A throwing `has-session` (unreadable socket) counts as alive — inconclusive is not proof of
  death, and the hard cap still applies.

Spawn, exit code and duration are now logged; the previously silent gap between
`Killed dev server session` and `Removing worktree` was what made this hard to localize.

## Risks

A cleanup script legitimately running longer than 10 minutes is killed and teardown proceeds —
accepted: a leaked worktree and an unclickable card are worse. The liveness probe adds one
`tmux has-session` spawn per 5 s per teardown, bounded by one teardown at a time per task.

## Alternatives considered

- **Flat 60 s timeout** — simplest, but either kills legitimate slow cleanups or leaves the card
  stuck for the full window; it also ignores the diagnostic signal already available.
- **Run the cleanup script without tmux** (plain piped `spawn`) — removes the failing component
  entirely, but drops the TTY that scripts rely on for colored/interactive output and is a
  larger behavioral change than the bug warrants.
- **Periodic reconciliation of stale `tearing-down` tasks** — impossible through the mailbox, as
  above; would require a path around the actor.
