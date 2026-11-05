# Read-only git probes get a timeout, a process group, and one-in-flight polling

## Context

Issue #2153: a `dev3 remote` service had ~2,900 live `git status --porcelain` children after 27h, and the load average reached 283. Every poller tick (each open window or browser × project, every 15 s, plus the 60 s merge watcher) spawned a new `git status` with no timeout. If one stopped answering (wedged fsmonitor, stalled filesystem), it lived forever, and the next tick started another one alongside it.

## Investigation

We reproduced it on the real remote-access server and RPC handlers with an isolated `DEV3_HOME`, a repo whose `core.fsmonitor` hook never answers, and clients polling `getProjectCurrentBranch`. Three clients over two hung repos and one healthy repo left 461 live `git status` after 40 s, and the healthy repo got 31 answers in the first 30 s. After the fix: at most 2 (one per hung repo), killed with their hook grandchildren at the timeout, and 178 answers for the healthy repo. An `index.lock` and a deleted project path did not leak: `--no-optional-locks` ignores the lock, and a missing cwd fails fast.

## Decision

- `run()` in `src/bun/git.ts` gives `status`, `rev-parse`, `symbolic-ref`, `rev-list` and `merge-base` a default **30 s timeout** (`DEFAULT_GIT_PROBE_TIMEOUT_MS`) when the caller passes none. That is the defensive cap. An explicit `timeoutMs` still wins.
- Every git that `run()` spawns becomes its own process-group leader (`detached`, POSIX only). On timeout, `killProcessGroup` sends SIGTERM to the whole group so git can release its lock files, then SIGKILL after 1 s, which also reaches fsmonitor hooks and submodule children. When dev3 exits, any probe still running is SIGKILLed.
- `isWorktreeDirty` (every caller is a poller) shares one in-flight `git status` per worktree. A timed-out status reads as dirty, so the merge watcher never offers completion over unknown state. `getProjectCurrentBranch` shares one in-flight read per project. The merge-detection poller skips a tick while the previous tick is still running. `GitPullButton` returns its request, so the visibility-aware poll's no-overlap guard applies again.

## Risks

A legitimately slow probe (more than 30 s on a huge repo under load) now fails instead of answering late. Pollers retry on the next tick. Process-group detachment also removes git's controlling terminal, so a credential prompt fails instead of waiting on a TTY nobody watches. Coalescing is deliberately not global: a status taken right after a mutation must not join a scan that started before it.

## Alternatives considered

A timeout on every git command was rejected: clone, rebase and push can legitimately run for minutes. Cancelling handler work when a remote client disconnects would need an AbortSignal threaded through every handler; once timeouts and coalescing are in place, the work it would save is bounded anyway. A global cap on concurrent git processes would hide the problem rather than fix it, because one repo could still starve all the others.
