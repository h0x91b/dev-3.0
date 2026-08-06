# 043 — Hourly `tasks.json` backups live in a parallel path

## Context

`tasks.json` is the only persisted task store for a project, so a bad write or
manual corruption can wipe the board state in one shot. We wanted automatic
recovery points without touching the canonical file path or breaking older app
versions that still read `~/.dev3.0/data/<slug>/tasks.json`.

## Investigation

Per-write versioning would create many near-duplicate snapshots during active
sessions and would grow without a hard retention cap. Rewriting or renaming the
main file was off-limits because `~/.dev3.0/` is shared state across app
versions and `AGENTS.md` explicitly freezes the existing layout.

## Decision

`src/bun/data.ts` now writes hourly pre-save snapshots of the current
`tasks.json` into `~/.dev3.0/data/<slug>/tasks-backups/<YYYY-MM-DDTHHZ>.json`
before normal task writes. The snapshot is created at most once per UTC hour,
and the same code prunes the directory down to the newest 72 files.

## Risks

Backups are opportunistic, not timer-driven: if nothing writes `tasks.json`,
there is nothing new to snapshot. This is acceptable because the goal is to
preserve recent write-time recovery points, not to run a background daemon.

## Alternatives considered

- Snapshot on every write. Rejected because it produces noisy duplicate files
  during heavy task churn.
- Replace `tasks.json` with a rolling file scheme. Rejected because it changes
  the canonical path and risks cross-version breakage.
