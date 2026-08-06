---
name: verify-changes
description: How to test and verify work in the dev-3.0 repo — which vitest config covers what, how to write a test that fits the house style, mocking Electrobun RPC and i18n providers, what coverage is actually expected, and the browser QA hand-off. Use when writing or fixing tests, deciding what a change needs covered, hitting a failing or flaky suite, or preparing a change for review. Triggers — "write tests for this", "which config runs this", "how do I mock the RPC", "is this covered enough", "the suite is failing".
---

# verify-changes — testing and verification in dev-3.0

The two hard gates (lint + touched tests before push, full suite before a PR) live in
`AGENTS.md` and apply whether or not you read this file. Everything here is the detail
behind them: which runner covers what, how to write a test that fits, and what "enough"
means.

## Which config runs what

**Vitest** with `happy-dom` and React Testing Library. Three configs, three independent
processes:

| Config | Covers | Script |
|---|---|---|
| `vitest.config.ts` | renderer (`src/mainview/`) | part of `bun run test` |
| `vitest.config.bun.ts` | backend (`src/bun/`) | `bun run test:bun` |
| `vitest.config.cli.ts` | CLI (`src/cli/`) | `bun run test:cli` |

```bash
bun run test          # mainview + bun + cli in parallel, minus 3 slow e2e files (~6s)
bun run test:full     # everything incl. slow e2e (~42s) — CI/PR only
bun run test:watch    # watch mode
```

Running vitest directly (outside `bun run`): `bunx vitest run`, never `npx`.

Narrowing while iterating: `bunx vitest run <path>`, `-t "<test name>"`, `--repeat <n>` for
suspected flakes. Because the three configs are separate processes, a failure in one says
nothing about the others — read which prefix (`[mainview]` / `[bun]` / `[cli]`) failed.

**Local E2E policy:** do not run the full E2E suite locally — `bun run test:full` and any
equivalent unfiltered command are reserved for CI/PR validation. Investigating a specific
behavior means running that one E2E file or test case.

## What to test

- **Unit (mandatory)** — state reducer actions and their edge cases, all pure
  functions/utils/parsers, every RPC handler (happy path plus 2-3 error cases), CLI commands
  (parsing, validation, output), data-layer CRUD plus corrupt-data handling, git operations
  with mocked spawn, i18n interpolation and pluralization for every locale.
- **Component (mandatory)** — every major interactive component: board views, task cards,
  modals, settings panels.
- **E2E (CLI-based)** — full lifecycle through the CLI plus Unix socket against a real app
  process in a tmpdir: task lifecycle (create → move statuses → complete), project CRUD,
  worktree creation and cleanup, notes CRUD, CLI context auto-detection, concurrent writes
  with no data corruption.

## House style

- One logical assertion per test; no dependencies between tests.
- Always `userEvent`, never `fireEvent`. Test behavior, not implementation.
- Mock only external boundaries — git, tmux, fs, Electrobun. Never mock internal modules.
- No `sleep` and no timer juggling; use proper `async`/`await`.
- Tests live in `__tests__/` next to their module, e.g.
  `src/mainview/components/__tests__/Dashboard.test.tsx`.
- Avoid the patterns that make a suite flake under CI load: index-based queries
  (`getAllBy…[0]`), structural traversal (`.parentElement`, `.closest(…)`), and assertions
  wedged between two `userEvent` interactions without an intervening `waitFor`.

### Mocking Electrobun RPC and providers

Components importing `api` from `rpc.ts` need the Electrobun native module mocked:

```ts
vi.mock("../../rpc", () => ({
	api: { request: { listDirectory: vi.fn(), addProject: vi.fn() /* … */ } },
}));
```

Components calling `useT()` must render inside `<I18nProvider>` (import from `../../i18n`).

Handler tests mock the `tmux` singleton the same way they mock `rpc.ts`; the tmux client's
own tests inject a fake spawn instead.

### A test that reads a file as data is an untyped interface

Some tests consume something as **data** rather than importing it as code: workflow YAML parsed
line by line, a fixture matched by a regex, a log line asserted on, a JSON shape read by string
matching. Nothing type-checks that link, so reshaping the source breaks the test with the
compiler silent.

The failure is worse than silent — it is misleading. When the test finally fails it describes the
**invariant** ("every Bun-pinning workflow would ship an unproven pin"), not the missing source,
so it reads as a real regression and someone spends an hour proving it is not.

Two rules:

- **Before deleting or reshaping anything, grep who reads it** — not just who imports it. A YAML
  key, a fixture line shape, a log string.
- **If you write one of these, make its failure message name the cause and the fix** — "the
  pinned string moved; update it in this test" — never just restate the invariant.

## Bug fixing — reproduce first

Write the failing test that reproduces the bug (red), then fix until it passes (green), and
commit test and fix together. The rare exception is a bug that genuinely cannot be
reproduced in a test (OS-specific timing, hardware, unmockable third-party behavior) —
default to writing the test.

For a suspected flake, reproduce **under load** before theorising: `--repeat`, several
concurrent vitest processes, and the file run together with its neighbours rather than
alone (cross-test leakage vanishes in isolation). Never "fix" a flake with `retry`, `skip`,
or a bumped timeout on its own.

## Coverage — expectations, not a gate

Two numbers, no per-metric split: **~70% for normal code, ~85% for critical modules.**

- **Critical modules** (a silent regression here is expensive): `state.ts`,
  `src/shared/types.ts` helpers, `src/mainview/i18n/`, `src/cli/`, `src/bun/data.ts`,
  `src/bun/git.ts`, `src/bun/tmux/`, `src/mainview/utils/`.
- **Not expected to be covered** (bootstrap/wrappers that only make sense in e2e):
  `src/bun/index.ts`, `updater.ts`, `shell-env.ts`, `spawn.ts`, `src/mainview/rpc.ts`,
  `main.tsx`.

**No coverage provider is wired up** — no `coverage` block in any vitest config, nothing
installed, no CI gate. These are review-time expectations, so never cite a percentage as if
a tool measured it. What gets rejected in review is a change that leaves its area, or a
critical module, visibly less tested than before.

## Visual surfaces

A change to anything the user sees is not verified by a green suite. Drive the running UI in
a browser, screenshot it, read the console — the recipe (isolated browser session per task,
streamer mode, serving the app) is the **`/debug-ui`** skill.
