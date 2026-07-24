# native-terminal-host-manifest

Deterministic manifest **generator + validator** for a staged native terminal
host artifact. Groundwork for RUN-006 (tmux-removal roadmap). **Unused by
production** — it only *describes* an already-staged artifact directory; it does
not build, sign, upload, install, update, or select any runtime.

## Generate

```sh
bun scripts/native-terminal-host-manifest/generate.ts \
  --root dist/native \
  --entrypoint dev3-terminal-host.js \
  --host-version 1.4.0 --protocol-version 2 --bun-version 1.3.14 \
  --os win32 --arch x64 \
  [--file dev3-terminal-host.js --file conpty/conpty.dll ...] \
  [--out dist/native/manifest.json]
```

Without `--file`, every regular file under `--root` is enumerated. Output is
byte-identical for identical input, independent of declared-file order,
filesystem enumeration order, and file timestamps.

`--os` ∈ `win32 | darwin | linux`, `--arch` ∈ `x64 | arm64` (they mirror
`process.platform` / `process.arch`). Exit codes: `0` ok, `1` a typed
`ManifestError` (a `[code] message` line on stderr), `2` a usage error.

## Manifest shape

```jsonc
{
  "manifestSchemaVersion": 1,
  "hostVersion": "1.4.0",
  "protocolVersion": 2,
  "bunVersion": "1.3.14",
  "os": "win32",
  "arch": "x64",
  "entrypoint": "dev3-terminal-host.js",
  "files": [ { "path": "conpty/conpty.dll", "size": 8, "sha256": "..." }, ... ]
}
```

## Library API (`manifest.ts`)

- `generateManifest(input)` → `NativeHostManifest` (throws `ManifestError`).
- `serializeManifest(manifest)` → byte-stable JSON + trailing newline.
- `parseManifest(raw)` → strict parse (throws `incompatible-schema`).
- `validateManifest(raw, artifactRoot)` → re-verify every declared file is inside
  the root, present, regular, non-empty, and hashes to the recorded checksum.
- `enumerateArtifactFiles(root)` → sorted POSIX relative paths.

`ManifestError.code` ∈ `missing | partial | path-traversal | duplicate |
incompatible-schema | checksum-mismatch | not-regular | empty-file |
invalid-metadata | invalid-entrypoint | no-files`.

## Tests

`scripts/` is outside the vitest roots, so tests run under Bun's own runner:

```sh
bun test scripts/native-terminal-host-manifest/
```

Type-check the module directly (it is outside `tsconfig.json`'s `include`):

```sh
bunx tsc --ignoreConfig --noEmit --strict --skipLibCheck \
  --module ESNext --moduleResolution bundler --target ES2020 --lib ES2021 --types node \
  scripts/native-terminal-host-manifest/manifest.ts scripts/native-terminal-host-manifest/generate.ts
```

See `decisions/164-native-terminal-host-manifest-generator.md` for the rationale.
