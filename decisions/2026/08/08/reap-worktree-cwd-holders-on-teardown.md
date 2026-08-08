# Reap every process whose cwd is inside the worktree on teardown

## Context

A user reported Chromium and `agent-browser` burning CPU on an idle machine. The
process table held 18 orphaned `agent-browser` daemons (`PPID 1`), each keeping a
headless Chromium alive: ~95 processes, ~176% CPU, one GPU child pinned at 100%
for days. Mapping each daemon's `lsof -d cwd` to a worktree path showed 11 of 15
belonged to tasks completed up to 18 days earlier — one task had leaked five
daemons on its own. The worktree directories were already unlinked; the processes
kept running against a deleted cwd.

## Investigation

The teardown chain only kills what it can *trace*: `destroyTaskPty` (tmux/native
session tree), then `killDevServerSession`, which walks the dev-session ppid tree
and — since decision 099 — also hunts daemonized children by *pool-port
ownership*. `agent-browser` matches none of it: it double-forks (invisible to the
ppid walk), listens on a unix socket instead of a TCP pool port (invisible to the
port hunt), and is not a `devScript` child. `git worktree remove` then unlinks the
directory without complaint, because a held cwd is an open reference, not a lock.
Nothing anywhere enumerated processes by cwd.

## Decision

New `reapWorktreeProcesses` lifecycle effect (`src/bun/lifecycle/effects.ts`,
dispatched in `executor.ts`, emitted at all five teardown sites in `machine.ts`:
terminal move, the worktree-exists terminal helper, preparation failure, delete,
hibernate). It calls `reapWorktreeProcesses()` in the new
`src/bun/worktree-reaper.ts`, which takes ONE `lsof -a -d cwd -F pn` snapshot of
every process (~0.5 s for ~900 processes, versus one spawn per PID), keeps the
PIDs whose cwd is the worktree or below it, expands their descendants, and runs
them through `terminatePidsVerified` (SIGTERM → poll → SIGKILL → poll).

Ownership is by cwd: whatever lives inside a disposable task worktree is the
task's. Placement is deliberate — after `runCleanupScript` and
`captureCompletedDiffStats` (both work inside the worktree and would otherwise be
killed), before `removeWorktree`. Best-effort, no `abort` policy: a stubborn
foreign process must not block a completion; survivors are logged instead.

## Risks

- **Over-broad kill.** Anything with a cwd inside that worktree dies, including a
  shell the user happened to leave there. Acceptable: the directory is about to be
  deleted. Protected explicitly: the app's own process, its ancestors and
  descendants, and any `tmux` process — tmux inherits the server's cwd from
  whoever started it, so a server launched from inside a worktree would match the
  filter, and killing it takes down every task's terminal.
- **Hibernation keeps the worktree**, so the reap there is a pure process kill; a
  woken task starts its daemons again.
- `lsof` is the only process-inspection tool proven to work from the packaged
  `.app` under the hardened runtime (decisions 095/099); if it ever fails the
  reaper returns an empty map and the leak silently comes back.

## Alternatives considered

- **Kill by cwd inside `git.removeWorktree`.** Fewer touch points, but couples the
  git module to process reaping and would not cover hibernation (no removal).
- **Extend the port-ownership hunt to unix sockets.** Still misses any daemon that
  opens no socket at all (watchers, language servers).
- **Teach dev3 about `agent-browser` specifically.** Fixes one leak and none of the
  next ones; the generic cwd rule covers the whole class.
