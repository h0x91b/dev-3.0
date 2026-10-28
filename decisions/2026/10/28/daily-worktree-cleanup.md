# The app runs `doctor --worktrees --prune-older-than 14d` once a day

## Context

`doctor-worktrees-only-sanctioned-deletion` made deletion under `~/.dev3.0/` a typed CLI flag only, "never from the
app". Nobody typed it: on 2026-10-28 the maintainer's machine held 3350 metadata-only dirs (17.5 GB) of finished
tasks, and a user reported 30+ GB. The user ruled that dev3 itself runs the prune once a day, and that
`--prune-older-than` covers orphans and unfinished teardowns too, with unmerged branches waiting 60 days.

## Investigation

`--prune-older-than 14d` silently meant "older than 30 days": selection required `reclaimableBytes > 0`, which the
report only sets for the 30-day `stale` bucket. Measured here: 0 dirs selected vs 287 finished-task dirs (10.3 GB)
aged 14-30 days. A full scan takes ~2.5 min of `spawnSync` (`du`, `git`) on this tree.

## Decision

- `prune()` (`src/cli/commands/doctor-worktrees.ts`) selects by `olderThanSelects()`: anything no open task owns,
  aged at least N days. An entry on an unmerged `dev3/task-*` branch needs `max(N, UNMERGED_PRUNE_FLOOR_DAYS = 60)`
  and keeps its branch ref; `--force-unmerged` lowers that to N and deletes the branch (unchanged CLI behaviour).
- `src/bun/worktree-cleanup-job.ts` is the daily job: the same `collectWorktreeReport` + `prune()` with
  `olderThanDays: 14`, no `--prune-orphans`, never `--force-unmerged`. It runs in a `node:worker_threads` worker
  (`src/bun/workers/worktree-cleanup-worker.ts`); without the worker bundle it does not run at all, rather than
  freezing the host thread. After the prune the worker gzips what remains via `compressAllDiffSnapshots` (`src/bun/diff-snapshots.ts`), so nothing is compressed only to be deleted.
- `src/bun/worktree-cleanup-scheduler.ts`: first check one hour after launch, then hourly. `lastStartedAt` in
  `~/.dev3.0/worktree-cleanup.json` is written before the run under `withFileLock`, so restarts, crash loops and a
  second installed version all skip until 24 h passed. Opt-out: `autoCleanupTaskHistory: false` (Settings → System).

## Risks

- Diffs of tasks finished over 14 days ago disappear from the UI. Uncommitted changes in a worktree left behind by a
  finished or deleted task are lost (a finished teardown would have removed them anyway); commits survive on the branch.
- Older app versions do not know `autoCleanupTaskHistory` and may drop it from `settings.json` on save, re-enabling
  the cleanup.
- A manual `dev3 doctor --prune…` concurrent with the job can race on the same dirs; both use `rm -rf force`, so
  the loser only logs a failed `git branch -d`.

## Alternatives considered

- Spawning the `dev3` CLI binary: `~/.dev3.0/bin/dev3` can belong to another installed version, so the rules would
  drift from the running app's.
- Running the scan on the host thread: a 2.5-minute freeze of every RPC and terminal.
- A long-held lock instead of a claim stamp: a crashed holder blocks every version until a stale timeout, and
  `withFileLock` breaks locks after 10 s.
