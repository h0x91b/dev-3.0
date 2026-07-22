# 151 — Guard the update flow on dev/source builds

## Context

Running the app from source (`bun run dev`) builds it on the `dev` channel. Triggering the manual "Check for Updates" menu action crashed with
`Update check failed: Download failed: TypeError: undefined is not an object (evaluating 'updateInfo.error = "Failed to download latest version"')`.

## Investigation

Electrobun's `Updater.checkForUpdate()` (`node_modules/electrobun/dist/api/bun/core/Updater.ts`) early-returns on the `dev` channel *without* initializing its module-level `updateInfo`. A dev build with a non-dev `updateChannel` (default `stable`) takes the cross-channel branch of `doDownloadUpdateForChannel`, which calls `Updater.downloadUpdate()`; that finds no tar to unpack and executes `updateInfo.error = "Failed to download latest version"` on the still-`undefined` object → `TypeError`. The auto-check already skipped dev; the manual check/download path did not.

## Decision

Guard the `dev` channel in `src/bun/updater.ts`: `checkForUpdateWithChannel` returns `{ updateAvailable: false, devBuild: true }` (no network) and `doDownloadUpdateForChannel` returns a clean error before ever touching Electrobun's updater. The menu handler (`src/bun/index.ts`) surfaces `devBuild` as a new `updateCheckOutcome` status `"dev"`, shown as an info toast (`update.devBuildNotice`).

## Risks

Low. Dev builds could never self-update anyway (Electrobun disables it); we only replace a crash with a notice. If the build-time channel string ever stops being `"dev"` for source builds, the guard silently stops applying — but the download-layer guard still prevents the crash for any channel Electrobun disables.

## Alternatives considered

- Patch `node_modules/electrobun` — rejected; vendored dependency, lost on reinstall.
- Actually implement cross-channel download — out of scope and impossible to *apply* on a dev build (Electrobun gates it).
