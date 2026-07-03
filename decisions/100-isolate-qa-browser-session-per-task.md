# 100 — Isolate the QA browser session per task

## Context

When several task agents ran the `/debug-ui` browser-QA flow at the same time, they
stomped each other: a screenshot could silently capture the *wrong* task's UI. This cost
an author ~6 rounds of defensive re-verification. Hypothesis: `agent-browser` cannot run
concurrent isolated sessions.

## Investigation

Confirmed empirically against `agent-browser` 0.6.0:
- With no session flag, every invocation shares one global session named `"default"` — one
  browser, one global viewport. Two sequential `open` calls proved the stomp: after "agent
  2" navigated, "agent 1" reading the default session saw agent 2's page.
- `agent-browser` **does** support concurrent isolated sessions: `--session <name>` or the
  `AGENT_BROWSER_SESSION` env var. Two named sessions stayed fully isolated (A→AAA, B→BBB),
  both listed by `agent-browser session list`. The env var is honored identically to the flag.

So the tool was never the limitation — the `debug-ui` skill just drove the shared default
session. `DEV3_TASK_ID` is injected into every dev3 task pane (`tmux-pty.ts`,
`shared-pure.ts`), giving a stable, always-present per-task key.

## Decision

Give each task its own isolated browser session keyed off the task id. The `debug-ui` skill
(`.claude/skills/debug-ui/SKILL.md`) now exports
`AGENT_BROWSER_SESSION="dev3-${DEV3_TASK_ID%%-*}"` as step 1 of the flow (matching the
`dev3-<short-id>` tmux session naming), scopes the screenshot path to the task id, and a new
Gotcha explains the singleton/stomp and that the Bash tool re-inits the shell per call (so
the export must be repeated per block, or `--session` passed per command). `AGENTS.md`'s
"Manual UI QA in a browser" section carries a one-line pointer to the same rule.

## Risks

- Env exports do not persist across separate Bash tool invocations. Mitigated by deriving the
  name from the always-present `$DEV3_TASK_ID`, so the one-liner is idempotent and copy-paste
  safe at the top of any block.
- Docs-only change; no code guards it. A future agent that hand-rolls `agent-browser` without
  the session export reintroduces the collision — the AGENTS.md pointer is the backstop.

## Alternatives considered

- **Serialize QA across agents (one browser machine-wide).** Correct but slow — forces
  parallel agents to wait; kept only as a documented fallback.
- **Pass `--session` on every command instead of the env var.** Works but verbose and easy to
  forget on one call (which then stomps); the env export covers all commands in a block.
- **Per-task `user-data-dir` via a custom Chromium profile.** Redundant — named sessions
  already isolate profile/state; no need to manage dirs by hand.
