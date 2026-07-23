# Terminal backend parity corpus (MIG-001, seq 1250)

A **backend-neutral, data-driven corpus** of the externally visible terminal
behaviors dev3 must preserve before tmux is replaced by a native
`Bun.Terminal` host. It freezes those behaviors in **product vocabulary**
(session, view, input, focus, capture, reconnect, …) so the *same* corpus can
later run against a native backend, and proves the **current tmux backend**
satisfies them today.

This is a **test artifact only**. It introduces no production `TerminalBackend`
interface, no backend selection, no persisted backend identity, and no UI/RPC.
Nothing in the app or CLI import graph references it (guarded by
`__tests__/isolation.test.ts`).

## Files

| File | Role |
|------|------|
| `corpus.ts` | The frozen scenario data: 11 vocabulary verbs + 5 negatives, each with a stable id, `required`/`intentional-difference` classification, `live`/`pure`/`gap` verification, platform, and the roadmap items it protects. Also the `INTENTIONAL_DIFFERENCES` catalog. No tmux argv/format strings. |
| `runner.ts` | `ParityRunner` — the **test-only** adapter shape (NOT a product seam) the corpus is driven through. A future native runner implements the same shape. |
| `checks.ts` | Reusable, framework-neutral executable checks: one per `live` scenario (over any `ParityRunner`) and one per `pure` scenario (over existing product helpers). |
| `tmux-runner.ts` | `ParityRunner` implemented over a real tmux server via the typed `TmuxClient` (node:child_process spawn seam, as in the live client e2e). |
| `scenario-roadmap-map.md` | Scenario → roadmap-item mapping (kept in sync by a test). |
| `__tests__/corpus.test.ts` | Fast, backend-free: data integrity, coverage, check completeness, the pure checks, map sync. |
| `__tests__/parity-corpus.live-e2e.test.ts` | Slow: runs every `live` scenario against real tmux. Excluded from `bun run test`; runs in `bun run test:full`. `skipIf(!tmux)`; platform-marked. |
| `__tests__/isolation.test.ts` | Fast: no production importer; corpus/runner stay backend-neutral. |

## Vocabulary

`create` · `attach` · `input` · `resize` · `split` · `focus` · `capture` ·
`reconnect` · `high-output` · `exit` · `cleanup`, plus the five required
negatives: missing session, duplicate attach, invalid resize, dead view,
cleanup retry.

## Required parity vs intentional differences

Every scenario is classified so a native backend is never forced to emulate a
tmux artifact. `required` behaviors (stable logical ids, cwd/env propagation,
capture ordering, single active view, owned cleanup, clean error handling) must
match. The `INTENTIONAL_DIFFERENCES` catalog (id/pane string formats, 16ms
output batching, min-across-clients resize + jiggle redraw, multi-writer
sessions, copy-mode search, status-bar reservation, hostname-default titles)
records where native may legitimately differ — the "record intentional
differences" half of roadmap item CUT-001.

## Documented gaps

Three behaviors cannot be driven through typed boundaries without production
changes or a real attached Bun PTY, so they are recorded as `gap` rather than
faked: exit **status-code** propagation (rides the PTY `onPtyDied` path),
owned **process-tree** reaping (lives in `process-reaper`/`port-scanner` above
`TmuxClient`), and single-writer **duplicate-attach** semantics (a native
registry guarantee tmux has no lock for). See each scenario's `verification.note`.

## Running

```bash
bun run test         # fast: corpus.test.ts + isolation.test.ts (no tmux)
bun run test:full    # + parity-corpus.live-e2e.test.ts against a real tmux server
```

## Reusing against a native backend later (CUT-001)

Implement `ParityRunner` for the native host, then drive `LIVE_CHECKS` and
`PURE_CHECKS` with it exactly as `parity-corpus.live-e2e.test.ts` does for tmux.
The corpus, checks, and classifications are shared unchanged; only the runner
differs.
