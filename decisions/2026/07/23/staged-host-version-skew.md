# 161 — Staged host version skew & immutable host images

## Context

Seq 1248 (parent 1141, tmux-removal roadmap) owns the version-skew and
immutable-host-image slice of RUN-004 / HOST-006. Before a production terminal
backend is selected, we need evidence for the smallest safe update rule for a
detached native terminal host: an app update may install a *new* host image, but
an existing session stays owned by its original compatible host until it ends; an
incompatible client must fail clearly without killing, replacing, or taking over
the live session; and rollback must select a compatible staged image explicitly,
never guessing or falling back to tmux.

## Decision

A new proof harness under `src/bun/native-terminal-registry/host-images/`,
co-located inside the registry so it reuses the **frozen** protocol hello/version
boundary (`protocol.ts`) rather than forking it, and inherits the registry's
`isolation.test.ts` (absent from the production import graph, no prototype
imports, no tmux). It changes no production registry/protocol code.

- **Immutable images (`staging.ts`).** Each staged image is its own directory
  holding `image.json` (frozen, versioned manifest) + a generated launch shim.
  `stageHostImage` refuses to overwrite an existing image; the only "replace" is
  a new tag. `fingerprintImage` proves an image is byte-identical after a newer
  one is staged beside it, and a host records the `argv[1]` it launched with, so
  it is provably running its own image's entrypoint — no in-place executable
  replacement.
- **Generalised boundary (`version-skew.ts`).** `evaluateHelloAtVersion(text,
  sessionId, hostVersion)` is the frozen `evaluateHello` parameterised by the
  host's own version, proven byte-identical at the current protocol version
  (parity test). A foreign-version hello gets one explicit `version-mismatch`
  and only that socket closes; host, shell, pane, and shell state survive.
- **Explicit rollback (`rollback.ts`).** `selectImageForProtocol` returns the
  single image at that version, or `no-compatible-image` / `ambiguous`. It never
  picks "newest"/"closest", never mutates metadata, never falls back to tmux.
- **Honest diagnostics.** `readStagedImage` returns `ok` / `missing` / `partial`;
  launching an incomplete image fails rather than half-booting and destroys no
  live session.

The real-process proof is `__tests__/lifecycle.bun-e2e.ts`
(`bun run test:native-host-images-e2e`); cross-platform vitest units cover the
pure layer and the compact version/session verdict matrix.

## Risks

The staged shim imports the shared host runtime by an absolute path resolved at
staging time — fine for an in-repo proof run, not a packaging strategy (a real
image would be a self-contained bundle). Modelling protocol "v2" needs no wire
break: the boundary is version-parameterised and the lab client speaks an
arbitrary version, so skew is exercised without bumping the frozen v1 constant.
The e2e drives a real interactive shell, so it is gated behind its own script
(not the default `bun run test`), like the other native e2es.

## Alternatives considered

A standalone module outside the registry was rejected: it could not import the
frozen `evaluateHello`/`decodeHello` without tripping the registry's
import-graph isolation guard, and the ticket explicitly requires "the existing
protocol hello/version boundary". Reusing the registry's heavy `host.ts` (v1
hardcoded) was rejected — a compact version-parameterised host keeps the proof
readable and lets both host versions share one runtime. An in-memory model was
rejected for criteria that need real process/PTY evidence (shell PID alive, no
live takeover), while the pure layer stays fully unit-tested.
