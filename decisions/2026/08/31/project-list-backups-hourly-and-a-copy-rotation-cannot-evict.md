# Project list gets hourly backups and one copy rotation cannot evict

## Context

On 31 Aug 2026 `~/.dev3.0/projects.json` was destroyed on the maintainer's own
machine. All 1865 tasks referenced a project id that was no longer in the file,
so the whole board was unreachable. He had worked on 28, 29 and 30 August and
there was no backup for any of those days.

## Investigation

Measured in the code, not inferred. `backupProjectsDaily` writes
`projects-YYYY-MM-DD.json.bak` holding the PRE-write contents, at most once per
calendar day (first write of the day wins and is never overwritten), keeping
`PROJECTS_BACKUP_RETENTION_DAYS = 7`. It is called from `rawSaveProjects` — so on
every mutation — and once at app startup.

That explains the gap exactly: a backup requires either a project-list mutation
or an app start. He added no project on 28-30 Aug and the app was not restarted,
so nothing fired. The startup hook's own comment claimed "at least one fresh
backup per day the app is used", which is false for a long-running app: it
guarantees one per day the app is STARTED.

Two corrections to what the incident looked like. Retention is 7, not 3, so with
only three dated files present nothing was near eviction. And the 453-byte
one-project backup written at 18:58:30 was not a degenerate snapshot of a healthy
file — it is the pre-write copy of the file as it stood after the list had already
been destroyed and re-added by hand.

Meanwhile the task store was properly protected: 72 hourly snapshots under
`data/<slug>/tasks-backups`. The less important file had the better scheme.

## Decision

`src/bun/data.ts`, `src/bun/index.ts`.

1. `writeHourlySnapshot` — the task store's hourly bucket-and-prune logic
   extracted and now shared, so the two stores cannot drift into different levels
   of protection. `writeHourlyTasksBackup` is a thin call over it.
2. `backupProjectsHourly` writes `projects-backups/YYYY-MM-DDTHHZ.json`, 72 kept.
   The daily `.bak` files stay: 7 days of calendar cover is wider than 72 hours,
   and they are additive sibling paths, so nothing on disk is moved or renamed.
3. A 30-minute timer in `index.ts` drives both schemes, so every hour the app is
   alive gets a snapshot whether or not anything was edited. This is the part that
   would have produced 28-30 August.
4. `projects-last-known-good.json`, advanced by `advanceLastKnownGoodProjects`
   and never pruned, so no rotation can leave a degenerate copy as the only one.

The threshold is the argument. It advances unless the list COLLAPSED — more than
half gone at once — and never on unparseable bytes. "Never shrink" would be its
own bug: a user deleting one project would freeze the file forever and it would
go on holding projects they meant to be rid of. "Always advance" is what lets a
wipe become the only survivor. A collapse is the one shape ordinary editing never
produces, so it is the one shape worth refusing.

## Risks

`projects-last-known-good.json` can hold a stale list after a legitimate
collapse — a user who deliberately removes almost every project keeps an old copy
on local disk until the list grows back. It is local-only and never read
automatically; restoring from it is a human act.

72 hourly copies of a ~31 KB file cost ~2 MB, the same order as the task store's
own backups.

The timer means the app now touches `~/.dev3.0` every 30 minutes while idle. The
writes are new sibling files only, so the frozen on-disk layout invariants hold.

## Alternatives considered

Replacing the daily scheme with the hourly one was rejected: 72 hours is less
calendar cover than 7 days, so it would trade one gap for another. Refusing to
write a degenerate snapshot at all was rejected — a snapshot that lies about the
current state is worse than one that records an emptied list, and the file the
user needs protected is the good copy, not the recent one. A count-based
exemption inside the pruner (keep the largest snapshot in the window) was
rejected as harder to reason about than one plainly named file.
