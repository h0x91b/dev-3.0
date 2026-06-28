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

## Risks / known gap (D2)

**The release pipeline does not yet publish `stable-linux-arm64-dev-3.0.tar.zst`**
(nor the linux-arm64 CLI tarball / brew bottle). `release.yml` builds only
`linux-x64`. So on arm64, `dev3 gui` will resolve the correct URL and 403/404 until
a `build-linux-arm64` job is added (needs an `ubuntu-24.04-arm` runner + a check
that Electrobun produces a working linux-arm64 launcher). This change is the
forward-compatible CLI half: once the artifacts ship, `dev3 gui` on arm64 works
with no further code change.

## Alternatives considered

Hard-blocking arm64 in the CLI until D2 lands — rejected: it would couple the CLI
to release state and need removal later. The arch-aware URL + friendly 404 hint is
forward-compatible and degrades gracefully today.
