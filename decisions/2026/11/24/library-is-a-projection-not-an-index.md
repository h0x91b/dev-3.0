# The Library is a projection of task records, not an index

## Context
Users lose past reports and videos inside completed tasks, and shown media fills the disk (one machine: 3.3 GB of artifacts in dev-3.0, 19 GB of media in video-edit). Every output already lives as a record on its task (`sharedArtifacts`, `sharedImages`/`Videos`/`Audio`, `liveArtifact`) in each project's `tasks.json`.

## Decision
`getLibrary` (`src/bun/rpc-handlers/library.ts`) walks every project and every task status on each request and projects the records through `taskLibraryItems` (`src/shared/library.ts`); the handler writes nothing; its only extra disk access is an `existsSync` per stored file, so sizes count only files that still exist and an item whose primary file is gone is flagged `missing`. No index file is written, so older app versions see no new state (`loadTasks` may still apply its usual in-place content backfills to a board the user rarely opens). A malformed record skips its task, not the screen. Open screens patch one task from each `taskUpdated` push with the same pure projection instead of refetching the archive. The screen is a menu-only route (`library`, the `sessions` precedent): header `More`, View menu, palette. Items open in the existing task viewers as popups. Sizes are "on record" (every retained version plus assets); the honest freed size of a delete comes from the shared-media delete API, not from here.

## Risks
The payload grows with the whole archive (~16 MB for 6.7k items measured on a real board; full records travel so the viewers keep version history). It is paid on mount only; if that gets slow, slim `previousVersions` out of the list and fetch on open. A record patched from a push reads as present until the next mount re-checks it. Image rows show a type glyph, not a thumbnail: thumbnails would read full images as base64 for every row.

## Alternatives considered
- A persisted index file: faster, but a second source of truth that drifts from `tasks.json` and new on-disk state every installed version must tolerate.
- A dashboard section or a project tab: the job is cross-project and the task is often forgotten; scope is a filter on one screen instead.
