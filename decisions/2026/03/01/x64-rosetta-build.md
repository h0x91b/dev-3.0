# 007: x64 macOS build via Rosetta on ARM runner

## Context

The app only shipped arm64 (Apple Silicon) builds. Intel Mac users couldn't run it. We needed to add x64 artifacts to each release without paying for a separate x64 CI runner.

## Investigation

Two options were considered:

1. **GitHub-hosted x64 macOS runner** — easy but expensive ($0.12/min for macOS), and would require duplicating secrets and the signing workflow.
2. **Same self-hosted ARM runner + Rosetta 2** — free, uses `arch -x86_64` to run the entire build under x86_64 emulation. Needs a separate x64 Bun binary.

Option 2 was chosen because the runner is already available and Rosetta handles x64 execution transparently on Apple Silicon.

## Decision

The release workflow (`.github/workflows/release.yml`) now runs two sequential build phases in a single job:

1. **arm64 (native)**: unchanged `bun` + `electrobun build`
2. **x64 (Rosetta)**: `arch -x86_64 $HOME/.bun-x64/bin/bun` + `electrobun build`

Between phases, `node_modules` is wiped and reinstalled under x64 to get correct native dependencies.

The ~120-line artifact creation logic was extracted into `scripts/create-release-artifacts.sh` accepting `ARCH` as a parameter. Both phases call it, outputting to `./artifacts-arm64/` and `./artifacts-x64/` respectively, then merged into `./artifacts/` for upload.

Key code paths:
- `scripts/create-release-artifacts.sh` — artifact creation (DMG, tar.zst, update.json)
- `.github/workflows/release.yml` — two-phase build orchestration

## Risks

1. **Rosetta + Electrobun is untested upstream.** Electrobun docs say "build on native platform" but their Windows builds use cross-arch VMs. Under Rosetta the system reports x86_64, so Electrobun should produce valid x64 artifacts. First release will confirm.

2. **node_modules must be fully cleaned between phases.** Native deps (like zig-zstd) are arch-specific. Leftover arm64 modules would cause a broken x64 build.

3. **Build time roughly doubles** (~10-20 min total). Acceptable for a release workflow that runs infrequently.

4. **zig-zstd x64 binary runs under Rosetta** in the fallback (Case 2) artifact path. macOS handles this transparently for Mach-O binaries.

## Alternatives considered

- **Matrix strategy**: would schedule two jobs but GitHub serializes them on a single runner anyway. A single job is simpler and avoids artifact aggregation complexity across jobs.
- **Cross-compilation**: Electrobun doesn't support cross-compilation for macOS. Would require patching Electrobun internals.
- **Universal binary (fat binary)**: Electrobun doesn't support `lipo`-merged builds. Would require post-processing that's fragile and untested.
