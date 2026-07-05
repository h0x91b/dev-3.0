# 107 — Mach-O load-command surgery to survive codesign (Intel launch crash)

## Context

Every macOS x86_64 release since v1.13.0 segfaulted on launch for Intel users (issue #563). Electrobun's Zig-built binaries (`extractor`, `launcher`, `libasar.dylib`) ship unsigned with zero/near-zero headerpad: load commands end exactly where `__text` begins. When our release pipeline signs them (`codesign --force --options runtime`, run by `electrobun build`), Apple's codesign has no room for the 16-byte `LC_CODE_SIGNATURE` load command and **silently writes it over the first bytes of `__text`**. Hashes are computed over the corrupted bytes, so signing, notarization, and Gatekeeper all pass — the binary just crashes.

## Investigation

Reproduced deterministically: pristine upstream extractor runs under Rosetta; after one `codesign -s - --force` it segfaults at `fs.path.resolve + 5` (the clobbered bytes decode as `sbb eax, imm32; add [rax], al`, hence fault addresses always below 4 GB). arm64 is immune because Zig's linker emits a mandatory ad-hoc `LC_CODE_SIGNATURE` there, so codesign replaces it in place. Known upstream: ziglang/zig#23704 (fix PR pending on Codeberg), reported to Electrobun as blackboardsh/electrobun#485. Headerpad cannot be retrofitted post-link (would shift section vmaddrs), so any signer hits the same wall — `rcodesign` errors out, Apple's tool corrupts.

## Decision

Pre-build "surgery" plus a post-build gate, both in `release.yml` (mac jobs):

1. `scripts/fix-macho-headerpad.ts fix` (logic in `src/bun/macho-headerpad.ts`) rewrites the droppable, same-size (16 B) `LC_SOURCE_VERSION` command into an `LC_CODE_SIGNATURE` pointing at a reserved slot appended to `__LINKEDIT` (minimal valid SuperBlob). With a pre-existing slot, codesign re-signs in place — same mechanism that keeps arm64 safe. Runs on `node_modules/electrobun/dist-macos-*` before `electrobun build` (pre-fetching the core tarball, since electrobun downloads it only during build).
2. `... verify` + a launcher smoke run gate the built artifacts: fails the job if any Mach-O has load commands overlapping section content, or if the launcher stub dies with a signal. The x64 job runs on a native Intel runner, exercising the exact crashing path.

## Risks

- The surgery consumes `LC_SOURCE_VERSION`; if a future electrobun binary lacks it, `fix` fails loudly (build goes red, no silent corruption). The reserved `LC_CODE_SIGNATURE` sits mid-list rather than last — kernel, codesign, and Gatekeeper accept this (verified: signed binaries run and `codesign -vv` passes), but exotic tooling could assume it is last.
- The fix step self-disables (no-op) once upstream ships pre-padded/pre-signed binaries; remove it after bumping to a fixed electrobun. The verify gate should stay permanently — this bug class is invisible to signing, notarization, and green CI.

## Alternatives considered

- **Wait for upstream** (zig default-headerpad PR → zig release → electrobun rebuild → our bump): weeks-to-months while every x64 release ships dead on arrival.
- **Rebuild the Zig binaries from source in CI**: duplicates upstream work, drags a pinned Zig toolchain + electrobun's build deps into our pipeline.
- **`-headerpad` via post-link tooling**: impossible — no tool can add headerpad to a linked Mach-O without relinking.
