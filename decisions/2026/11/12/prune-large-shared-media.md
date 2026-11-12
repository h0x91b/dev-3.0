# Large shared media expires after 60 days

## Context

`shared-images/`, `shared-artifacts/` and `uploads/` under each project's worktree root were never cleaned. Measured
on 2026-11-12: 20.4 GiB logical. Every artifact publish copies its assets (APFS clones, cheap) and also writes a ZIP
bundle that repeats them as real bytes. 587 bundles held 4.1 GiB, 3.8 GiB of that being media already stored next to them.
The user ruled: images and videos over 5 MB go after two months, in doctor and in the daily cleanup. The ZIP is
only ever read by the download button, so it should not be stored at all.

## Decision

- `saveSharedArtifact` (`src/bun/shared-artifacts.ts`) no longer writes a ZIP or `bundlePath`.
  `loadSharedArtifactDownload` builds the ZIP in memory (`buildArtifactZip`) from the page and the assets still on
  disk, when `planSharedArtifactDownload` says attachments need it. Old records keep their `bundlePath`; nothing reads it.
- `src/cli/commands/doctor-media.ts` lists images and videos of at least `MEDIA_PRUNE_MIN_BYTES` (5 MiB) in those
  pools, plus stored ZIPs of that size. `dev3 doctor --worktrees` reports them. `--prune-media-older-than <D>` deletes
  media and `--prune-bundles-older-than <D>` deletes stored ZIPs.
- The daily job (`src/bun/worktree-cleanup-job.ts`) uses `MEDIA_RETENTION_DAYS = 60` and `BUNDLE_RETENTION_DAYS = 30`,
  behind the same `autoCleanupTaskHistory` opt-out. Stored ZIPs get 30 days, not zero, because older app versions
  still download through them.
- A file an open task still shows (its `sharedImages`/`sharedVideos`/`sharedAudio` path, anything inside its
  `sharedArtifacts` dirs, an upload its description names) is never selected. Age is the newest of mtime and birth time.
- Only files are deleted, never directories, and nothing is renamed. `loadSharedArtifactContent` skips missing assets,
  and the download falls back to one HTML when the ZIP is gone, so a pruned artifact still opens.

## Risks

- Older installed versions still throw when an artifact asset is missing, so they show an error for a pruned artifact.
  On a new artifact (no `bundlePath`) their download is the bare HTML without its assets.
- Deleting a cloned asset frees only what its clone source does not share. The ZIPs are the real win.
- Audio is not included (the ruling named images and video).

## Alternatives considered

- Deleting whole artifact directories: loses the HTML and the record's target for no extra space.
- Keep storing the ZIP and only prune it: the duplicate would come back with every publish.
- Delete every stored ZIP at once: breaks downloads in older versions straight away.
