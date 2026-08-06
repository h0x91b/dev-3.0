# 169 — Package the versioned native host image inside the Windows archive

## Context

RUN-006 / WIN-004 (parent seq 1141, tmux removal) needed the packaged-runtime
proof and the deterministic artifact manifest to become a real, versioned host
image that ships inside the production Windows update archive — installable on
demand, outside the replaceable application directory, without enabling the
native backend. tmux stays the production default and its packaged artifacts are
untouched.

Two manifests already existed and described the same artifact from different
angles: `image-manifest.ts` (immutable identity: tag, protocol version,
entrypoint, runtime floor) and the `scripts/` artifact manifest (deterministic
per-file size + SHA-256, Bun version, OS/arch). Neither knew where the image sits
inside an archive, and the artifact manifest lived outside `tsconfig.json`'s
`include` and outside every vitest root, so it was neither type-checked nor run
in CI.

## Investigation

Electrobun's hook order settles where the image can be built
(`node_modules/electrobun/src/cli/index.ts`): `postBuild` runs at line 3435,
`createTar` at 3761, `postPackage` at 4243. The packaged Bun runtime only exists
inside the build directory, and only content written under the app bundle before
`createTar` reaches the archive. So the image must be assembled in `postBuild`,
into the bundle directory that becomes the archive's top-level entry — which is
also why `archiveRoot` is recorded relative to that bundle root rather than to
the tarball root.

## Decision

- **Merged manifest** — `host-images/packaged-image-manifest.ts` embeds the
  artifact manifest under `artifact` and adds `tag`, `runtimeFloor`,
  `runtimeCarrier`, and `archiveRoot`. `validatePackagedHostImageManifest`
  re-verifies sizes, SHA-256s, entrypoint, carrier, runtime floor, tag shape,
  archive path, and caller expectations (OS/arch/Bun/protocol/tag) as typed
  `ManifestError` codes. No clock is read, so the manifest is byte-stable.
- **Content-derived tag** — `<bunVersion>-p<protocolVersion>-<digest12>`. Two
  builds of the same bytes agree; a changed entrypoint lands beside the old image
  instead of replacing it.
- **Assembly at `postBuild`, verification at `postPackage`** — the real
  `electrobun.config.ts` gained `postPackage`; `scripts/verify-packaged-windows-conpty.ts`
  assembles + validates on the way in and, in archive mode, discovers the shipped
  image, stages it, drives detached start / reattach / stop with no Bun on PATH,
  then stages a second image beside the live one and asserts the old one is
  byte-identical and still selectable for rollback.
- **Staging root outside the install directory** —
  `hostImagesRootDir()` = additive `~/.dev3.0/native-host-images/`
  (`DEV3_NATIVE_HOST_IMAGES_DIR` override). `stagePackagedImage` copies into a
  dot-prefixed scratch directory (invisible to every reader), validates, then
  moves it into place; an existing tag is never overwritten and a corrupt copy is
  discarded and reported.
- **Manifest module moved into `src/`** — `scripts/native-terminal-host-manifest/manifest.ts`
  became `host-images/artifact-manifest.ts`, its CLI logic
  `artifact-manifest-cli.ts` (the `scripts/` file is now a thin shim). It is now
  type-checked by `bun run lint`, runs under `bun run test`, and is gated in CI
  via `bun run test:native-host-image`.

## Risks

- The new `windows-app-archive` CI job builds the real Windows package, which is
  a heavier and less-exercised path than the tracer fixture; a failure there can
  be an Electrobun packaging problem rather than a host-image problem. The proof
  JSON names which stage failed.
- Assembly needs `ELECTROBUN_APP_VERSION`, so the script only works as an
  Electrobun hook, not standalone.
- Windows code signing and uninstall are still **not** covered: Electrobun has no
  Windows signing path and this change invented no credentials, so the RUN-006
  signing/uninstall gap remains open. The image is unsigned, exactly like the rest
  of the Windows package.

## Alternatives considered

- **Assemble into `dist/native/` and rely on a copy rule** — rejected: the
  packaged Bun runtime does not exist at that point, so dev3 would have to
  download and pin a second Bun itself.
- **Assemble on first launch from the installed package** — rejected: then the
  image is not *in* the archive, so nothing can be verified at build time.
- **Keep the two manifests separate and validate twice** — rejected: the archive
  path has to be checked against the same file table it describes, and two
  independent schemas would drift.
- **A fourth vitest project rooted at `scripts/`** — rejected: moving the module
  into `src/` gets type-checking and CI for free (this supersedes the
  "not wired into CI" risk recorded in decision 164).
