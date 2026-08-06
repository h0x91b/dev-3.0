# 088 — `dev3 gui` Linux bundle URL is arch-aware (arm64 artifacts still pending)

## Context

`dev3 gui` on Linux lazily downloads a desktop bundle from S3. The URL was
hardcoded to `stable-linux-x64-dev-3.0.tar.zst`, so on an arm64 box (Graviton,
Ampere, Hetzner CAX, Raspberry Pi) it silently fetched the x64 bundle, which then
failed to exec with a cryptic wrong-arch error.

## Decision

`guiBundleUrl()` in `src/cli/commands/gui.ts` now derives the arch slug from
`process.arch` (`arm64` → `arm64`, everything else → `x64`) via
`linuxBundleArch()`. The compiled `dev3` binary reports the arch it was built for,
so an arm64 CLI resolves the arm64 bundle. `downloadToFile()` adds an arm64-specific
hint on a 403/404, pointing the user at `dev3 remote` (browser UI, arch-agnostic)
instead of a bare HTTP error.

## D2 — arm64 release job (now implemented, best-effort)

`release.yml` now has a `build-linux-arm64` job (runner `ubuntu-22.04-arm`) that
publishes the arm64 artifacts. It is deliberately **best-effort** so a new,
unproven target never blocks an x64/macOS release:

- **CLI tarball** (`dev3-cli-linux-arm64.tar.gz`) — `bun build --compile` is
  arch-portable with no Electrobun dependency, so it builds reliably and is staged
  *first*. This is what enables `brew install` + `dev3 remote` on arm64 — the core
  remote-Linux value.
- **GUI bundle** (`stable-linux-arm64-dev-3.0.tar.zst`) — produced by
  `electrobun build`, which depends on Electrobun shipping a linux-arm64 runtime.
  That step is `continue-on-error` + emits a `::warning::`; if it can't build, the
  release still ships the arm64 CLI and the GUI bundle is simply omitted (D1's 404
  hint then guides arm64 users to `dev3 remote`).
- The job has job-level `continue-on-error: true`; the release-notes and Homebrew
  Formula add the arm64 entries *conditionally* (only if the artifacts exist).

**Validation gap:** none of this can be exercised without pushing a real `v*` tag —
the first arm64 release is the test. The CLI half is low-risk; the GUI half hinges
on Electrobun 1.18.1 actually hosting linux-arm64 runtime binaries (its platform/
naming code supports the target, but the hosted artifacts weren't verifiable from
the dev machine). Once arm64 ships cleanly a few times, drop the job-level
`continue-on-error`.

## Alternatives considered

Hard-blocking arm64 in the CLI until D2 lands — rejected: it would couple the CLI
to release state and need removal later. The arch-aware URL + friendly 404 hint is
forward-compatible and degrades gracefully today.
