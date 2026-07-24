# 164 — Native terminal host artifact manifest generator

## Context

RUN-006 (a slice of the tmux-removal roadmap, seq 1141) needs a staged native
terminal host artifact to be described by a deterministic, verifiable manifest
before any packaging/signing/update step consumes it. This task builds only that
manifest generator + validator, decoupled from packaging, signing, updating, and
runtime selection. The generator is unused by production.

## Decision

New standalone module `scripts/native-terminal-host-manifest/`:
`manifest.ts` (pure core), `generate.ts` (Bun CLI), `__tests__/`. It emits
byte-stable JSON — schema version, host/protocol/Bun versions, OS, arch,
entrypoint, and per-file `{path, size, sha256}` — and `validateManifest()`
re-checks an artifact directory. Rejections surface as one `ManifestError` with a
compact typed `code` (`missing`/`partial`/`path-traversal`/`duplicate`/
`incompatible-schema`/`checksum-mismatch`, plus `not-regular`/`empty-file`/
`invalid-metadata`/`invalid-entrypoint`/`no-files`).

Determinism: no clock is read, paths are normalized to POSIX and sorted by
code-unit order, and output is independent of declared-file order and filesystem
enumeration order. `os`/`arch` mirror `process.platform` / `process.arch`
(`win32|darwin|linux`, `x64|arm64`). `missing` vs `partial` follows the existing
`host-images/staging.ts` vocabulary (absent root = missing; present root with
absent declared files = partial).

## Investigation

`scripts/` is outside all three vitest roots (`src/mainview`, `src/bun`,
`src/cli`) and outside `tsconfig.json`'s `include: ["src"]`, and the task forbids
editing `package.json`. So the tests use **Bun's own runner** (`bun:test`) and are
run with `bun test scripts/native-terminal-host-manifest/` — they intentionally do
NOT run under `bun run test`/`bun run lint` or in CI (the task also forbids adding
a CI check). Type-check the module directly with
`bunx tsc --ignoreConfig --noEmit --strict ... manifest.ts generate.ts`.

## Risks

Tests are not wired into CI, so a regression here is caught only by running the
Bun test command above. Acceptable while the module is production-unused; when a
packaging step starts consuming it, wire the tests into a checked path then.

## Alternatives considered

- A 4th vitest project/root for `scripts/` — rejected: needs a `package.json`
  script (forbidden) or a shared-config edit outside this task's isolation.
- Committing on-disk fixture files + golden JSON — rejected: line-ending/checkout
  drift would poison committed checksums; data-table fixtures materialized into
  tmpdirs are more robust and match the "temporary fixture directories" rule.
