# 196 — Test isolation scrubs the agent's own task environment

## Context

Most test runs in this repo are started **by an agent, inside a dev3 task pane**.
That pane exports the task's own context, so every suite inherits
`DEV3_TASK_ID`, `DEV3_TASK_TITLE`, `DEV3_WORKTREE_PATH`, `DEV3_BRANCH_NAME` —
and, when the task runs on the native terminal backend, that host's
`DEV3_NATIVE_SESSION_ID` / `_LAUNCH` / `_COLS` / `_ROWS` as well. CI inherits
none of it.

That asymmetry produces the most expensive kind of failure: a test that passes
in CI and fails only for the agent, or the reverse — and the agent has no reason
to suspect its own environment, so it goes looking in the diff.

## Investigation

Found while adding `DEV3_TASK_SEQ` (seq 1383), but the bug predates that work.
`src/bun/__tests__/native-host-runtime.test.ts` → "omits the opt-in proof flags
when they were not requested" asserts the launcher's env has no
`DEV3_NATIVE_SESSION_COLS`. The launcher builds its env as `{...process.env, ...}`,
so it read the *agent's own pane* value and failed — locally only, on unmodified
code. Several older tests already worked around the same class by hand, deleting
`DEV3_TASK_ID` in a `beforeEach` (see `src/cli/__tests__/context.test.ts`).

## Decision

`configureTestIsolation` (`test-isolation.ts`), which already sandboxes `HOME`,
`TMPDIR`, `DEV3_HOME` and the XDG roots, now also deletes the inherited task
context: every key in `INHERITED_TASK_CONTEXT_ENV`, plus every key starting with
`DEV3_NATIVE_SESSION_`. Every suite therefore starts from "no task in scope",
and a test that wants one sets it explicitly.

`DEV3_NATIVE_SESSIONS_DIR` (plural) is a test-owned override and deliberately
does not match that prefix. Guarded by `src/bun/__tests__/test-isolation.test.ts`,
which both asserts the scrub happened and enumerates the list — so **a new env
var injected into task panes must be added to `INHERITED_TASK_CONTEXT_ENV` in the
same change**, or that test fails on purpose.

Corollary for new code: a module that needs task context should take env as an
**argument** rather than reading `process.env`. That is why
`src/bun/native-terminal-registry/process-naming.ts` carries a test asserting its
own source contains no `process.env` at all.

## Risks

- A future test that genuinely wants the ambient agent task must now set the var
  itself. That is the intended trade: explicit beats inherited.
- The prefix sweep is broad by design. A future `DEV3_NATIVE_SESSION_*` var meant
  to survive into tests would need a different name, which is the right pressure.

## Alternatives considered

- **Keep deleting vars per-suite in `beforeEach`** — the status quo that let this
  through. It only protects the suites whose author already knew about the trap.
- **Scrub every `DEV3_*` var** — would also drop `DEV3_HOME`, `DEV3_LOG_DIR` and
  `DEV3_TEST_ROOT`, which this same function deliberately sets.
- **Have CI export the same vars so both sides match** — makes the environments
  agree by making both wrong, and would feed a real task's identity to suites
  that should never see one.
