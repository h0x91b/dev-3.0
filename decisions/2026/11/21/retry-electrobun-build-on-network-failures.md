# Retry `electrobun build` when, and only when, it failed on the network

## Context

All 148 red Canary publish runs (2026-08-14 … 2026-11-21) were classified from their logs. 58 failed on the network. Two buckets sit inside `electrobun build` itself: macOS `xcrun stapler staple` losing its connection to Apple after notarization succeeded (`NSURLErrorDomain Code=-1005`, 40 runs), and GitHub release downloads of the electrobun CLI, core binaries or the bundled Bun returning 5xx or dropping the socket (9 runs). Together that is a third of all red canaries, and each one costs a ~30-minute rerun.

## Investigation

Both failures happen inside electrobun's compiled CLI, so neither the download nor the stapler call can be wrapped on its own. electrobun deletes and recreates the build folder at the start of every `build` (`rmSync(buildFolder)` before anything is bundled), so running the whole command again is idempotent.

## Decision

`scripts/electrobun.ts`, already the only entry point to the CLI (`decisions/2026/11/21/strip-pwsh7-module-paths-for-electrobun.md`), tees the CLI's output and keeps its last 64 KB. On a non-zero exit, `scripts/network-retry.ts` looks for a known network signature. Only when one matches does it sleep 30s and run the build again, up to 5 attempts in total. Every retry is logged as a `::warning::` that quotes the matched line. Any other failure (an Apple 403, a test assertion, a full disk, a 404) is final on the first attempt. Each signature in `NETWORK_FAILURES` is a line copied from a real red run, and `src/bun/__tests__/network-retry.test.ts` pins both the positive and the negative cases.

## Risks

A retry after a stapler failure repeats code signing and notarization, which adds a few minutes per attempt. That is still far cheaper than a full canary rerun. A new network error phrasing will not be retried until it is added to the list, which errs on the side of failing visibly. Piping the output means the CLI no longer sees a TTY.

## Alternatives considered

- Retry the whole job or workflow: this retries real failures too and hides them.
- Cache the downloads in CI with `scripts/electrobun-binary-cache.ts`: this complements the retry and removes most downloads, but it does nothing for the stapler, the largest bucket.
- Staple again from `create-release-artifacts.sh` after the build fails: the archive is produced after stapling, so the recovery path would have to re-implement electrobun's packaging.
