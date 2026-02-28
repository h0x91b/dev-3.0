# 006: Manual updater artifact creation

## Context

Electrobun's `release.baseUrl` config triggers automatic tarball compression and update.json creation during `electrobun build`. However, a bug in Electrobun v1.12.1-beta.2 causes the build to fail: after creating the tar archive, it deletes the `.app` bundle directory (`rmdirSync` at cli/index.ts:2772), then later attempts to re-sign the now-missing launcher binary.

## Investigation

- `generatePatch: false` only skips delta patch generation, not the tarball compression + re-sign flow
- Removing `release.baseUrl` entirely skips the buggy code path — no tar, no re-sign, no crash
- The `.app` bundle, `version.json` (with hash), and `zig-zstd` binary are all available after `electrobun build` completes (without `baseUrl`)

## Decision

Remove `release` block from `electrobun.config.ts` entirely. Create updater artifacts (`.tar.zst`, `update.json`, DMG) manually in the CI workflow after `electrobun build` succeeds.

Hardcode the S3 base URL in `src/bun/updater.ts` instead of reading from `Updater.localInfo.baseUrl()` (which would be empty without the config).

**Files:**
- `electrobun.config.ts` — no `release` block
- `.github/workflows/release.yml` — "Create updater artifacts" step
- `src/bun/updater.ts` — `BASE_URL` constant

## Risks

- If the S3 bucket URL changes, it must be updated in both `updater.ts` and `release.yml`
- Manual artifact creation must match Electrobun's expected naming convention (`{channel}-{os}-{arch}-{filename}`)
- When Electrobun fixes the bug, we should restore `release.baseUrl` in the config and remove the manual step

## Alternatives considered

- **Keep `release.baseUrl` with `generatePatch: false`** — still crashes because tarball compression + re-sign runs regardless
- **Patch Electrobun locally** — fragile, breaks on updates
- **Wait for upstream fix** — blocks the auto-update feature indefinitely
