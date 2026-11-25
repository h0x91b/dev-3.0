# Prune staged native host images

## Context

Every native launch of a new dev3 build stages a new immutable image into `~/.dev3.0/native-host-images/<tag>/` and nothing ever removed one, so the directory grew without limit. A running host executes from its image, and several installed dev3 versions share the directory.

## Decision

`host-images/prune.ts` deletes `<root>/<tag>` only when all hold: the name is a packaged tag (`<bun>-p<protocol>-<digest12>`) and a real directory (symlinks and foreign entries are never touched); it is not one of the 2 newest by last use; it was last used more than 7 days ago; and no session record whose host executable sits inside it is `owned` or `reused`. A `dead` record protects the image only while its host pid is still alive, because a host can outlive its shell for a moment. Abandoned `.staging-*` directories older than 24h go too. "Last used" is the image directory mtime, which `packagedImageRuntime()` sets with `utimesSync` after every successful stage, so the rule tracks use rather than creation. It runs 5 seconds after app start and, fire-and-forget, right after a new tag is staged (that tag is the newest, so it needs no special case). The runtime carrier is unlinked before the directory is removed. One prune runs at a time per process. If the session list cannot be read, nothing is deleted.

The images are a rebuildable cache, not user state, so the on-disk invariants in `AGENTS.md` are not touched: every version that has this directory re-stages its image on each native launch, and deleting one breaks no installed version. A second dev3 version that launches from a tag while this one prunes is covered by the 7-day window, because its launch refreshes the mtime first.

## Risks

A pre-existing host started by an older dev3 whose record is unreadable would not protect its image; the 7-day window and the 2-newest rule make that unlikely. A dev3 version older than this change does not refresh the mtime, so a launch it starts from an old image can race a prune; the launch fails once and the next one re-stages the image. Carrier-first deletion keeps an image whole-or-gone: a locked executable (Windows) fails the delete before anything else is removed, so `stagePackagedImage` never meets a half-deleted image it refuses to overwrite. A failed delete is logged and retried on the next run.

## Alternatives considered

Pruning by creation time: would delete the image in daily use. A reference count file per image: a second on-disk format other versions must honour. Deleting at update time only: misses images left by earlier installs.
