# Classify usage billing from evidence inside each log

## Context
Stats priced all agent usage at API rates in one "~API cost" figure, mixing real API-key spend with plan-covered usage. Every dev3 Claude account (API profiles included) symlinks `projects/` onto `~/.claude/projects`, so a transcript's location says nothing about which login produced it, and today's login says nothing about last month's sessions.

## Investigation
- Claude Code 2.1.327 writes `{"type":"session-owner","accountUuid":…}` only when `isClaudeAiAuth()` holds (claude.ai OAuth). API keys, apiKeyHelper, Bedrock/Vertex and `CLAUDE_CODE_OAUTH_TOKEN` never write it; CLIs before 2.1.318 never did. Subagent files carry none — their session's own `<id>.jsonl` does.
- Codex attaches `rate_limits.plan_type` to every `token_count` event under a ChatGPT login (`plus`, `prolite`, `enterprise_cbp_usage_based`, …); null otherwise.
- OpenCode/pi messages name their provider; their `auth.json` says `oauth` vs `api`/`api_key` per provider, for today's login only.

## Decision
`UsageRecord.billing` (`api` | `subscription`, absent = unknown) is stamped at fold time from that evidence (`src/shared/agent-billing.ts`; hooks in `src/bun/rpc-handlers/agent-usage.ts`). A catalog-routed wire name is `api` unless its provider tracks a plan (`usageSource`). Cursor and Copilot are `subscription`. Gemini stays unknown. Missing evidence is always unknown, never API spend. `AgentUsageDay` carries the three cost parts; the history file keeps `billing` as an optional field and a fresh read wins over a retained one, but never erases it.

## Risks
Plan overage (Claude extra usage, Copilot premium requests, ChatGPT Enterprise usage-based credits) is real money billed through a plan and counts as plan-covered. Ambiguous OpenCode/pi providers reflect the current login. An older app version rewriting the history drops `billing`, so those records read as unknown until their source log is read again.

## Alternatives considered
Classifying by the active dev3 account or env (`ANTHROPIC_API_KEY`) — rejected: it describes now, not the day of the record. Treating a missing Claude session-owner as API spend — rejected: old CLIs and setup tokens would inflate "real spend" with subscription usage.
