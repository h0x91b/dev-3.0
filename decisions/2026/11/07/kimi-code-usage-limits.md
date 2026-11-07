# Kimi Code usage limits from an undocumented endpoint

## Context

PR #2189 added Kimi Code 5-hour and monthly limits to the usage panel and header pill. Kimi has no local
dump (unlike Claude's statusline or Codex rollouts), so the only source is the vendor's HTTP API, and the
`GET <baseUrl>/v1/usages` endpoint it uses is not publicly documented. The PR merged without a record;
this one was written in the follow-up that fixed the keyless-provider gaps.

## Decision

- **Opt-in per provider.** Only a `custom` catalog provider with `usageSource: "kimi-code"` is polled
  (`src/shared/model-catalog.ts`, Settings → API models → "Limits"). A provider never pointed at Kimi
  never receives a request carrying its key; Settings says where the key goes once tracking is on.
- **Polled, cached, never awaited.** `refreshKimiUsage` (`src/bun/rate-limit-monitor.ts`) asks at most
  every 5 minutes and the result lands in the next report. `redirect: "error"` keeps the key on the
  configured host. A config change (base URL or key, hashed into a stamp) drops the cached reading.
- **401/403 drops the reading; other failures keep it.** A revoked key must not keep showing an old
  number, while a flaky network should not blank a good one. A non-JSON 200 is logged as `parse`.
- **Tolerant parser.** `parseKimiUsage` (`src/shared/rate-limits.ts`) reads `usages.limit_5h` or falls back
  to the 300-minute `limits[]` entry, plus `usages.limit_month_total`, and returns null on any other shape,
  so a vendor change degrades to "no recent data" instead of a crash or a wrong number.
- **The pill prefers Claude/Codex.** `latestRateLimitSnapshot` returns Kimi only when no Claude or Codex
  reading exists: those are what launches route on. An opted-in provider with no reading keeps a neutral
  pill, since the pill is the only way into the panel, but a **keyless** one (`missingKey` on
  `usageProviders`) does not, because no reading will ever arrive; its panel row and its Settings card ask
  for the key instead.

## Risks

The endpoint can change or disappear without notice; the parser then returns null and the row shows
"no recent data". Older builds re-saving the catalog drop `usageSource` (fails safe: tracking turns off).

## Alternatives considered

- Polling every custom provider with a key: sends keys to endpoints that never asked for it. Rejected.
- Detecting Kimi from the base URL: brittle with proxies and regional hosts; an explicit choice is clearer.
- Always showing the pill for any opted-in provider: a keyless one would hold an empty pill forever.
