# Raise the staged bifrost binary's declared macOS minimum

## Context

Every macOS **x64** canary publish started failing the moment the model-catalog proxy
landed (#1391, `983a8646b`, 2026-08-20 17:06 UTC). Apple's notary returned status
`Invalid`, `statusCode 4000`, one issue:

```
path:    dev-3.0-canary.app.zip/dev-3.0-canary.app/Contents/Resources/app/bifrost/bifrost-http
message: The binary uses an SDK older than the 10.9 SDK.
```

A single nested binary fails the whole archive, so `.app.tar.zst` was never produced
and the job died in `create-release-artifacts.sh`. arm64, Linux and Windows were
unaffected.

## Investigation

`otool -l` on the pinned vendor downloads:

| Target | Version load command | Declares |
|---|---|---|
| `darwin/amd64` v1.6.10 | `LC_VERSION_MIN_MACOSX` | version 10.4, **sdk 10.4** |
| `darwin/amd64` v1.6.11 | `LC_VERSION_MIN_MACOSX` | version 10.4, **sdk 10.4** |
| `darwin/arm64` v1.6.10 | `LC_BUILD_VERSION` | minos 11.0, sdk 11.0 |

So it is the vendor's amd64 toolchain, not our packaging, and bumping the pin does
not help — v1.6.11 has the identical header. The binary is unsigned, so there is no
signature to invalidate by editing it.

## Decision

`scripts/stage-bifrost.ts` raises the declared minimum to **10.15** on the staged
copy (`dist/bifrost/`), using `raiseMinMacOSVersion` in `src/bun/macho-min-version.ts`.
10.15 rather than Apple's 10.9 floor because Go's own darwin/amd64 runtime requires
10.15 — declaring less would be a lie the loader could act on.

Two design points:

- **The staged copy, never `vendor/`.** `fetch-bifrost.ts` keeps checking the pristine
  download against `scripts/bifrost-pinned.json`, so the supply-chain pin stays honest.
- **Two uint32s in place, not `vtool`.** `vtool -set-version-min` reaches the same
  declared version but reorders the load-command table (311 bytes differ on the real
  binary); `vtool -replace` swaps in a 32-byte `LC_BUILD_VERSION` and needs headerpad.
  Our edit changes 2 bytes, moves no offset, and needs no Xcode CLT. Verified with
  Apple's own `otool -l`, and the patched binary still runs (`--help`, exit 0).

## Risks

- Intel macOS older than 10.15 would refuse to load the sidecar. Not a real loss: the
  Go runtime inside it already requires 10.15.
- If the vendor later ships a proper `LC_BUILD_VERSION`, the patch becomes a silent
  no-op — `raiseMinMacOSVersion` returns null and nothing is written.
- The real proof is a notary round trip, which only CI can run.

## Alternatives considered

1. **Bump the pin** — checked, v1.6.11 has the same 10.4 header.
2. **Drop the sidecar on darwin-x64** — kills the model catalog for every Intel Mac.
3. **Build bifrost from source in CI** — needs a Go toolchain per runner and throws away
   the checksum pin, for a two-byte header field.
4. **Upstream fix** — asked for separately if it comes to that; it cannot unblock today's
   releases.
