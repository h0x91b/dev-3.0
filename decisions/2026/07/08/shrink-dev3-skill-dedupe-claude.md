# 114 — Shrink the dev3 skill: dedupe the Claude channel, compress the body

## Context

The dev3 skill body was ~23.4 KB (~5.8k tokens) and, for Claude Code, landed in context **twice** per session: once via `--append-system-prompt` (`DEV3_SYSTEM_PROMPT` in `src/bun/agents.ts`) and again when the MANDATORY skill invoke loaded `SKILL.md`, which also injected the full `dev3 --help` (~5 KB) and full `dev3 current` (duplicating the task description already present as the initial prompt). Total ≈ 13.5k tokens per Claude session, directly visible in API cost.

## Investigation

Delivery channels differ per agent (verified in `resolveAgentCommand`): Claude gets the body in the system prompt on every launch (including resume and scratch); Codex gets it appended to the first prompt **only when the prompt is non-empty** — scratch tasks rely solely on the skill file + hooks; Gemini gets **no injection at all** — the generic skill in `~/.agents/skills/dev3/` is its only protocol channel; Cursor/OpenCode mirror Codex via the prompt argument.

## Decision

1. Claude `SKILL.md` (`CLAUDE_SKILL_CONTENT` in `src/bun/agent-skills.ts`) no longer embeds the body — only the status auto-set and `dev3 current --brief`. The full body is written to `PROTOCOL.md` next to it as a fallback for sessions started outside the dev3 launcher, and the SKILL.md points to it.
2. Codex and generic skill files keep the full body — they are load-bearing (Codex scratch tasks, Gemini entirely).
3. The shared body sections were rewritten for density: 23.4 KB → ~14.3 KB (~3.6k tokens, −39%) with all normative rules, command anchors, and test-pinned phrases preserved. Net Claude session cost: ~13.5k → ~4.1k tokens.

## Risks

A manually-launched `claude` in a dev3 worktree (no `--append-system-prompt`) now sees the protocol only if it follows the SKILL.md pointer to `PROTOCOL.md`. Prose compression may slightly weaken checklist adherence (repetition was partly deliberate); watch for regressions in branch/title/overview/label discipline.

## Alternatives considered

Shortening all skill files uniformly (rejected: breaks Codex scratch and Gemini, which have no other channel); moving sections to sub-skills like `/dev3-tmux` (deferred: risks burying already-underused features like vents); leaving files intact and only compressing text (kept as part of the fix, but alone it left the Claude double-injection in place).
