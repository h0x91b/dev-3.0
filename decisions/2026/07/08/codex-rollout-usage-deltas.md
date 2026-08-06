# Codex rollout usage uses per-turn deltas

## Context

Codex writes local `token_count` events under `~/.codex/sessions/YYYY/MM/DD/`. Each event contains both cumulative session totals and the latest turn's token usage, while model selection arrives separately in `turn_context` events.

## Investigation

Real rollouts showed `total_token_usage` increasing cumulatively while `last_token_usage` exactly matched each increment. `input_tokens` includes `cached_input_tokens`; a frozen local-day comparison against `ccusage codex daily` confirmed the split and totals.

## Decision

`foldCodexEntry` in `src/bun/rpc-handlers/agent-usage-parse.ts` sums only `last_token_usage`, tracks the current `turn_context` model, and records non-cached input as `input_tokens - cached_input_tokens`. Unknown preview models retain their token totals but contribute no guessed cost and mark the report partially unpriced.

## Risks

Codex rollout fields are local implementation details and may evolve. Defensive field checks, per-file model reset, and malformed-line tolerance keep an absent or changed format from breaking the usage RPC.

## Alternatives considered

Summing cumulative totals overcounts every multi-turn session. Taking only the last cumulative event loses model changes and makes cross-day sessions inaccurate, while assigning preview models a nearby public rate would present speculation as cost.
