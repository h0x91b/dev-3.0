# Staged host version-skew harness (seq 1248)

Proof harness for the **version-skew + immutable-host-image** slice of the
tmux-removal roadmap (parent seq 1141; RUN-004 / HOST-006). It answers one
question with real processes and focused units:

> When an app update installs a new native terminal host image, what happens to
> a session an *older* host already owns — and to a client that speaks the wrong
> protocol version?

The rule it proves: **an update may stage a new host image, but an existing
session stays owned by its original, compatible host until it ends. An
incompatible client fails clearly; it never kills, replaces, or takes over the
live session, and rollback selects a compatible staged image explicitly — never
by guessing, never by falling back to tmux.**

This is a sibling harness inside `native-terminal-registry/`; it reuses that
module's **frozen** protocol hello/version boundary (`protocol.ts`) and is
covered by the registry's `isolation.test.ts` (absent from the production import
graph, no prototype imports, no tmux). It changes no production code.

## Roles

| File | Role |
|------|------|
| `image-manifest.ts` | Frozen, versioned image manifest + strict parse (unreadable-and-not-ours for a foreign schema). |
| `staging.ts` | Immutable on-disk staging: stage (refuse-overwrite), read with ok/missing/partial verdicts, list, content fingerprint. |
| `rollback.ts` | Explicit compatible-image selection — never newest, never nearest, never a tmux fallback; read-only. |
| `version-skew.ts` | `evaluateHelloAtVersion` (the frozen boundary generalised by the host's own version) + the compact verdict matrix. |
| `session-record.ts` | Small discovery record a running staged host publishes (image tag, protocol version, host/shell PID, pane id, endpoint — token-free). |
| `staged-host-runtime.ts` | Detached host launched from an immutable image; owns one `Bun.Terminal` shell, answers hello at its image's protocol version. |
| `lab.ts` | Stage the two standard images, launch a detached host from an image, and a versioned lab client speaking an arbitrary protocol version. |

## On-disk layout

A staging root (a tmpdir in tests) holds one immutable directory per image:

```
<stagingRoot>/<tag>/
  image.json      # manifest (immutable, mode 0400)
  entrypoint.mjs  # generated launch shim (immutable, mode 0500) — bun re-enters it
```

Two images differ by tag + baked-in protocol version, so their entrypoint files
are genuinely distinct. Staging a new image never rewrites an existing one; the
only way to "replace" a host is to stage a new tag. A running session's
discovery record + private token live under a separate per-session state dir.

## Invariants

- **Immutable images.** `stageHostImage` refuses to overwrite an existing image
  (`HostImageAlreadyStagedError`). `fingerprintImage` proves an image is
  byte-identical after a newer image is staged beside it — no in-place
  executable replacement.
- **Per-image entrypoint.** A host records the `argv[1]` it was launched with;
  it must resolve to its own image's entrypoint (`sameNativeTerminalPath`),
  never another image's file.
- **One boundary, generalised.** `evaluateHelloAtVersion(text, id, hostVersion)`
  is proven byte-identical to the frozen `evaluateHello` at the current protocol
  version (`version-skew.test.ts`). A foreign-version hello gets exactly one
  explicit `version-mismatch` error and only that socket closes — host, shell,
  pane, and shell state stay alive.
- **Explicit rollback.** `selectImageForProtocol` returns the single image at
  that version, or `no-compatible-image` / `ambiguous`. It never guesses a
  "closest" version, never mutates metadata, and never falls back to tmux.
- **Honest diagnostics.** Missing and partially-staged images read as `missing`
  / `partial` (naming what is absent); launching one fails rather than
  half-booting, and destroys no live session.

## Version/session verdict matrix

See [`VERSION-SESSION-MATRIX.md`](VERSION-SESSION-MATRIX.md). `buildSkewMatrix` /
`renderSkewMatrix` generate it, and the e2e asserts its live observations match
each row.

## Tests

- `bun run test:native-host-images-e2e` — the real-runtime lifecycle proof
  (`__tests__/lifecycle.bun-e2e.ts`): two immutable images, incompatible-client
  rejection with the old session fully preserved, compatible reattach, a new v2
  session running alongside the old v1 session with no in-place replacement or
  PTY takeover, explicit rollback, missing/partial diagnostics, and the tmux
  sentinel. Expected final line: `ALL CHECKS PASSED`.
- `__tests__/*.test.ts` — cross-platform vitest units (part of `bun run test`):
  manifest parse, immutable staging + diagnostics, explicit rollback selection,
  the boundary parity + verdict matrix, and the session record.

See [decision 161](../../../../decisions/161-staged-host-version-skew.md).
