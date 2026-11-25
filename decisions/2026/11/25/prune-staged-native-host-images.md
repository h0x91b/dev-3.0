# Prune staged native host images

## Context

Each new dev3 build stages an immutable image into `~/.dev3.0/native-host-images/<tag>/` and nothing removed one, so the directory grew without limit. A running host executes from its image, and several installed dev3 versions share the directory.

## Decision

`host-images/prune.ts` deletes a packaged-tag (`<bun>-p<protocol>-<digest12>`) real directory only when it is not among the 2 newest by last use (the directory mtime, refreshed on every successful stage), was last used over 7 days ago, and no `owned` or `reused` session runs from it (a `dead` record counts while its host pid is alive). It reads session records itself and deletes nothing if the sessions root or any record that has a file is unreadable, corrupt or of a foreign schema; each candidate is then re-read and deleted in one synchronous block, so an in-process launch cannot refresh its mtime in between. An incomplete image (manifest missing or unparseable, or its carrier or entrypoint missing) is garbage: deleted regardless of age, outside the newest 2, unless a live session runs from it, and a failed stage triggers a prune so it cannot block launches. Stale `.staging-*` scratch goes too, and the prune runs at startup (desktop and headless), after a new or failed stage, one at a time.

Images are a rebuildable cache, so the on-disk invariants in `AGENTS.md` are untouched: every version that has this directory re-stages its image on each native launch, and deleting one breaks no installed version. The runtime carrier is unlinked first, so a locked executable (Windows EBUSY) fails the delete with the image still whole.

## Risks

Accepted residual: another dev3 process can select an image unused for 7 days in the instant between our final check and the delete; that one launch fails with an error and the next one re-stages the image (an older dev3 that never refreshes the mtime hits the same case). Closing it needs a lock that staging, launch and prune all honour across versions, and an automatic launch retry cannot tell a pre-exec failure from a live host that never published its record, so both were rejected as more risk than one rare failed launch. A failed delete is logged and retried on the next run.

## Alternatives considered

Pruning by creation time would delete the image in daily use. A reference-count file per image is a second on-disk format other versions must honour. Reading sessions through `registry.list()` swallows unreadable roots and records, which could delete a live host's image.
