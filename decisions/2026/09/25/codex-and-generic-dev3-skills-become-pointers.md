# Codex and generic dev3 skills become pointers to PROTOCOL.md

## Context

`decisions/2026/07/08/shrink-dev3-skill-dedupe-claude.md` shortened only Claude's `SKILL.md` and kept the full protocol body in the Codex and generic skill files, because Codex scratch tasks then received no protocol any other way. The same day #871 moved Codex onto `-c developer_instructions=…`, which reaches fresh, scratch and resumed sessions alike, so that reason no longer held — but the full body stayed in `~/.codex/skills/dev3/SKILL.md` behind a "MANDATORY — invoke BEFORE doing anything else" description.

## Investigation

Codex rollouts from 2026-07-09 inside dev3 worktrees show the body arriving as a developer message, then the agent announcing the "mandatory dev3 process" and `sed`-ing the whole `SKILL.md`: two copies per session (~27.7 KB now). The skill listing of a current Codex session shows **two** `dev3` skills, one per root (`~/.codex/skills` and `~/.agents/skills`). The one the July agent read was `~/.agents/skills/dev3/SKILL.md` — the generic body, whose manual "move the status every turn" rules contradict Codex's hook-owned status section.

## Decision

`buildProtocolPointerSkillContent` (`src/bun/agent-skills.ts`) is one short `SKILL.md` written to `~/.codex/skills/dev3/` and to every generic dir (`~/.agents`, `~/.cursor`, `~/.opencode`, `~/.config/opencode`). Its description tells an agent that already holds the "dev3 — Task Lifecycle Protocol" section not to invoke it, and keeps it MANDATORY otherwise. The bodies move to `PROTOCOL.md` next to each pointer: `buildCodexProtocolContent` (hook-owned status) in the Codex dir, `buildGenericProtocolContent` (manual status) in the generic dirs. omp is unchanged: it does not read `~/.agents/skills` and still ships its full body.

## Risks

Gemini and prompt-less Cursor/OpenCode launches now need one extra read (`SKILL.md` → `PROTOCOL.md`) to reach the protocol; the pointer tells them to, but that step is new and unverified on those harnesses. A Codex launched without the protocol (`skipSystemPrompt`, or a session started outside dev3) can still read the generic `PROTOCOL.md` instead of its own — the same exposure as before, now limited to that case. Omitting the section heading from the pointer's own title keeps an agent from mistaking the pointer for the protocol.

## Alternatives considered

Slimming only the Codex copy (rejected: Codex would still load the full generic body from `~/.agents/skills`, conflict included). Stopping the install into `~/.agents/skills` (rejected: it is Gemini's and Copilot's only skill path). Disabling the `~/.agents` copy for Codex through `~/.codex/config.toml` (rejected: relies on an unverified Codex config surface, and would leave Cursor/OpenCode double-loaded).
