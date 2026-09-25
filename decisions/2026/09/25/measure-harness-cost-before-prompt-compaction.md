# Measure task cost before compacting installed skills

## Context

dev3 launches external agent CLIs; their request loops, tool schemas and compaction are outside this repository. The existing daily usage dashboard cannot establish cost per completed task, and untyped Claude cache writes were accidentally excluded from its cost calculation.

## Investigation

Codex receives `CODEX_SKILL_BODY` in developer instructions and can then read the full protocol again through the shared `.agents` skill. Managed Codex accounts share configuration and prompts, but not the default `.codex/skills` directory, so changing only the Codex-specific skill would miss those sessions.

## Decision

Add a local explicit-manifest audit that retains billing categories and parent/subagent attribution, with unknown measurements exposed. In `agent-skills.ts`, gate compact Codex, omp and generic skill wrappers and the managed global instruction block behind `DEV3_COMPACT_AGENT_SKILLS=1`; retain the injected protocol and write each complete fallback before its wrapper.

## Risks

Skill installation is shared across sessions, so the experiment is installation-wide and requires separate evaluation homes. Smaller rendered text is not proof of lower task cost or equal quality; the flag stays off by default pending the evaluation in `docs/agents/harness-token-efficiency.md`.

## Alternatives considered

Rewriting the full lifecycle protocol or changing worker models would alter behavior before a credible baseline exists. API interception or enabling sidecar prompt logging would increase scope and expose content unnecessarily; native usage records and explicit local files provide a safer first measurement boundary.
