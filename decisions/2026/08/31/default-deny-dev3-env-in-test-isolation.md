# Default-deny every inherited DEV3_ var in test isolation

## Context

`configureTestIsolation` sandboxes HOME, TMPDIR and the XDG dirs for every Vitest
process, then scrubbed exactly six named `DEV3_TASK_*`-ish vars plus the
`DEV3_NATIVE_SESSION_` prefix. `resolveDev3Home` reads `env.DEV3_HOME` FIRST and
returns it verbatim, before it ever looks at HOME — and `DEV3_HOME` was on
neither scrub list. So a suite started from any shell exporting it (the scoped QA
instance exports exactly that) resolved the user's live `~/.dev3.0` at module
load, with the sandbox silently bypassed.

## Investigation

A dev3 agent pane exports 13 `DEV3_*` vars. Nine survived the old scrub,
including `DEV3_PROJECT_PATH` (the real checkout), `DEV3_WORKTREE_ROOT`,
`DEV3_ARTIFACT_TEMPLATE_DIR`, `DEV3_AGENT_ACCOUNT_ID` and `DEV3_USER_ENV`. The
named list was not merely missing `DEV3_HOME`; it was structurally the wrong
shape, because it had to be edited every time dev3 gained a var, and nothing
failed when it was not.

No CI job and no test reads any `DEV3_*` var from the environment. The single
exception is `DEV3_TEST_CONCURRENT`, set by the `bun run test` scripts and read
by the Vitest config for its worker budget immediately after isolation returns.

## Decision

Two layers, in `test-isolation.ts`.

Mechanism: default-deny. Drop every `DEV3_*` var and preserve only the
`DEV3_TEST_` prefix (`PRESERVED_TEST_ENV_PREFIX`), so a var dev3 gains later is
safe with nobody editing this file.

Outcome: `assertDev3HomeIsSandboxed`, called at the end of
`configureTestIsolation`, resolves the root through the PRODUCTION resolver and
throws if it lands outside the run root. That turns "quietly writes to the user's
real data root" into a refusal to start, whatever future override slips through.

## Risks

Default-deny drops a var some future harness genuinely wants inherited. The
failure is loud and local (a test reading an env var it no longer gets), and the
fix is to name it under the `DEV3_TEST_` prefix. `PANE_INJECTED_ENV_SAMPLE` is
illustrative only — the scrub is a prefix rule, so that list going stale cannot
reopen the hole.

This bug did NOT cause the 31 Aug 2026 `projects.json` incident; the damage there
included EPERM failures in a different tree, which a test writing to a wrong path
does not produce. It is fixed on its own merits.

## Alternatives considered

Setting `DEV3_HOME` to the sandbox was rejected: it OUTRANKS `HOME`, and dozens
of suites relocate the board by assigning `process.env.HOME`, so they would all
silently read the shared run root instead of their own fixture. Adding
`DEV3_HOME` to the named list was rejected as the same shape that just failed.
