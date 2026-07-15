# 136 — Attribute recent rate limits to every active agent account

## Context

The header rate-limit indicator previously kept one Claude dump and one newest Codex rollout, so concurrent or recently used managed accounts collapsed into the default account row. The desired view is every account with a local activity signal from the last 24 hours.

## Investigation

Claude statusline payloads run inside the launched account environment, while Codex rollouts are already partitioned by each managed `CODEX_HOME`. Codex app-server data is fresher but does not prove activity, so it is used only to enrich a recent rollout and the rollout timestamp remains the activity anchor.

## Decision

Additive Claude snapshots live under `~/.dev3.0/data/rate-limits/claude/<accountId>.json`; the legacy `claude.json` remains a compatibility/system fallback and carries the account id when known. `AgentRateLimitSnapshot` carries `accountId` and `activeAt`, and `rate-limit-monitor.ts` deduplicates and filters snapshots to the 24-hour window before the existing header tooltip renders them.

## Risks

Old global Claude dumps without attribution can only be treated as system-login data until a new statusline refresh writes the account id. Stale per-account files remain on disk but are ignored by the freshness filter and do not affect the frozen existing data paths.

## Alternatives considered

Listing every registered account was rejected because it would imply current activity and show accounts with no recent local evidence. Keeping one aggregate per provider was rejected because it loses the account identity needed to explain which subscription's limits are being consumed.
