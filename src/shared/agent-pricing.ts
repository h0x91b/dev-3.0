/**
 * Agent token pricing — used to turn locally-parsed token counts into an
 * *API-equivalent* USD cost for the usage dashboard.
 *
 * IMPORTANT framing for the UI: subscription users (Claude Pro/Max/Team,
 * ChatGPT Plus/Pro/Team) do NOT actually pay these amounts. Anthropic/OpenAI
 * subsidise usage under the subscription. This number is "what it *would* cost
 * if you paid per-token at public API rates" — a proxy for how much value the
 * subscription is delivering, not a bill. Always label it that way.
 *
 * Prices are USD per 1,000,000 tokens. Anthropic cache writes use the public
 * 5-minute/1-hour multipliers; cache reads use the model's explicit public
 * rate when supplied (OpenAI) or default to 0.1x base input (Anthropic).
 *
 * Unknown models resolve to `null` (graceful absence) — the caller still counts
 * their tokens but contributes 0 cost and should surface an "unpriced" flag
 * rather than guessing.
 */

/** Per-model base rates, USD per 1M tokens. */
export interface ModelBaseRate {
	input: number;
	output: number;
	/** Explicit prompt-cache read rate. Defaults to 10% of input when omitted. */
	cacheRead?: number;
}

/** Fully-resolved per-model rates including derived cache rates. */
export interface ModelRate {
	input: number;
	output: number;
	cacheWrite5m: number;
	cacheWrite1h: number;
	cacheRead: number;
}

/** Raw token counts for a single model, as parsed from a transcript/rollout. */
export interface TokenCounts {
	inputTokens: number;
	outputTokens: number;
	/** Undifferentiated cache-creation tokens (priced at the 5m rate unless split out below). */
	cacheCreationInputTokens: number;
	cacheReadInputTokens: number;
	/** Optional finer split of cache-creation into 5m / 1h ephemeral buckets (Claude transcripts provide this). */
	cacheCreation5mInputTokens?: number;
	cacheCreation1hInputTokens?: number;
}

const PER_MILLION = 1_000_000;

/**
 * Base input/output rates keyed by a normalised model family. Cache rates are
 * derived, not stored. Keep this ordered most-specific → least-specific; the
 * resolver matches by prefix so `opus-4-8` wins before a generic `opus`.
 */
const BASE_RATES: ReadonlyArray<{ match: (id: string) => boolean; rate: ModelBaseRate }> = [
	// --- OpenAI / Codex ---
	// Preview models without public API pricing are deliberately omitted.
	{ match: (id) => id.includes("gpt-5.5") && !id.includes("cyber"), rate: { input: 5, output: 30, cacheRead: 0.5 } },
	{ match: (id) => id.includes("gpt-5.4-mini"), rate: { input: 0.75, output: 4.5, cacheRead: 0.075 } },
	{ match: (id) => id.includes("gpt-5.4"), rate: { input: 2.5, output: 15, cacheRead: 0.25 } },
	{
		match: (id) => id.includes("gpt-5.3-codex") && !id.includes("spark"),
		rate: { input: 1.75, output: 14, cacheRead: 0.175 },
	},
	{ match: (id) => id.includes("gpt-5.2"), rate: { input: 1.75, output: 14, cacheRead: 0.175 } },
	{ match: (id) => id.includes("gpt-5.1-codex-mini"), rate: { input: 0.25, output: 2, cacheRead: 0.025 } },
	{ match: (id) => id.includes("gpt-5.1"), rate: { input: 1.25, output: 10, cacheRead: 0.125 } },
	{ match: (id) => id.includes("gpt-5-codex-mini"), rate: { input: 0.25, output: 2, cacheRead: 0.025 } },
	{ match: (id) => id.includes("gpt-5-codex") || id === "gpt-5", rate: { input: 1.25, output: 10, cacheRead: 0.125 } },
	// --- Anthropic / Claude ---
	{ match: (id) => id.includes("fable-5") || id.includes("mythos-5") || id.includes("mythos-preview"), rate: { input: 10, output: 50 } },
	// Current Opus tier (4.5 – 4.8): $5 / $25
	{ match: (id) => /opus-4-[5678]/.test(id), rate: { input: 5, output: 25 } },
	// Legacy Opus (4.0 / 4.1 / 3): $15 / $75
	{ match: (id) => /opus-4-[01]/.test(id) || id.includes("opus-3") || /3-opus/.test(id), rate: { input: 15, output: 75 } },
	// Any other opus → treat as current tier
	{ match: (id) => id.includes("opus"), rate: { input: 5, output: 25 } },
	// Sonnet (all 3.x/4.x and the "sonnet-5" placeholder): $3 / $15
	{ match: (id) => id.includes("sonnet"), rate: { input: 3, output: 15 } },
	// Haiku 4.5 / newer: $1 / $5
	{ match: (id) => /haiku-4/.test(id) || /haiku-[5-9]/.test(id), rate: { input: 1, output: 5 } },
	// Haiku 3.5: $0.80 / $4
	{ match: (id) => /haiku-3-5/.test(id) || /3-5-haiku/.test(id), rate: { input: 0.8, output: 4 } },
	// Haiku 3 (and any other haiku): $0.25 / $1.25
	{ match: (id) => id.includes("haiku"), rate: { input: 0.25, output: 1.25 } },
];

/** Normalise a raw model id ("claude-opus-4-8", "claude-haiku-4-5-20251001") for matching. */
function normaliseModelId(modelId: string): string {
	return modelId.trim().toLowerCase();
}

/**
 * Resolve full per-model rates (incl. derived cache rates) for a model id.
 * Returns `null` for an unrecognised model — the caller must handle absence.
 */
export function resolveModelRate(modelId: string): ModelRate | null {
	const id = normaliseModelId(modelId);
	if (!id) return null;
	const base = BASE_RATES.find((r) => r.match(id))?.rate;
	if (!base) return null;
	return {
		input: base.input,
		output: base.output,
		cacheWrite5m: base.input * 1.25,
		cacheWrite1h: base.input * 2,
		cacheRead: base.cacheRead ?? base.input * 0.1,
	};
}

/**
 * Compute the API-equivalent USD cost of a bundle of token counts for one model.
 * Returns `{ costUsd: 0, priced: false }` when the model is unknown so the UI can
 * flag that some usage could not be priced instead of silently under-counting.
 */
export function computeTokenCostUsd(modelId: string, tokens: TokenCounts): { costUsd: number; priced: boolean } {
	const rate = resolveModelRate(modelId);
	if (!rate) return { costUsd: 0, priced: false };

	// Split cache-creation into 5m / 1h when the finer breakdown is available;
	// otherwise price the whole lump at the (cheaper) 5m rate.
	const has5m = typeof tokens.cacheCreation5mInputTokens === "number";
	const has1h = typeof tokens.cacheCreation1hInputTokens === "number";
	const cache5m = has5m || has1h
		? tokens.cacheCreation5mInputTokens ?? 0
		: tokens.cacheCreationInputTokens;
	const cache1h = tokens.cacheCreation1hInputTokens ?? 0;

	const costUsd =
		(tokens.inputTokens * rate.input +
			tokens.outputTokens * rate.output +
			cache5m * rate.cacheWrite5m +
			cache1h * rate.cacheWrite1h +
			tokens.cacheReadInputTokens * rate.cacheRead) /
		PER_MILLION;

	return { costUsd, priced: true };
}

/** Sum of all token categories (for a headline "tokens used" figure). */
export function totalTokens(tokens: TokenCounts): number {
	return (
		tokens.inputTokens +
		tokens.outputTokens +
		tokens.cacheCreationInputTokens +
		tokens.cacheReadInputTokens
	);
}
