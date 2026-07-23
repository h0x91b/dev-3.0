# 161 — Backend-neutral terminal parity corpus (MIG-001)

## Context

The tmux-removal roadmap (seq 1141) needs the externally visible terminal
behaviors frozen *before* a product-level backend seam exists, so a future
native `Bun.Terminal` backend can be measured against the same contract
(roadmap MIG-001 → CUT-001). The risk: capturing behavior in tmux terms would
force the native backend to emulate tmux quirks, and adding the seam now would
violate the roadmap's "seam only after the native adapter exists" rule (MIG-002).

## Decision

Add a **test-only, isolated** module `src/bun/terminal-parity/` (no production
importer; guarded by `__tests__/isolation.test.ts`):

- `corpus.ts` — frozen, data-driven scenarios in product vocabulary (11 verbs +
  5 negatives), each classified `required` vs `intentional-difference`,
  `live`/`pure`/`gap` verification, platform, and the roadmap items it protects.
  No tmux argv or `#{}` format strings leak into cases (statically asserted).
- `runner.ts` — `ParityRunner`, a **test harness** shape (deliberately *not* a
  product `TerminalBackend`). A native runner implements the same shape later.
- `checks.ts` — reusable, framework-neutral executable checks (one per live/pure
  scenario) driven through any `ParityRunner`.
- `tmux-runner.ts` — `ParityRunner` over a real tmux server via the typed
  `TmuxClient` (node:child_process spawn seam, as in the live client e2e).
- Live e2e proves the current tmux backend satisfies every `live` scenario;
  excluded from the fast suite, `skipIf(!tmux)`, platform-marked.

The corpus (`protects`) is the source of truth for the scenario→roadmap map;
`corpus.test.ts` fails if `scenario-roadmap-map.md` drifts.

## Risks

- The live e2e needs tmux on PATH; it skips otherwise, so a machine without tmux
  gets no live proof (acceptable — CI has tmux, and `corpus.test.ts` still runs).
- Three behaviors are recorded as `gap` (exit status-code, owned process-tree
  reaping, single-writer duplicate-attach) because they ride the Bun PTY /
  process-reaper paths above `TmuxClient`; they are documented, not faked.

## Alternatives considered

- **Extend `tmux/__tests__/client.test.ts`** — rejected: that suite tests tmux
  argv/format grammar, the opposite of backend-neutral, and MIG-001 explicitly
  says not to duplicate it.
- **Introduce the `TerminalBackend` seam now and test through it** — rejected:
  violates MIG-002 (seam only after the native adapter exists) and the ticket's
  scope boundary. The test-only `ParityRunner` gives reuse without a prod seam.
