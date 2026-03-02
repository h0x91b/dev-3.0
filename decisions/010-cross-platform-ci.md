# 010 — Cross-Platform CI Builds (Intel Mac + Linux)

## Context

Release builds only targeted ARM64 macOS on a self-hosted runner (free). Intel Mac and Linux users had no official builds. GitHub-hosted runners cost money, so cross-platform builds should not run on every version bump.

## Decision

Single workflow with a dynamic matrix determined by trigger type:

- **Tag push** (`v*`): ARM64 macOS only on self-hosted runner (free, fast)
- **Manual dispatch** (`workflow_dispatch`): all platforms — ARM64 macOS (self-hosted), Intel macOS (`macos-13`), Linux x64 (`ubuntu-22.04`)

Three-job structure in `.github/workflows/release.yml`:
1. `prepare` — reads version, outputs build matrix JSON
2. `build` — matrix job, each platform builds + uploads to S3 independently
3. `release` — downloads all artifacts, creates/updates GitHub Release

The `scripts/create-release-artifacts.sh` interface changed from `<arch>` to `<os> <arch>` to support Linux (no DMG, different bundle structure).

## Risks

- `macos-13` is the last Intel macOS runner from GitHub. If deprecated, fallback is Rosetta on ARM64 or cross-compilation.
- Linux Electrobun build with `bundleCEF: false` relies on WebKitGTK; the `version.json` path inside Linux bundles is not well-documented — the script uses `find` as fallback.
- Ubuntu 22.04 ships `libwebkit2gtk-4.0`; if Electrobun requires 4.1, may need Ubuntu 24.04.

## Alternatives considered

- **Two separate workflows** (one for ARM64, one for cross-platform): simpler per-file but duplicates shared steps and complicates GitHub Release management.
- **Always build all platforms**: rejected because GitHub-hosted macOS costs ~$0.08/min and most version bumps don't need Intel/Linux builds.
