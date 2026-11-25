# What a unit test must earn to stay in the suite

## Context

`bun run test` had grown to ~24 000 tests in ~1 350 files and ~600 s of CPU per run on a
16-core box. Most files are cheap; the cost sits in a few dozen (the top 25 files held ~65%
of the test time). Those files mount a heavy tree or a real git repo once per assertion, or
wait on real timers. Moving to vm pools (`renderer-tests-on-vm-threads.md`) took the CPU from
~600 s to ~360 s; this record covers the second half: which tests were removed or merged,
and why, so the same class does not come back.

## Decision

A test is removed or merged when it is one of:

- **A duplicate**: the same behavior asserted again in the same file or in a sibling file
  (`TaskCard.test.tsx` vs `TaskCardSeq.test.tsx` and similar). One copy stays, in the file
  closest to the code.
- **One-assertion-per-mount**: several tests render the same heavy component with the same
  props to check one small thing each. They merge into one test that checks all of them.
- **Per-variant repetition**: a copy-pasted test per locale, agent, status or key. It becomes
  one `it.each` table.
- **Implementation or copy pinning**: an exact CSS class, string or call order, when another
  test already pins the behavior a user sees.
- **A trivial getter or pass-through**, or a snapshot dump nobody reads.
- **A deterministic fuzz corpus beyond ~1 k cases**: fixed seeds replay the same inputs every
  run, so more rows buy CPU, not coverage (`reorder-fuzz.test.ts`).

A test is made cheaper instead of removed when it is slow for an incidental reason:

- **Real timer waits** go to fake timers, or to a mock that behaves like the real dependency.
  For example, the mocked `createSession` in `rpc-handlers.test.ts` now marks the session as
  existing, so a launch no longer polls for ~1 s for a session that never comes.
- **Real git fixtures** get built once in `beforeAll` and copied per test, instead of
  `git init` plus commits in every test.

**Never removed**, whatever they cost:

- any test that names a regression, a past bug, an issue or PR, or a decision record;
- the AGENTS.md contract guards (telemetry anonymity and opt-out, on-disk layout, command-line
  budget, decision-record names, i18n plural keys, CLI exit codes, keymap, ux-docs budget,
  no-raw-page-reload);
- data-preservation and worktree-deletion safety tests;
- the only test covering a branch.

Each pruning PR lists every removed or merged test with the reason and the test that still
covers it.

## Risks

- A merged test reports one failure where several used to. That is acceptable: the assertion
  messages still name what broke.
- "Covered elsewhere" can be wrong. That is why each PR names the covering test for every
  removal.

## Alternatives considered

- **Excluding slow files from `bun run test`.** Rejected: it hides cost instead of removing
  it, and CI would still pay for them.
- **Halving the test count across the board.** Rejected: most tests take ~10–30 ms, so
  deleting thousands of them buys little CPU and loses real coverage. The cost is
  concentrated, and the cuts went where the cost is.
