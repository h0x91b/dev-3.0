# Per-test project isolation in the label.delete race suite

## Context

`src/bun/__tests__/cli-socket-label-delete-race.test.ts` produced the repo's only
known flake with a real failed assertion rather than a timeout: the concurrent
case (`does not clobber a concurrent labelIds change…`) died with
`STACK_TRACE_ERROR` under load, and the next test then failed with
`expected [ 'label-kept-2222', …(1) ] to deeply equal [ 'label-kept-2222' ]`.
Three observations across two branches and two shas, at loads ~72 and ~150; never
in isolation (6/6 green), and not at load ~39. Load was the trigger, not the cause.

## Investigation

The concurrent case suspends a `label.delete` handler inside a mocked
`loadTasks`, and the injected callback writes `[DELETED, KEPT, CONCURRENT]`. When
the test dies while suspended, that write still completes — into the one
`tasks.json` every test in the file shared. The next test seeds, the corpse's
write lands, and its own `label.delete` strips `DELETED`, leaving
`[KEPT, CONCURRENT]` — exactly the observed message.

Varying `$HOME` per test does not separate them: `vi.mock("../data")` keeps one
module instance alive for the whole file, so `vi.resetModules()` never
re-resolves `paths.ts` and `DEV3_HOME` is fixed at first import. Reverting to a
shared `$HOME` mid-suite reproduced it as "Label not found", proving the module
is never re-instantiated.

## Decision

Each test gets its own `projectId`, project `path` and therefore slug
(`enterFreshTest()` in the test file), so its `tasks.json` is a file no other
test reads; `projects.json` accumulates instead of being deleted out from under a
suspended neighbour. A new test, `does not observe a write from a neighbour
abandoned mid-flight`, suspends a handler, starts the next test's state, releases
the corpse, and asserts nothing leaks. Reverting the per-test identity makes it
fail with the byte-identical production message.

The same shape sits in `cli-socket-note-race.test.ts` — same `injectAfterLoad`,
same single temp home, two injection points — and is fixed in the same way, in
its own commit. `data-race.test.ts` shares the temp home but suspends no
handler (its `Promise.all` is awaited inside one test), and
`file-lock-enoent-race.test.ts` already creates a temp dir per test; neither is
touched.

## Risks

The suite now leaves several project directories in one temp home instead of
wiping between tests; `afterAll` still removes the whole home. A test that
asserts on `projects.json` must select its own project by id (`readProjectRaw`).

## Alternatives considered

Per-test `$HOME` — does not work, see Investigation. Awaiting the suspended
handler in the concurrent case would only stop it dying at that one point; the
leak survives at any other suspension point and at any load.
