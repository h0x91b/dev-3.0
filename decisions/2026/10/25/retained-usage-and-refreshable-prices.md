# Retained usage and refreshable prices

## Context

All and MTD costs were rebuilt from surviving transcript files and a bundled price table. Cleanup could remove previously counted usage, and newly released models could contribute no cost until an app update.

## Investigation

`conversation-archive.ts` already documents agent transcript retention; its conversation dumps do not preserve sufficient per-model billing detail to recover accurate costs. Newer Codex logs contain native `token_usage_record` responses followed by legacy token-count echoes. GPT-6.1 Sol was missing from the bundled table despite published pricing.

## Decision

`agent-usage-history.ts` retains identified raw token snapshots in additive `agent-usage-history-v1.json`, merging under a cross-process lock and writing atomically; unknown/corrupt formats stay untouched. `agent-usage-parse.ts` keeps a rollout's legacy prefix, then uses native response identities without summing their legacy echoes. `agent-pricing-refresh.ts` fetches the complete [models.dev feed](https://github.com/anomalyco/models.dev/blob/dev/README.md) daily with bounded requests and retries, validating prices and retaining last-known rates in `agent-pricing-v1.json`; bundled prices remain the offline fallback.

## Risks

History contains only locally stored identities, model names, timestamps and token counts; it cannot reconstruct logs deleted before the first scan. The fixed anonymous pricing GET sends no local models, account data, paths or prompts, and the provider receives no request-specific identifiers. Historical API-equivalent estimates use current rates and can change when pricing changes; model-specific long-context and service-tier premiums remain outside this estimate.

## Alternatives considered

Daily high-water totals lose new work whenever missing logs offset it, so history must merge by record identity. Freezing only dollar totals prevents correcting formerly unpriced models; raw counts permit repricing retained history. Scraping pricing HTML is less reliable than a structured catalog, while requiring every price change to ship in an app release repeats the original gap.
