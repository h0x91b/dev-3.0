# Spread the real module in bun preload mocks instead of listing exports

## Context

`bun run test:pane-e2e` had been dead on `main` since at least 2026-08-10. It failed with
`SyntaxError: Export named 'findConfig' not found in module src/bun/agents.ts` — an
import-time death, so zero assertions ran and any count of failing tests read as zero. The
script was also absent from `TERMINAL_E2E_SCRIPTS`, so CI never ran it: broken and unrun at
the same time, which looks like coverage and provides none.

## Investigation

The preload (`src/bun/__tests__/pane-exit-e2e-preload.ts`) replaced whole modules with
object literals enumerating their exports by name. `agent-hooks-refresh.ts` gained
`import { findConfig } from "./agents"` in commit `5fdd4c04` (2026-08-10, PR #1327) and the
mock was never updated; behind it `data.ts` had the same rot on `newTaskTerminalBackend`.
Fixing one export only surfaced the next.

## Decision

Each `mock.module(...)` in that preload now spreads the real module and overrides only the
handful of functions the test actually needs — `const realAgents = await import("../agents")`,
then `{ ...realAgents, resolveCommandForProject: ... }`. That makes the mock structurally
complete forever: a new export in the real module is simply present. The `electrobun/bun`
mock stays enumerated, since there is no real module to spread here. `test:pane-e2e` was
added to `TERMINAL_E2E_SCRIPTS` (`src/bun/terminal-e2e-guard.ts`), with its
`dev3-e2e-` socket/temp naming added to `OUR_PROCESS_PATTERNS` and `OUR_TEMP_PREFIXES`.

## Risks

Spreading gives un-overridden exports their real implementations, so a code path the test
does not exercise today could start touching disk or spawning processes. Contained by
`configureTestIsolation("pane-e2e")`, which already redirects HOME/TMPDIR to a throwaway
root, and by the terminal e2e gate's own orphan and temp-leak checks.

## Alternatives considered

Add the missing export to the literal — rejected: it fixes this instance and leaves the
trap. Delete the suite — rejected: it is the only coverage of pane-exit reconciliation
through the real `launchTaskPty` flow against a live tmux server; `task-panes.test.ts`
covers `handlePaneExited` only at unit level. A repo-wide guard asserting mocks enumerate
every export — rejected: this is the only `mock.module` preload in the repo (all other
mocking goes through vitest), so the spread pattern removes the class outright and a guard
would police a population of one.
