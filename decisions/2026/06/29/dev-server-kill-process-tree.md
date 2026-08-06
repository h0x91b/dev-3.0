# 092 — Kill the dev server's whole process tree on Stop

## Context
Pressing **Stop** on a task's dev server removed its tmux pane but left the real
workload running (e.g. the launched Electrobun `.app`, or a `vite`/`webpack`
process still holding its port). The orphaned processes kept running with no
visible owner.

## Investigation
The dev server runs in a detached tmux session `dev3-dev-<id>` whose single pane
executes `bash <devScriptPath>` (the user's `devScript`). `stopDevServer` →
`killDevServerSession` only did `tmux kill-session`, which delivers **SIGHUP to
the pane's foreground process only**. Deep children that run in their own
process group or get reparented to init survive the teardown. The viewer pane
lives in a *separate* task session, so nothing reaped the dev session's child
tree.

## Decision
In `src/bun/rpc-handlers/tmux-pty.ts`, `killDevServerSession` now snapshots the
dev session's pane PIDs **plus all descendants** (`getSessionPanePids` +
`getDescendantPids` from `port-scanner.ts`) *before* tearing down the session,
then `reapDevServerTree()` sends SIGTERM, waits `DEV_SERVER_KILL_GRACE_MS`
(600 ms) for a graceful exit, and SIGKILLs survivors. The same reap is applied
in `killTmuxSession`'s dev-session cleanup branch (same orphan bug when a whole
task session is destroyed). All signalling is best-effort (ESRCH ignored).

## Risks
- A fully *daemonized* child (double-fork → reparented before we snapshot, no
  ppid link) won't be captured — inherent to any ppid-walk approach.
- Tiny TOCTOU window: a snapshotted PID could be recycled before SIGKILL. The
  grace is sub-second and the PID set is scoped strictly to the dev session, so
  the risk is negligible.
- Adds ~600 ms to a stop/restart; acceptable and helps ports release cleanly.

## Alternatives considered
- **Launch devScript in its own process group and `kill -- -PGID`** — cleaner
  semantically but misses already-detached processes and complicates the
  attach/detach viewer flow.
- **`pkill -f <devScriptPath>`** — fragile (false matches, misses children with
  no marker in their cmdline).
