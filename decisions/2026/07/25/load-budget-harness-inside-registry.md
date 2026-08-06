# 164 — Native-terminal load/budget harness lives inside the registry module

## Context

Seq 1262 (a test-only slice of the tmux-removal effort) asked for a deterministic
load/budget harness under `src/bun/native-terminal-load-budget/` that imports the
existing native parser and resync primitives read-only, without editing them.

## Investigation

`native-terminal-registry/__tests__/isolation.test.ts` enforces a hard invariant:
any `.ts`/`.tsx` file **outside** the module root that contains the literal string
`native-terminal-registry` fails the test — the module must have zero external
importers so it stays self-contained and removable during tmux removal. A harness
at `src/bun/native-terminal-load-budget/` would import the registry via
`../native-terminal-registry/…`, tripping the guard (it flagged 4 files). The
guard cannot be relaxed — it is a registry file this task must not edit, and the
invariant is the point.

## Decision

Nest the harness at `src/bun/native-terminal-registry/native-terminal-load-budget/`
(same directory name the task requested, inside the module). The isolation test
excludes everything under the module root, so the harness imports the real
primitives via `../live-parser`, `../parser-queue`, `../journal`, `../parser-state`,
`../ghostty-live` and stays green. The support modules (non-`__tests__`) also pass
the module's prototype-import and tmux-sentinel scans, so the harness itself is
proven to touch neither.

## Risks

The path deviates from the literal `src/bun/native-terminal-load-budget/` in the
task. Mitigated by keeping the exact folder name and documenting the placement in
the harness README + this record. No existing registry file was edited.

## Alternatives considered

- **Top-level dir + edit the isolation test to exclude it** — forbidden (registry
  file) and would erode the isolation invariant the tmux-removal work depends on.
- **Dynamic import / computed path to dodge the static grep** — evasion; the string
  still appears and it defeats the guard's intent.
- **Copy the primitives instead of importing** — worthless for a budget harness;
  it would drift from the real parser/resync code it is meant to measure.
