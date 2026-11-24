# Users delete large shared clips; the record stays as a tombstone

## Context

`dev3 show-media` copies every shown clip into the per-project `shared-images/` pool and keeps every version (`src/bun/cli-socket/ui-commands.ts`). One video-edit project reached 19 GB by `du`. Measured on 2026-11-24: Bun's `copyFile` clones on APFS (1000 MB copy: `cat` +1088 MB, Bun +0-4 MB of free space), and 46 of 48 stored/original pairs shared their mid-file block (`F_LOG2PHYS_EXT`). So ~7 GB was shared with live originals and ~11 GB was renders the user had already deleted, kept alive only by dev3's clone. The 60-day prune (`decisions/2026/11/12/prune-large-shared-media.md`) never touches an open task.

## Decision

- `src/bun/shared-media-delete.ts`: `deleteSharedMedia` resolves ids against the task's own records (the renderer never names a path), refuses anything that is not a live clip, not inside a shared-images pool (`isStoredSharedMediaPath`), or shared with another record. It writes `removedAt`/`removedBytes` under the tasks lock, then unlinks the file only — no directory removal, no rename. A failed unlink (Windows, open handle) revives the record.
- `freeableBytes` reports the honest gain: on macOS a stored clip whose original is on the same volume, same size and not modified since the show counts as 0.
- UI: a destructive item in the viewer's own right-click menu, and "Delete older clips" (every clip >= `LARGE_SHARED_MEDIA_BYTES` = 15 MB but the newest) in the task's Media section. Both confirm through `confirm()` after a dry run, so remote mode works the same.

## Risks

- The clone heuristic can misjudge (an original replaced by a same-size file with an old mtime); it only affects the number shown, never what is deleted.
- Older app versions show a tombstoned clip as "Video unavailable".

## Alternatives considered

- Referencing the original instead of copying: on APFS it saves nothing while the original lives, and here 114 of 165 large originals were already gone or moved.
- Dropping the record on delete: loses caption and provenance, and the item silently vanishes from history.
- Auto "keep last N" on open tasks: deletes behind the user's back; left to the separate retention work.
