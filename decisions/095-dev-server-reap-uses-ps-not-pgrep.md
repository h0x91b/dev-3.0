# 095 — Reap the dev server tree via `ps`, not `pgrep` (`.app` quirk)

## Context
Even after [decision 092](092-dev-server-kill-process-tree.md) added a process-tree
reap on **Stop**, the dev server's real workload kept running — pressing Stop removed
the tmux pane but the launched Electrobun `.app` (and `bun run dev` and everything
under it) stayed alive, reparented to launchd. The user reported the app "никуда не
девается" after stopping the dev server.

## Investigation
Reproduced with a fresh build and instrumented `killDevServerSession`. The reap log
showed `count: 1` — the snapshot captured **only the pane PID** (which `tmux
kill-session` already SIGHUPs), so the entire subtree was never signalled. A
side-by-side probe at the moment of Stop was decisive:

```
[DEVKILL] descendants pid=64270
  viaPgrep (getDescendantPids, per-PID `pgrep -P`): []        ← EMPTY
  viaPs (buildProcessTree + collectDescendants):  [8 pids]    ← FULL TREE
```

Root cause: `getDescendantPids` shelled out to `pgrep -P`, and **`pgrep` returns
nothing when spawned from the packaged GUI `.app` process** (hardened runtime /
sandbox blocks its `KERN_PROC_PPID` sysctl). `ps -eo pid,ppid` from the *same*
process at the *same* instant returns the full table. Confirmed `pgrep` works fine
from a plain `bun`/CLI process — the failure is specific to the `.app` runtime, which
is exactly where `stopDevServer` runs. A `pgrep` BFS also truncates the whole subtree
the moment any single spawn returns non-zero, so the failure is silent and total.

## Decision
In `src/bun/port-scanner.ts`, `getDescendantPids` now delegates to
`collectDescendants(pid, buildProcessTree())` — a single `ps -eo pid,ppid` snapshot
walked in memory. `pgrep` is removed entirely (it was a footgun for every caller in
the `.app`). `collectDevServerTreePids` in `src/bun/rpc-handlers/tmux-pty.ts` builds
the tree once via `buildProcessTree()` and walks each pane PID with
`collectDescendants`. The `ps` walk also crosses the new process group Electrobun
puts the launched app in (ppid links stay intact). Verified end-to-end: after Stop,
the `dev-3.0-dev.app`, `bun run dev`, launcher and app-bun are all gone.

## Risks
- One `ps -eo pid,ppid` spawn per `getDescendantPids` call. Dev sessions have a
  single pane, so the reap does one `ps`; negligible.
- A child that re-parents to launchd *before* the snapshot still escapes — but the
  snapshot runs before `kill-session` while the tree is intact, so in practice it is
  complete (verified).

## Alternatives considered
- **Make `pgrep` reliable in the `.app`** — not possible from userspace; the sysctl
  restriction is imposed by the runtime.
- **Kill by process group (`kill -- -PGID`)** — Electrobun spawns the app in its own
  process group, so a single PGID kill misses it; would need to collect multiple
  groups. The `ps` ppid-walk catches everything in one pass, so this was unnecessary.
