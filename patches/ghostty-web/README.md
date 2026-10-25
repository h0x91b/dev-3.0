# Pinned terminal core repair

The local `ghostty-web-0.4.0-dev3.1.tgz` preserves the published 0.4.0 JavaScript API and declarations, includes the existing ESM disposal patch, and replaces its WASM core with a two-site page-zeroing repair. `core-manifest.json` pins the source, compiler, patches, original npm integrity and resulting binary/archive hashes. The dependency is installed from this committed archive; end users and CI do not need Zig or network access to rebuild it.

The original core assumes newly allocated pages contain zeros. Zig's freestanding WASM allocator can return dirty freed memory, including during reflow inside the first terminal. `page-zeroing.patch` clears both allocation paths even in ReleaseSmall. See [the decision record](../../decisions/2026/10/25/zero-reused-terminal-wasm-pages.md) for proof level, alternatives and remaining uncertainty.

## Rebuild and verify

Run from the repository root with Bun 1.3.14, `tar` and `patch`. The recipe downloads hash-verified source/toolchain archives into ignored `artifacts/ghostty-core-build/`, creates fresh generated build directories there, and compiles only `lib-vt`. macOS arm64 is the verified rebuild host; pinned macOS x64 and Linux toolchains must produce the same hash or the script rejects their output. Windows consumes the same platform-independent package without building it.

```sh
bun scripts/ghostty-core/build.ts --baseline
bun scripts/ghostty-core/build.ts
curl --fail --location https://registry.npmjs.org/ghostty-web/-/ghostty-web-0.4.0.tgz \
  --output artifacts/ghostty-core-build/inputs/ghostty-web-0.4.0.tgz
bun scripts/ghostty-core/package.ts \
  --manifest patches/ghostty-web/core-manifest.json \
  --upstream-tarball artifacts/ghostty-core-build/inputs/ghostty-web-0.4.0.tgz \
  --wasm artifacts/ghostty-core-build/outputs/zeroing.wasm
bun install --frozen-lockfile --ignore-scripts
bun scripts/ghostty-core/verify-package.ts \
  --manifest patches/ghostty-web/core-manifest.json \
  --upstream-tarball artifacts/ghostty-core-build/inputs/ghostty-web-0.4.0.tgz \
  --installed-dir node_modules/ghostty-web
bun x vitest run src/mainview/__tests__/ghostty-core.test.ts \
  src/mainview/__tests__/terminal-dispose.test.ts
```

An existing authorized npm mirror can supply the pristine tarball instead; its SHA-512 must match the manifest. Packaging reconstructs every file from those verified bytes. It replaces both standalone WASM files **and both embedded data URLs**: application `init()` loads the ESM payload, so changing standalone files alone is ineffective. The original `../ghostty-web@0.4.0.patch` remains an active packaging input; it is no longer applied by Bun's `patchedDependencies`. No wrapper JavaScript is rebuilt and no runtime monkeypatch is installed.

The output uses sorted ustar entries, fixed ownership/modes/timestamps and normalized gzip metadata. The verifier checks exact file contents, canonical encoding, all four identical WASM payloads and unchanged WASM import/export descriptors. An independent fresh install and default-loader tests additionally verify delivery. A different compressor implementation may produce a different archive; do not accept a new hash without inspecting the contents and repeating verification.

## Updating this repair

Keep source changes and generated delivery together. For a deliberate new repair, review the source patch, update input/output hashes, increment the local `0.4.0-dev3.N` version and archive name, regenerate the package, update the root dependency/lockfile, and rerun semantics plus disposal tests. Temporarily omit `archiveSha256` only while generating a newly reviewed archive, then record its hash and verify again. Retain exactly one active archive.

The test runner executes bounded synthetic cases in child processes because a same-thread timeout cannot interrupt WASM. Baseline traps, stale text and a style-heavy resize hang become passing tests with this repair, in both V8 and JavaScriptCore. They are not reproductions of the reported macOS incident. A separate pre-existing combining-mark defect at the exact right margin remains outside this patch; the original 40-column fixture checks completion, while a 42-column variant asserts correct text.
