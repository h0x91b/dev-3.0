# An agent declares which CLI it is, and that governs everything — not just hooks

## Context

A user ran Claude Code from a custom executable under another name and reported
that Resume Session restarts the initial prompt instead of continuing the
conversation. `getAgentAdapter` keyed only on `agentKey(baseCommand)` — the
command's last path segment — so anything but the five literal CLI names landed
on `genericAdapter`, whose `launchArgs` ignores `options.resume` entirely and
always appends `-- <task description>`. The resume command was therefore
byte-identical to a fresh launch.

The loss is wider than resume. A renamed binary also got no `--session-id` (so
`sessionState.panes[].sessionId` stayed `null` and there was nothing to resume
by id), no `transcriptStore` (so `resolveResumableSessionId` could not fall back
to the newest transcript either), no `--append-system-prompt` (the dev3
protocol), no `--settings` (statusLine → rate-limit tracking), no
`--allow-dangerously-skip-permissions`, no managed-account env, and no hooks.

Four routes reach it: a custom path on the built-in agent, an edited base
command, a user-created agent, and a config's `baseCommandOverride`.

## Investigation

`decisions/2026/08/11/declare-hook-family-for-unrecognized-agent-commands.md`
already introduced `CodingAgent.hooksIntegration` for exactly this shape of
problem, but scoped it to hooks and listed "a wrapper still gets generic launch
args … and no resume" as an accepted risk. Its Alternatives section names the
full adapter override as "the honest end state", deferred because
`buildResumeCommand`/`supportsResume` are called from places holding only a
pane's command string. `PaneSessionEntry` turned out to already carry `agentId`,
and adding one more snapshot field made those call sites tractable.

The first route needed no declaration at all: `applyBinaryPathOverride`
*replaces* `agent.baseCommand` with the override path, so `builtin-claude`
pointed at `~/bin/my-claude` re-guessed itself into an unknown CLI even though
dev3 knew perfectly well which agent it was.

## Decision

`CodingAgent.hooksIntegration` becomes `CodingAgent.agentFamily`
(`"claude" | "codex" | "gemini" | "agent" | "opencode" | "none"`, undefined =
auto) and governs the whole adapter. `agentKey(baseCommand, family)` — moved to
`shared/agent-adapters/families.ts` so the renderer and `llm-provider.ts` can
key on an agent without importing the adapters and their ~32 KB of skill bodies
— is the single seam; `getAgentAdapter`, `hasAgentAdapter`, `isClaudeCommand`,
`skillInvocationPrefix`, `providersForAgent`, `agentProvider` and
`buildCommandPreview` all take it. `getHooksAdapter` is gone; hooks resolve
through the same `getAgentAdapter`.

`applyBinaryPathOverride` pins the family the original command resolved to, so a
path override changes only *how* the agent is spawned — never *what* it is. It
pins nothing when the original command was unrecognized too, leaving the path's
own name its chance.

`resolveCommandForAgent`/`ForProject` return the resolved family alongside the
records (`ResolvedAgentCommand`) rather than a path-swapped agent, because
callers derive `resolvedBaseCmd` from `agent.baseCommand` and persist it.
`PaneSessionEntry.agentFamily` snapshots it at launch so resume — which holds
only a pane — reads the family instead of re-guessing.

On-disk: `migrateOldFormat` carries `hooksIntegration` over to `agentFamily` in
place, path unchanged (per the `~/.dev3.0` invariants). `agentFamily` on a pane
is written undefined-able, so `JSON.stringify` drops it and `tasks.json` gains
nothing for the common case.

## Risks

- The declaration is trusted: pick "Claude Code" for a CLI that is not Claude
  Code and every launch flag is now wrong, not just an inert hooks file. The
  blast radius of a mis-declaration grew with its usefulness.
- An older app version reading `agents.json` finds no `hooksIntegration` and
  falls back to the command-name guess — the pre-declaration status quo, so a
  downgrade loses the declaration rather than misreading it.
- `families.ts` still duplicates registry facts; only
  `__tests__/agent-adapters.test.ts` keeps the copy honest.
- Panes stored by older versions carry no `agentFamily` and keep guessing from
  `agentCmd`; a task already running under a renamed binary needs one fresh
  launch before targeted resume works.

## Alternatives considered

- **Fix only `applyBinaryPathOverride`** — 2-3 hours and closes the route where
  the user did nothing wrong, but leaves a user-created wrapper agent broken.
- **Widen `hooksIntegration` without touching the path override** — closes the
  wrapper routes, but a custom path on built-in Claude stays silently broken and
  the field's name keeps lying about its reach.
- **Probe the binary** (`--version` and parse) — rejected again, for the reasons
  in the 2026-08-11 record: hooks must be installed before launch, the probe
  cannot see through a shell alias, and a silent heuristic is the same class of
  bug this fixes.
