# Closed tasks keep only their newest large clips; pins are kept forever

## Context

The 60-day prune (`decisions/2026/11/12/prune-large-shared-media.md`) counts age from the file and keeps everything for two months, so a closed video task still holds every render of every iteration. The user ruled: "large" is 15 MB or more (for the 60-day prune too); a closed task keeps its newest 15 large clips for a week after it closes, then 3, then 1 after 30 days; the 60-day rule still removes the last one; open tasks are never auto-pruned; a pinned clip is never removed.

## Decision

- `src/shared/types/shared-media.ts`: `pinnedAt` on `SharedImage` (additive). `sharedMediaRetention(task)` is the pure rule: it ranks live, unpinned clips of at least `LARGE_SHARED_MEDIA_BYTES` by show time (`createdAt`, newest first). The clock starts at `movedAt` (fallback `updatedAt`) of a `completed`/`cancelled` task. Each clip's `removesAt` is the earlier of its tier deadline (`SHARED_MEDIA_RETENTION_TIERS`) and `createdAt` + 60 days. `dueSharedMediaIds` is what is due now. The same function is the preview for any page ("removes in N days").
- `src/bun/shared-media-retention.ts` runs on the host before the cleanup worker (`worktree-cleanup-scheduler.ts`), through `deleteSharedMedia`, so every removal is a `removedAt` tombstone and goes through the same pool and shared-file checks. One refused record falls back to per-id deletes so it cannot shield the rest. After the worker's file prune, `tombstoneMissingClips` marks closed tasks' clips whose file it removed.
- `doctor-media.ts`: `MEDIA_PRUNE_MIN_BYTES` = 15 MiB, and a pinned record's file is held on any task, closed ones included.
- The manual "delete older clips" sweep (`olderLargeSharedClips`) also leaves pinned clips alone; single-clip delete still works on them, because that is an explicit choice.
- Pin/unpin: `setSharedMediaPinned` RPC; in the viewer it is a checkbox item in the clip's right-click menu, and the header shows a "Kept" pill.

## Risks

- The 15 MiB floor also applies to `shared-artifacts/` and `uploads/`, so files between 5 and 15 MiB there are no longer pruned at all.
- The retention pass runs behind the same `autoCleanupTaskHistory` opt-out as the daily job. An older app version never deletes by tier, but it can delete a pinned clip after 60 days, because it does not know `pinnedAt`.
- Reopening a closed task stops further removal; what was already removed stays a tombstone.

## Alternatives considered

- Doing the tiers in the worker's file scan: it sees files, not records, so a removal would leave a dead record instead of a tombstone.
- Counting the clock from the clip's age: a long task would lose its renders the day it closes.
- Pins taking one of the kept slots: the user would lose the newest unpinned render the moment they pin an old one.
