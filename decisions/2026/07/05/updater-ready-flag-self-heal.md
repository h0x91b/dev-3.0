# 106 — Self-healing applyUpdate: Electrobun checkForUpdate() wipes updateReady

## Context

Issues #788/#813: the "Restart to Update" header button sometimes did nothing, and the app updated only after the plaque re-appeared minutes later. Restarting dev3 also "fixed" it.

## Investigation

Electrobun's `Updater.checkForUpdate()` (node_modules/electrobun/dist/api/bun/core/Updater.ts) **overwrites** its module-level `updateInfo` with the parsed remote `update.json`, which only contains `{version, hash}` — so every successful check resets `updateReady` to `undefined`. Our 30-min auto-check, the menu "Check for Updates", and even our own recovery code all call it. Consequences in `src/bun/updater.ts`:

1. `applyUpdate()`'s old "refresh via checkForUpdate()" recovery branch could **never** return `updateReady: true` — a wiped flag meant a permanently dead button (error thrown, silently swallowed by the renderer).
2. If a newer release shipped after the download, `updateReady` was true but stale; Electrobun's `applyUpdate()` silently no-ops on the missing latest tar, leaving the UI stuck on "Restarting...".

## Decision

In `src/bun/updater.ts`:
- `applyUpdate()` always re-runs `Updater.downloadUpdate()` before applying — it is the only call that can (re)set `updateReady`, and it is cheap/idempotent when the tar is already on disk (re-marks ready without downloading). Heals both wiped-flag and stale-version states.
- The post-download readiness poll uses `Updater.updateInfo()` only — polling via `checkForUpdate()` was self-defeating (each poll wiped the flag it waited for).
- `withUpdaterLock()` serializes download/apply so a background auto-check cannot wipe state under a user click.
- Renderer (`GlobalHeader.handleRestart`) surfaces apply failures via `toast.error` instead of swallowing them.

## Risks

Depends on `downloadUpdate()` staying idempotent-when-cached in Electrobun; if that changes, the pre-apply repair becomes a full re-download (correct but slow). Offline clicks now fail with a visible error (previously a silent no-op).

## Alternatives considered

- Patching/vendoring Electrobun's Updater to not wipe `updateReady` — correct upstream fix but a vendor fork that breaks on every electrobun bump; better as an upstream PR.
- "Quit & reinstall" fallback UI — treats the symptom, adds manual work for the user.
