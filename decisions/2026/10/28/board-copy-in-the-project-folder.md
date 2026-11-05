# Board copy in the project folder

## Context

A board lives only in `~/.dev3.0`: `data/<slug>/tasks.json`, `task-blobs/`, and the project record in
`projects.json`. The hourly snapshots (`back-up-every-file-of-user-state`) sit in the same folder, so a
new machine, a reinstall or a wiped dev3 folder loses the board and every copy of it. The board is
also lost when the project folder moves, because the data folder is named after the path. Removing
and re-adding the same path does not lose it: `removeProject` only soft-deletes. Project folders are
what people back up already (git remotes, Time Machine, cloud sync).

## Investigation

Measured on WSL2 with the project on a Windows drive (`/mnt/e`, drvfs over 9p, SSD) and on ext4, with
task files of 6.9 KB and 17.5 KB (the median and p95 of a real `tasks.json` entry). macOS and native
Linux were not measured; they are covered by the unit tests and CI only.

| Write + rename over an existing file | 9p p50 / p95 / max per file | ext4 p50 / p95 / max per file |
|---|---|---|
| with fsync, 100 rounds of 50 files | 6.7 / 16.6 / 169 ms | 2.1 / 4.7 / 16 ms |
| without fsync, 30 rounds of 50 files | 6.4 / 17.0 / 36 ms | 0.02 / 0.04 / 1.1 ms |
| one round of 300 files, with fsync | 2.9 s p50, 9.4 s max | 2.2 s p50 |

On 9p a file costs about 6.5 ms with or without fsync, so a whole-board rewrite of 300 tasks takes
2-3 s. Rename is not atomic for a reader there: two reader processes looping during 6,800 renames over
30 s never saw a partial file, but `open` failed with ENOENT on 0.4-1 % of reads and a directory listing
missed a file in about 60 % of listings. On ext4 the same test gave zero errors in 5 million reads. A
Windows-side reader (PowerShell on `E:\`) saw no missing file, but while it held a file open 48 of 6,802
renames from WSL failed with EACCES. A burst of 20 changes in 2 s on a 50-task board with a 3 s
trailing debounce and changed-only writes became one export of 20 files (no debounce: 20 exports, 40
writes). On this machine, 30 CLI changes to a board with the copy on took 89 ms mean per change,
the same as on a board with it off, and the copy matched the board task by task.

## Decision

`Project.boardCopy` (off by default, machine-local) turns on `src/bun/board-copy.ts`. Layout, field
allowlist and restore mapping are in `src/shared/board-copy.ts`.

- **Write path.** `data.onBoardChanged` fires after every task or project-list save. The copy is written
  3 s after the last change, at most 30 s after the first. Only files whose bytes differ are written
  (compared against an in-memory map, against the disk on the first pass), with `atomicWriteFile`,
  no fsync: on 9p fsync costs nothing extra, on ext4 it costs 2 ms a file, and the copy can never be
  more durable than `tasks.json`, which is not fsynced either. `board.json` is written last and lists
  every task file, so a reader can tell a complete copy from a partial one.
- **Failures never reach the board.** Any error (read-only, EACCES from a file open in Windows, full
  disk, missing folder) is logged, retried after 30 s, and shown as one toast per failure streak. The
  exporter never creates the project folder.
- **Two copies are never replaced:** one in a newer format, and one with tasks while the board is empty
  and this process has not written the copy yet. The second is the wiped-data-folder case, where the
  copy is the only board left.
- **Restore is a user act.** Adding a folder whose copy holds tasks, while its board is empty, offers a
  restore through `confirm()`. It never overwrites tasks (`restoreTasksIntoEmptyBoard` checks under the
  task-store lock), refuses another format version, and turns the copy on. Running tasks come back in
  To Do with the branch cleared, because a worktree is never restored. Ids are kept unless one is
  already used on another board (a moved folder whose old board is still registered); then every id is
  remapped, relations included. This is not the automatic restore `back-up-every-file-of-user-state`
  rules out: nothing is restored without the user saying yes.
- **What is not copied:** project env, scripts and accounts; task worktree and terminal handles,
  account ids, agent session state, imported session ids, keep-alive, scheduled work, PR caches and
  shared media. Agent messages only with `Project.boardCopyMessages`, and they are not restored.
- **A copy is untrusted on the way back.** A repository can commit one (`git add -f`), so restore reads
  every task file through the same allowlist (`parseBoardCopyTask`) and drops a file that is not a
  task. A field such as `scheduledLaunch` would otherwise start an agent right after the restore.

## Risks

- A user who deletes every task and restarts the app gets one "kept as it is" warning, because that
  looks like a wipe. Removing `.dev3/board/` ends it.
- On 9p a reader that opens a file during an export can get ENOENT, and an external app holding a file
  open makes the export fail until it closes the file. Both are transient; changed-only writes keep the
  window small.
- Task descriptions and notes are copied as written. The folder ignores itself in git, but a cloud sync
  of the project folder carries it.

## Alternatives considered

- **Whole-board rewrite on every change.** 2-3 s of 9p writes for 300 tasks, and 300 chances per change
  to hit a file Windows holds open. Rejected for changed-only writes.
- **One `board.json` holding everything.** One rename, but every change rewrites the whole board and
  every diff is one huge line. Rejected for one file per task.
- **A blocklist of secret fields.** A field added to `Task` later would leak by default. Rejected for an
  allowlist.
- **Writing the copy into `.dev3/config.local.json`-style git excludes.** Needs a git repo and touches
  `info/exclude`. A `.gitignore` of `*` inside the folder works in any folder and touches nothing else.
