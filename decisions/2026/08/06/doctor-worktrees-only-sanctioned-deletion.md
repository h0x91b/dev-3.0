# `dev3 doctor --worktrees` is the only sanctioned deletion under `~/.dev3.0/`

## Context

`~/.dev3.0/worktrees/<slug>/<shortId>/` grows one directory per task and never shrinks
on its own. Investigating issue #1251 (teardown wedging on the cleanup-script tmux
client, `cleanup-script-orphaned-tmux-client-watchdog`) surfaced a second, independent
problem: nobody could see the
footprint, and part of it is unreachable garbage. Measured on the maintainer's machine
on 2026-08-05: 83 GB total, and 17 directories totalling 11.8 GB whose short id appears
in **no** `data/*/tasks.json` — invisible in the UI, and no code path will ever re-run
teardown for them. The issue reporter had 391 registered worktrees and 142 GB.

AGENTS.md forbids automatic destructive action under `~/.dev3.0/`, so an automatic
cleaner was never an option.

## Decision

`src/cli/commands/doctor-worktrees.ts` classifies every task directory by
cross-referencing the directory tree, every project's `tasks.json`, and
`git worktree list` / `git branch --merged`, and reports it (`collectWorktreeReport` +
`renderWorktreeReport`). Deletion (`prune`) happens only behind a flag the user typed:
`--prune-orphans`, `--prune-older-than <duration>`, plus `--force-unmerged`. Never at
startup, never from the app.

Four decisions worth recording:

1. **An orphan loses its whole directory; an unfinished teardown loses only
   `worktree/`.** The orphan's `diffs/`/`logs/` describe a task record that no longer
   exists, so they are unreadable garbage. A completed task still exists and the UI
   still renders its diffs — removing just the worktree *is* the teardown step that
   never ran.
2. **An unmerged `dev3/task-*` branch is reported and skipped**, needing a second,
   separate `--force-unmerged`. Unpushed human work is the one thing this command must
   not eat by accident. Exit code 12 (`CLI_EXIT_CODE_PRUNE_INCOMPLETE`) tells a script
   that part of what it asked for was refused.
3. **Merged-ness is checked against `origin/<base>` when that ref exists**, falling
   back to the local base branch. A local `main` that has not been pulled for weeks
   reports freshly merged branches as unmerged, which would hide most of the
   reclaimable space behind a force flag nobody should need.
4. **A task's short id is looked up across ALL projects, not just the slug it sits
   under.** A task moved between projects keeps its old slug's directory; a per-slug
   lookup would report it as an orphan and offer to delete a live task's worktree.
   Virtual ("Operations") projects are read for the same reason.

Sizes come from batched `du -sk` (one spawn per ~200 directories; a spawn per directory
is unusable on a 1400-directory tree) with a recursive JS walk as the Windows path and
the per-directory fallback when `du` cannot read something.

## Risks

- `du` reports disk usage, not apparent size, so the numbers differ slightly from
  `ls -l` sums. That is the number the user cares about.
- Age uses the task record's newest timestamp, falling back to directory mtime when
  there is no record. An orphan therefore reports "age since its directory last
  changed", which is a proxy, not the task's real last activity.
- `--force-unmerged` can delete unpushed commits. It is inert unless typed, and the
  default run names every entry it would affect.

## Alternatives considered

- **Clean up automatically at startup / at teardown.** Banned by the `~/.dev3.0/`
  invariants, and the leak's cause is not yet fixed — an automatic cleaner would hide
  the evidence that the report exists to collect.
- **A GUI screen instead of a CLI report.** The command must work when the app cannot
  start, which is exactly when a disk-full machine needs it.
- **Deleting by age alone.** Age says nothing about whether a worktree belongs to an
  open task; the task-record cross-reference is what makes deletion safe.
