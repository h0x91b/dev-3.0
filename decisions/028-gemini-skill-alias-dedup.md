# Gemini Skill Alias Dedup

## Context

dev-3.0 was installing the managed `dev3` and `dev3-project-config` skills into both `~/.agents/skills/` and `~/.gemini/skills/`. Gemini CLI loads both user-scope directories, so users started seeing conflict warnings every session even though the skill content was identical.

## Investigation

Gemini CLI documents user-scope discovery in both `~/.gemini/skills/` and `~/.agents/skills/`, with the `.agents` alias taking precedence within the same tier. Its skill manager also emits a warning when one non-built-in skill overrides another with the same name.

## Decision

Keep Gemini on the shared `~/.agents/skills/` alias only and stop writing managed dev3 skills into `~/.gemini/skills/`. `src/bun/agent-skills.ts` now handles this in `installAgentSkills()` and `cleanupLegacyGeminiSkillDuplicates()`, removing stale Gemini-specific copies of `dev3` and `dev3-project-config` after the shared alias files are installed.

## Risks

If a user intentionally customized `~/.gemini/skills/dev3*`, dev-3.0 will now delete those two managed directories once the shared alias copies exist. That is acceptable because these skills are generated and overwritten by dev-3.0 on startup, and the shared alias remains the active source for Gemini.

## Alternatives considered

Keep installing to both paths and tolerate the warnings: rejected because Gemini warns on every session and the duplicate path provides no benefit. Install only to `~/.gemini/skills/`: rejected because the shared `~/.agents/skills/` alias is already supported by Gemini and is the higher-precedence cross-agent location we use elsewhere.
