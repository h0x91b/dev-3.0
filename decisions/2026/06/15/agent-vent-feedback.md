# 068 — Agent vent feedback (local, anonymous, background)

## Context

We wanted a channel for AI agents to report friction with the **dev3 platform itself**
(missing/confusing CLI, unclear skill text, broken tmux integration, contradictory docs) —
the agent's own "this tool got in my way" bug-report, not user-facing. dev3 has no server, and
shipping a hidden log to a public endpoint would be a data-leak risk. Opening GitHub issues is
too noisy. So the channel is local-only: the agent decides to vent, dev3 drops an anonymous
markdown file, and the maintainer reads the folder (or asks users to share theirs).

## Decision

- New CLI command `dev3 vents <name> <markdown>` (`src/cli/commands/vents.ts`, wired in
  `src/cli/main.ts`). It has no subcommand — the first positional is the vent name — so
  `main.ts` re-parses its args from the raw argv without the subcommand split.
- It goes through the existing CLI socket: handler `vent.add` in `src/bun/cli-socket-server.ts`.
- Storage: `src/bun/vents.ts` `addVent()` writes **one standalone markdown file per vent** to
  `~/.dev3.0/vents/`, named `YYYY-MM-DD_HH-MM_<slug>.md` (chronological sort), body =
  `# <name>` + timestamp + the agent's markdown. Length caps guard against runaway/injected
  output; same-minute collisions get a numeric suffix.
- **Anonymity is enforced by zero enrichment.** Unlike the tool this was inspired by, dev3
  attaches NO context — no project path, project/task id, cwd, or code. The file holds only
  what the agent typed. The "platform-only, no PII, no project specifics" contract is taught to
  the agent in the skill.
- **Always on, no UI, no opt-in.** There is no setting and nothing changes visually in dev3 —
  no toast, no panel. The vent section is always present in the skill bodies + system prompt
  (`SKILL_VENT_FEEDBACK` in `agent-skills.ts`, injected via `DEV3_SYSTEM_PROMPT*` in
  `agents.ts`), framed as a background bug-report channel with strict scope and a litmus test.

## Risks

- Anonymity depends partly on the agent honoring the skill rules; we cannot scrub free-form
  markdown. Mitigated by strong scope/anonymity language and by never enriching on our side.
- The vents folder grows unbounded; pruning is left to the maintainer (it is just files).

## Alternatives considered

- **Opt-in flag + conditional skill injection** — initially built, then dropped: the channel is
  local and the "group" is whoever shares their vents folder, so a per-machine toggle added
  complexity for no real gating.
- **Any UI (toast / inbox / settings toggle)** — explicitly not wanted; the maintainer reads the
  folder directly, nothing should change in the app.
- **Reuse task notes** — buries platform feedback per-task and mixes it with work notes; kills
  the cross-run aggregation that is the whole point.
- **dev3 as an MCP server with a `vent` tool** — cleanest tool semantics, but dev3 has no MCP
  surface today; disproportionate infrastructure for one tool.
