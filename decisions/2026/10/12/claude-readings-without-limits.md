# Claude readings without limits, and the gateway spend limit

## Context

Claude Code sends `rate_limits` in the statusLine JSON only to claude.ai Pro and Max subscribers, or behind a Claude apps gateway that sets a spend limit (`rate_limits.spend_limit`), and only after a session's first API response. An Enterprise session gets `cost.total_cost_usd` and nothing else, so `parseClaudeStatusLinePayload` returned null and the account picker said "no recent data" for a live, fresh account (h0x91b/dev-3.0#1948). The org spend budget `/usage` shows has no documented local source.

## Decision

`parseClaudeStatusLinePayload` (`src/shared/rate-limits.ts`) now returns a snapshot with no windows for a limit-less payload once the session has responded (`cost.total_api_duration_ms` or `total_cost_usd` above zero), and still null before that, because a Pro session's first payloads lack `rate_limits` too. `hasReportedLimits` marks such a reading; the picker and the usage panel say "no usage limits reported" with its capture age, and `latestRateLimitSnapshot` skips it so it cannot blank the header pill another account feeds. `rate_limits.spend_limit` is parsed into a `spend_limit` window plus optional `spendLimit` dollars, shown only when Claude Code delivered both amounts.

## Risks

A resumed session's first payload has a non-zero API duration but no `rate_limits` yet, so a Pro account can briefly read "no usage limits reported" — true of that payload, and replaced on the next response. Each login keeps one dump, so a fresh session still overwrites a concurrent session's limits for the same account (pre-existing).

## Alternatives considered

Showing `cost.total_cost_usd` as the account's usage: rejected — it is a client-side list-price estimate for one session, resets on `/clear`, and only the last session to refresh the dump would be counted, so it reads as a budget it is not. Calling a claude.ai or Admin API for the org budget: no documented endpoint for a member's budget, and dev3 makes no API calls for limits by design (`decisions/2026/07/05/statusline-rate-limit-injection.md`).
