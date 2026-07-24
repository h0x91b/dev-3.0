# native-terminal-load-budget

A **test-only** deterministic load and budget harness over the native-terminal
parser and resync primitives in the parent `native-terminal-registry/` module.
It gives the later tmux-removal integration work concrete, reproducible stream
limits without touching any production behavior.

**Why it lives inside `native-terminal-registry/`:** the registry is guarded by
an isolation test (`__tests__/isolation.test.ts`) that fails if *any* source file
outside the module directory so much as references `native-terminal-registry` —
the module must stay self-contained and removable. A harness that imports the
real primitives therefore has to sit inside the module (the guard excludes files
under the module root). See [decision 164](../../../../decisions/164-load-budget-harness-inside-registry.md).

## What it is (and is not)

- **Imports the real primitives read-only** — `ParserEventQueue`,
  `LiveParserPipeline`, the `journal` functions, and `parser-state`. The only
  fake is the WASM parser core, injected through the pipeline's own `createCore`
  seam (`BudgetCore`).
- **No real anything** — no PTY, child process, socket, network, filesystem, or
  wall clock. A seeded PRNG (`prng.ts`), a `SteppingClock`, and a manual
  `DeterministicScheduler` (`clock.ts`) make every run byte-for-byte reproducible.
- **Does not edit its owners.** Where a counter is not publicly observable, that
  is recorded as a follow-up in `FINDINGS.md`, not patched into the owning module.

## Modules

| File | Role |
|---|---|
| `prng.ts` | Seeded mulberry32 PRNG (no `Math.random`). |
| `clock.ts` | `SteppingClock` (fake `now`) + `DeterministicScheduler` (manual drains). |
| `generators.ts` | Deterministic byte + frame generators (steady, burst, resize, DSR). |
| `semantic-state.ts` | Schema-valid semantic-state builder for snapshot-size measurement. |
| `resync.ts` | Rolling-journal model + `planResync` (sequence gap → resume forward). |
| `harness.ts` | `StreamHarness`, `BudgetCore`, `StreamBudget`, fleet `aggregate`. |
| `__tests__/load-budget.test.ts` | Scenarios × {1, 6, 20} streams + cap/overflow/cleanup asserts. |

## Scenarios exercised

Steady output · burst output · stalled observer · sequence gap + resync ·
bounded queue overflow — each across 1-, 6-, and 20-stream fleets. Measurements
and the concrete numbers live in [`FINDINGS.md`](./FINDINGS.md).

Run: `bunx vitest run --config vitest.config.bun.ts native-terminal-load-budget`
