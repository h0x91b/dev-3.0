/**
 * How a usage record was paid for, from evidence inside the agent's own logs.
 * `undefined` means unknown — never treat it as either kind.
 * Rationale per harness: decisions/2026/11/18/classify-usage-billing-from-local-evidence.md
 */
export type UsageBilling = "api" | "subscription";

export function isUsageBilling(value: unknown): value is UsageBilling {
	return value === "api" || value === "subscription";
}

function* linesContaining(text: string, needle: string): Generator<unknown> {
	let at = text.indexOf(needle);
	while (at !== -1) {
		const start = text.lastIndexOf("\n", at) + 1;
		const newline = text.indexOf("\n", at);
		const end = newline === -1 ? text.length : newline;
		try { yield JSON.parse(text.slice(start, end)); } catch { /* partial line */ }
		at = text.indexOf(needle, end);
	}
}

function object(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

/**
 * Claude Code writes a `session-owner` line only for a claude.ai OAuth login
 * (Pro/Max/Team/Enterprise). Its absence proves nothing: older CLIs, setup
 * tokens and API keys all lack it.
 */
export function claudeTranscriptBilling(text: string): UsageBilling | undefined {
	for (const line of linesContaining(text, "\"session-owner\"")) {
		const entry = object(line);
		if (entry?.type === "session-owner" && typeof entry.accountUuid === "string" && entry.accountUuid) return "subscription";
	}
	return undefined;
}

/** Codex reports a ChatGPT `plan_type` with its rate limits only under a ChatGPT login. */
export function codexRolloutBilling(text: string): UsageBilling | undefined {
	for (const line of linesContaining(text, "\"plan_type\"")) {
		const plan = object(object(object(line)?.payload)?.rate_limits)?.plan_type;
		if (typeof plan === "string" && plan) return "subscription";
	}
	return undefined;
}

/** Providers reachable only through a plan login (OAuth). */
const SUBSCRIPTION_PROVIDERS = new Set(["github-copilot", "openai-codex", "google-gemini-cli", "google-antigravity"]);
/** Providers that only ever bill per token. */
const API_PROVIDERS = new Set([
	"openrouter", "opencode", "groq", "cerebras", "deepseek", "xai", "mistral", "together", "togetherai",
	"fireworks", "fireworks-ai", "deepinfra", "amazon-bedrock", "google-vertex", "google-vertex-anthropic",
	"azure", "azure-openai", "vercel", "perplexity",
]);

/**
 * OpenCode / pi provider ids. A provider with both login kinds (`anthropic`,
 * `openai`, `google`) is resolved by the harness's current auth file, which
 * reflects today's login rather than the day of the record.
 */
export function providerBilling(provider: unknown, authTypes: ReadonlyMap<string, string> = new Map()): UsageBilling | undefined {
	if (typeof provider !== "string" || !provider) return undefined;
	const id = provider.toLowerCase();
	if (SUBSCRIPTION_PROVIDERS.has(id)) return "subscription";
	if (API_PROVIDERS.has(id)) return "api";
	const auth = authTypes.get(id);
	if (auth === "oauth") return "subscription";
	if (auth === "api" || auth === "api_key") return "api";
	return undefined;
}

/** `{ provider: { type } }` auth files of OpenCode and pi, reduced to provider → type. */
export function parseProviderAuthTypes(json: unknown): Map<string, string> {
	const types = new Map<string, string>();
	for (const [provider, entry] of Object.entries(object(json) ?? {})) {
		const type = object(entry)?.type;
		if (typeof type === "string") types.set(provider.toLowerCase(), type);
	}
	return types;
}
