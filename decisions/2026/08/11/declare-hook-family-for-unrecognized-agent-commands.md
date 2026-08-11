# An agent can declare its hook family, because dev3 cannot recognize a wrapper

## Context

`getAgentAdapter` keys off `agentKey(baseCommand)` — the command's last path
segment — and only five literals (`claude`, `codex`, `gemini`, `agent`,
`opencode`) resolve to a real adapter. Anything else lands on `genericAdapter`,
whose `hooksSpec()` returns `null`, and `setupAgentHooks` then returned early
with no log line and no UI signal. A user who pointed a custom agent at his own
shell alias got no `.claude/settings.local.json` in the worktree, no hook ever
fired, the task never moved between columns on its own, and `dev3 doctor` still
reported everything healthy. Three commands fall into this hole: a wrapper or
alias, a base command carrying flags, and an unresolved (empty) command. Found
while investigating seq 1509; PR #1327 hardened the *merge* of an existing
settings file, so it never applied here — the merge never ran.

## Investigation

Nothing in the renderer imported `hasAgentAdapter`, so the surface where the
command is typed said nothing about the consequence. Of the five adapters only
Claude and Codex return a hooks spec at all, so "no hooks" is correct-by-design
for Gemini/Cursor/OpenCode and only a defect for a command dev3 fails to place.

## Decision

`CodingAgent.hooksIntegration` (`"claude" | "codex" | "none"`, undefined = auto)
is an optional field the user sets in Settings → Agents; `getHooksAdapter`
(`shared/agent-adapters/registry.ts`) prefers it over the name guess, and the
five launch paths in `rpc-handlers/tmux-pty.ts` plus `agent-hooks-refresh.ts`
thread it through. `setupAgentHooks` now logs the no-hooks case. The editor shows
what "Auto" resolved to and, when the command is unrecognized and nothing is
declared, an amber card naming the consequence (`HooksIntegrationField`).

Scope is hooks only: launch args, trust and resume stay keyed by the command,
because a wrapper's flag compatibility is unknown and the Seam A golden test
pins the generic launch line.

`shared/agent-adapters/hook-families.ts` restates "which commands exist" and
"which have hooks" as plain data for the renderer — importing the registry there
would bundle every agent's skill body (~32 KB) into the app. Two tests in
`bun/__tests__/agent-adapters.test.ts` assert that copy against the real
registry and every adapter's `hooksSpec()`.

## Risks

- The declaration is trusted: pick "Claude Code hooks" for a command that is not
  Claude Code and dev3 writes hooks the CLI will never read (inert, not fatal).
- A wrapper still gets generic launch args, no skill-body injection and no
  resume — the field's label says "Lifecycle Hooks" so it does not promise that.
- `hook-families.ts` duplicates registry facts; only the tests keep it honest.
- New optional field in `settings.json`: older app versions ignore it and fall
  back to today's name-guess behaviour, which is the pre-change status quo.

## Alternatives considered

- **Warning only, no field** — cheapest, but tells the user to rename his own
  alias, and does nothing for a base command that carries flags.
- **Probe the binary** (`--version` and parse) — hooks must be installed before
  launch, the probe cannot see through a shell alias, and a silent heuristic is
  the same class of bug this fixes.
- **Full adapter override** (launch args, trust, resume too) — the honest end
  state, rejected for now: `buildResumeCommand`/`supportsResume` are called from
  places holding only a pane's command string, so it is a wider refactor of the
  launch paths than the reported bug justifies.
