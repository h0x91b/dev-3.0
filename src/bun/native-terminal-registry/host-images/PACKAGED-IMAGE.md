# Packaged native terminal host image (RUN-006 / WIN-004)

The **packaged** host image is the versioned, immutable launch artifact that
ships inside the dev3 Windows update archive. It is distinct from the
version-skew *lab* image described in [`README.md`](README.md): the lab stages a
generated shim that imports the TypeScript runtime, the packaged image carries
real bytes — the Bun runtime carrier plus the bundled host entrypoint.

tmux remains the production default. Packaging an image starts nothing and
writes no session state; every staging operation is additive file work.

## Layout

```
<packageRoot>/native-host-image/<tag>/
  dev3-terminal-host.exe   # the packaged Bun runtime carrier (also the process image name)
  dev3-terminal-host.js    # the bundled host entrypoint
  host-image.json          # the MERGED manifest, written last
```

`<tag>` is `<bunVersion>-p<protocolVersion>-<digest12>`, derived from the image's
own bytes. Identical inputs → identical tag and byte-identical manifest; changed
inputs → a new tag beside the old one. Nothing is ever rewritten in place.

## The merged manifest

`packaged-image-manifest.ts` merges the two manifest layers that used to be
separate, and adds the one fact only packaging knows:

| Field | From |
|---|---|
| `tag`, `runtimeFloor`, `runtimeCarrier` | image identity (`image-manifest.ts` lineage) |
| `artifact.files[].{path,size,sha256}`, `artifact.{hostVersion,protocolVersion,bunVersion,os,arch,entrypoint}` | deterministic file table (`artifact-manifest.ts`) |
| `archiveRoot` | the POSIX path the image occupies inside the update archive |

`validatePackagedHostImageManifest(raw, imageRoot, expectations)` re-checks every
file's size and SHA-256, the entrypoint, the runtime carrier, the runtime floor,
the tag shape, the archive path, and any expected OS/arch/Bun/protocol/tag.
Failures are typed `ManifestError` codes — no clock is read anywhere.

## Operations (`packaged-image.ts`)

| Function | Role |
|---|---|
| `assemblePackagedImage` | Build the image inside the app bundle at package time (Electrobun `postBuild`). Deterministic and idempotent: an identical existing image is validated and reused, never rewritten. |
| `discoverPackagedImage` | Find the shipped image in an installed package or extracted archive. `ok` / `absent` / `partial` / `ambiguous`, each with a message that names the missing build step. |
| `stagePackagedImage` | Copy the image, additively, into a staging root **outside** the replaceable installation directory. An already-staged tag is returned untouched; a corrupt fresh copy is discarded and reported. |
| `listPackagedImages` / `selectPackagedImage` | Read-only listing and explicit rollback selection by tag or protocol version. Never picks a "closest" version. |
| `fingerprintPackagedImage` | Content fingerprint that proves an old image survived a newer one being staged beside it. |

The staging root is `hostImagesRootDir()` (`../paths.ts`): an additive
`~/.dev3.0/native-host-images/`, overridable with `DEV3_NATIVE_HOST_IMAGES_DIR`.

## Build + verification path

1. `bun run build:native` bundles `dist/native/dev3-terminal-host.js`.
2. Electrobun `postBuild` → `scripts/verify-packaged-windows-conpty.ts` assembles
   the image into the bundle, so it ships in the archive, and validates it.
3. Electrobun `postPackage` → `scripts/verify-windows-conpty-update-archive.ts`
   re-enters the same script against the **final `.tar.zst`**: discover, validate
   archive paths, stage outside the install root, start detached / reattach / stop
   with no Bun on PATH, then stage a second image beside the live one and prove
   the old image is byte-identical and still selectable for rollback.
4. Everything asserted lands in `windows-conpty-package-proof.json`.

## Artifact-manifest CLI

The standalone generator still exists for describing an arbitrary artifact
directory:

```sh
bun scripts/native-terminal-host-manifest/generate.ts \
  --root dist/native --entrypoint dev3-terminal-host.js \
  --host-version 1.40.0 --protocol-version 1 --bun-version 1.3.14 \
  --os win32 --arch x64 [--file ...] [--out manifest.json]
```

Exit codes: `0` ok, `1` a typed `ManifestError` (`[code] message` on stderr), `2`
a usage error. The logic lives in `artifact-manifest-cli.ts` so the contract is
covered in-process.

## Tests

```sh
bun run test:native-host-image   # also part of bun run test / test:bun and CI
```

See `decisions/169-packaged-windows-native-host-image.md`.
