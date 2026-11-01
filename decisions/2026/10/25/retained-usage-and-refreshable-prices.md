# Retained usage and refreshable prices

Extended on 2026-10-26 by [usage collectors for major agents](../26/usage-collectors-for-major-agents.md) with Gemini, Cursor and Copilot sources and separate additive history files.
Extended on 2026-11-01 by [usage scan reads only what history lacks](../../11/01/usage-scan-reads-only-what-history-lacks.md): the "full reads" follow-up below is addressed for transcripts.

## Context

All and MTD costs were rebuilt from surviving transcript files and a bundled price table. Cleanup could remove previously counted usage, and newly released models could contribute no cost until an app update.

## Investigation

`conversation-archive.ts` already documents agent transcript retention; its conversation dumps do not preserve sufficient per-model billing detail to recover accurate costs. Newer Codex logs contain native `token_usage_record` responses followed by legacy token-count echoes. GPT-6.1 Sol was missing from the bundled table despite published pricing.

## Decision

`agent-usage-history.ts` retains identified raw token snapshots in additive `agent-usage-history-v1.json`, merging under a cross-process lock and writing atomically; unknown/corrupt formats stay untouched. `agent-usage-parse.ts` reconciles legacy echoes against native cumulative totals in either event order and keeps unmatched legacy history; persisted superseded identities prevent old echoes returning on subsequent scans. Repeated legacy snapshots keep their original date, and resolved catalog model identities survive label changes. `agent-pricing-refresh.ts` fetches the complete [models.dev feed](https://github.com/anomalyco/models.dev/blob/dev/README.md) daily with bounded requests and retries, validating prices and retaining last-known rates in `agent-pricing-v1.json`; bundled prices remain the offline fallback.

## Risks

History contains only locally stored identities, model names, timestamps and token counts; it cannot reconstruct logs deleted before the first scan. The fixed anonymous pricing GET sends no local models, account data, paths or prompts, and the provider receives no request-specific identifiers. Historical API-equivalent estimates use current rates and can change when pricing changes; model-specific long-context and service-tier premiums remain outside this estimate.

The host's telemetry opt-out verdict gates every pricing request, including environment and in-app opt-outs. Reports return saved/bundled prices without waiting on the network; a background refresh updates subsequent reports. Unchanged history merges skip writes, while full reads and unbounded identity storage remain a documented scaling follow-up.

## Alternatives considered

Daily high-water totals lose new work whenever missing logs offset it, so history must merge by record identity. Freezing only dollar totals prevents correcting formerly unpriced models; raw counts permit repricing retained history. Scraping pricing HTML is less reliable than a structured catalog, while requiring every price change to ship in an app release repeats the original gap.
