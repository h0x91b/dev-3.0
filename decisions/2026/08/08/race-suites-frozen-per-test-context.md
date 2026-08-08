# Race suites hand each test a frozen context instead of module-scope identity

## Context

`src/bun/__tests__/cli-socket-label-delete-race.test.ts` and its twin
`cli-socket-note-race.test.ts` went red in full runs on a loaded machine, then
passed in isolation. An earlier fix (PR #1302) gave every test its own project
and narrowed the window; the failure came back unchanged three days later, with
the same two-line signature: the test that suspends a handler dies with no
assertion, and the next test reads back a label (or note) it never seeded.

## Investigation

Reproduced deterministically by emulating a blown budget rather than waiting for
load: `vitest run <file> --testTimeout=400` produces the recorded failure
byte-for-byte — test 1 `Test timed out`, test 2 `expected [ 'label-kept-2222',
'label-concurrent-3333' ] to deeply equal [ 'label-kept-2222' ]`.

A timed-out test does not stop running. Vitest fails it and starts the next one
while the abandoned body carries on. Both files read `projectId` / `projectPath`
/ `projectSlug` from mutable module scope, and the body touches them for the
first time *after* its two dynamic imports — so a body abandoned during those
imports resumed after `beforeEach` had already advanced the identity, seeded its
fixture into the **live** test's `tasks.json`, and armed the single shared
`injectAfterLoad` slot that the live test's handler then fired. Per-test projects
could not help: the corpse simply picked up the new project.

The production handlers are not implicated. `label.delete` / `note.*` recompute
inside `updateProjectWith` / `updateTaskWith` under the file lock, and those
assertions pass.

## Decision

`freshCtx()` returns a frozen `TestCtx` and `raceIt(name, fn)` passes it into the
body synchronously, before any await; `seed`, `readTasksRaw`, `makeTask`,
`makeProject` and every request take it explicitly, so no mutable identity
exists to adopt. `injectAfterLoad` became a `Map` keyed by project id, so a late
registration can never fire inside another test. Both files carry a
`RACE_TEST_TIMEOUT` of 30s, because a 5s budget on two dynamic imports plus file
locks is not a correctness signal on a box that routinely runs many agents. A new
test in each file pins the exact corpse — a body abandoned before it seeds.

Proof under one 400 ms budget: before, 2 failed (timeout **and** the neighbour's
assertion); after, 1 failed (the timeout alone, no cascade). 48 concurrent runs
of both files under 48 CPU hogs, load climbing to 71: 0 failures.

## Corroboration from the field record

Seq 1443 logged four observations of this pair before the cause was known (notes
`0a56664e` and `5dde5b92`). Three were positive — same order, two branches, three
shas, loads 149.60, ~72 and one earlier sighting. The fourth was **negative**:
the same sha `138998f01`, load rising 16.71 → 38.93, the full suite exit 0
(bun 5436/0). It was recorded as a boundary on the load theory: load 38.93 should
have been enough if load were the cause, and my own runs reproduce nothing at
load 47 or 71.

Under this record's mechanism the negative observation is exactly what to expect:
a green suite means no test failed, a blown timeout **is** a failure, so no
corpse existed to cascade. State it for what it is — the load theory has to call
that run luck, this one predicts it. It is corroboration, not proof; the
discriminating evidence remains the mutation result above, because the negative
observation cannot separate this mechanism from any other explanation that also
requires a binary event rather than a load threshold.

## Risks

A genuinely hung test now takes 30s to fail instead of 5s. The two suites are
small and run near the start of the bun config, so the added worst case is
bounded.

## Alternatives considered

- **Raise the timeout only.** Treats the symptom; any budget can be blown, and
  the cascade would return on a busier day.
- **Vary `$HOME` per test.** Impossible here: `vi.mock("../data")` keeps one
  module instance alive for the file, so `vi.resetModules()` never re-resolves
  `paths.ts` and `DEV3_HOME` is fixed at first import.
- **Serialize the two files into one.** Hides the coupling instead of removing
  it, and still breaks the moment either file grows a third suspended test.
