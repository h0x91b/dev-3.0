# 168 — Guard re-downloads of a ready update, but keep re-prompting for it

## Context

The 30-minute auto-check only asked "is a newer version available?". Once an update was downloaded and waiting for a restart, every following check saw the same version, downloaded it again, and re-announced it (issue #1072). Long sessions repeated that indefinitely.

Naively "remembering the version and staying silent" fixes the waste but creates a worse problem: after the user clicks *Postpone*, nothing ever prompts again, so people can sit on an old build for days.

## Investigation

Electrobun's `updateReady` flag cannot serve as that memory — any later `checkForUpdate()` wipes it (decision 106). Consequently the app has no trustworthy "already downloaded" signal of its own.

Also, the renderer swallowed repeat announcements silently: `setUpdateVersion(sameVersion)` is a no-op, so the toast effect (keyed on `updateVersion`) never re-ran.

## Decision

`src/bun/updater.ts` keeps its own `readyUpdate = { version, remindedAt }`:

- `downloadUpdateForChannel()` sets it on success and clears it on failure, so every caller (auto-check, Help → Check for Updates, Settings RPC) feeds the same guard.
- `startAutoCheck()` skips the download when `isUpdateAlreadyReady(remoteVersion)`, and calls `onRemind` when `shouldRemindAboutReadyUpdate()` passes — at most once per `READY_REMINDER_INTERVAL_MS` (4 h).
- A genuinely newer remote version, or a prior failed download, still downloads normally.

The reminder is pushed as `updateAvailable` with `reminder: true`. `App.tsx` bumps an `updateAnnouncement` counter on every announcement, and `GlobalHeader`'s toast effect depends on it, so a repeat announcement re-opens the restart prompt (with its 5-minute countdown) even though the version is unchanged.

## Risks

- The memory is per-process: an app restart re-downloads once. Acceptable — a restart applies the update anyway.
- If the downloaded tar is deleted behind our back, the guard still reports "ready"; `applyUpdate()`'s repair download (decision 106) heals that.
- A user who keeps postponing gets a prompt every 4 hours, and an ignored prompt auto-restarts after 5 minutes. Intentional: tmux keeps sessions alive, so restarting is cheap.

## Alternatives considered

- Guard only, no reminder — leaves postponed users stranded on old versions.
- Persist the ready version to `~/.dev3.0/` — pointless extra on-disk state for something a restart resolves.
- Trust Electrobun's `updateReady` — impossible, it gets wiped by every check.
