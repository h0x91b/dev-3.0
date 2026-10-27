import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { resolveModelRate, type ModelRate } from "../shared/agent-pricing";
import { atomicWriteFile } from "./atomic-write";
import { telemetryOptOutSync } from "./analytics-identity";
import { DEV3_HOME } from "./paths";

const FEED_URL = "https://models.dev/api.json";
const CACHE_FILE = join(DEV3_HOME, "agent-pricing-v1.json");
const DAY_MS = 24 * 60 * 60 * 1_000;
const MAX_FEED_BYTES = 16 * 1024 * 1024;
const CATALOG_REVISION = 1;
const PROVIDERS = ["openai", "anthropic", "google", "openrouter"] as const;
const RATE_FIELDS = ["input", "output", "cacheRead", "cacheWrite5m", "cacheWrite1h"] as const;
type Rates = Record<string, ModelRate>;
interface PricingCache { version: 1; catalogRevision?: number; fetchedAt: number; rates: Rates }

let cache: PricingCache | null = null;
let loaded = false;
let loading: Promise<void> | null = null;
let pending: Promise<void> | null = null;
let nextAttemptAt = 0;
let failures = 0;

function object(value: unknown): Record<string, unknown> | null {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function validPrice(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1_000_000;
}

function validRate(value: unknown): value is ModelRate {
	const rate = object(value);
	return rate !== null && RATE_FIELDS.every((key) => validPrice(rate[key]));
}

function validModelId(value: string): boolean {
	return /^[a-zA-Z0-9][a-zA-Z0-9._/:\[\]-]{0,199}$/.test(value);
}

function canonicalNativeId(id: string): string {
	const legacyClaude = /^claude-(\d+(?:\.\d+)?)-(opus|sonnet|haiku)(?:-(?:thinking|low|medium|high|xhigh|max))*$/.exec(id);
	if (legacyClaude) return `claude-${legacyClaude[2]}-${legacyClaude[1].replaceAll(".", "-")}`;
	const claude = /^(?:claude-)?(opus|sonnet|haiku)-(\d+(?:[.-]\d+)?)(?:-(?:thinking|low|medium|high|xhigh|max))*$/.exec(id);
	if (claude) return `claude-${claude[1]}-${claude[2].replaceAll(".", "-")}`;
	return id;
}

function bundledRate(id: string): ModelRate | null {
	if (!id.includes("/")) return resolveModelRate(canonicalNativeId(id));
	const prefix = /^(openai|anthropic|google|deepseek|z-ai|qwen|moonshotai)\//.exec(id);
	return prefix ? resolveModelRate(canonicalNativeId(id.slice(prefix[0].length))) : null;
}

function readCachedRates(value: unknown): PricingCache | null {
	const stored = object(value);
	const rawRates = object(stored?.rates);
	if (stored?.version !== 1 || typeof stored.fetchedAt !== "number" ||
		!Number.isFinite(stored.fetchedAt) || stored.fetchedAt < 0) return null;
	if (!rawRates || (stored.fetchedAt as number) > Date.now() + 5 * 60_000) return null;
	const rates: Rates = Object.create(null);
	for (const [key, rate] of Object.entries(rawRates)) {
		if (PROVIDERS.some((provider) => key.startsWith(`${provider}:`)) && validModelId(key) && validRate(rate)) rates[key] = rate;
	}
	return Object.keys(rates).length ? {
		version: 1, fetchedAt: stored.fetchedAt as number, rates,
		catalogRevision: stored.catalogRevision === CATALOG_REVISION ? CATALOG_REVISION : 0,
	} : null;
}

async function loadCache(): Promise<void> {
	try {
		const text = await readFile(CACHE_FILE, "utf8");
		if (text.length <= MAX_FEED_BYTES) cache = readCachedRates(JSON.parse(text));
	} catch { /* Missing or invalid cache falls back to bundled rates. */ }
	loaded = true;
}

function feedRates(value: unknown): Rates {
	const feed = object(value);
	if (!feed) throw new Error("Invalid model pricing feed");
	const rates: Rates = Object.create(null);
	for (const provider of PROVIDERS) {
		const models = object(object(feed[provider])?.models);
		if (!models) continue;
		for (const [id, model] of Object.entries(models)) {
			if (!validModelId(id)) continue;
			const cost = object(object(model)?.cost);
			if (!cost || !validPrice(cost.input) || !validPrice(cost.output)) continue;
			if (cost.cache_read !== undefined && !validPrice(cost.cache_read) ||
				cost.cache_write !== undefined && !validPrice(cost.cache_write)) continue;
			const key = `${provider}:${id.toLowerCase()}`;
			const previous = cache?.rates[key] ?? bundledRate(id);
			rates[key] = {
				input: cost.input, output: cost.output,
				cacheRead: cost.cache_read as number | undefined ?? previous?.cacheRead ?? cost.input,
				cacheWrite5m: cost.cache_write as number | undefined ?? previous?.cacheWrite5m ?? cost.input * 1.25,
				cacheWrite1h: cost.input * 2,
			};
		}
	}
	if (!Object.keys(rates).length) throw new Error("No valid model pricing in feed");
	return rates;
}

async function readFeed(response: Response): Promise<unknown> {
	if (!response.ok || !response.body) throw new Error("Model pricing feed unavailable");
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	try {
		while (true) {
			const { value, done } = await reader.read();
			if (done) break;
			size += value.byteLength;
			if (size > MAX_FEED_BYTES) throw new Error("Model pricing feed too large");
			chunks.push(value);
		}
	} finally {
		await reader.cancel().catch(() => {});
	}
	return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function refresh(): Promise<void> {
	const now = Date.now();
	if (now < nextAttemptAt || cache && cache.catalogRevision === CATALOG_REVISION && now - cache.fetchedAt < DAY_MS) return;
	if (telemetryOptOutSync()) return;
	try {
		// A fixed full-feed GET discloses no model choices, account state, or local content.
		const response = await fetch(FEED_URL, {
			method: "GET", redirect: "error", credentials: "omit", referrerPolicy: "no-referrer",
			signal: AbortSignal.timeout(5_000),
		});
		const rates = feedRates(await readFeed(response));
		const updated: PricingCache = {
			version: 1, catalogRevision: CATALOG_REVISION, fetchedAt: now,
			rates: Object.assign(Object.create(null), cache?.rates, rates),
		};
		await mkdir(DEV3_HOME, { recursive: true });
		await atomicWriteFile(CACHE_FILE, JSON.stringify(updated));
		cache = updated;
		failures = 0;
		nextAttemptAt = 0;
	} catch {
		failures++;
		nextAttemptAt = now + Math.min(DAY_MS, 5 * 60_000 * 2 ** Math.min(failures - 1, 8));
	}
}

function resolveFrom(rates: Rates): (modelId: string) => ModelRate | null {
	return (modelId) => {
		const id = modelId.trim().toLowerCase().replace(/\[\d+[km]\]$/, "");
		const routedId = id.startsWith("openrouter/") ? id.slice("openrouter/".length) : id;
		const nativePrefix = !id.startsWith("openrouter/") && /^(openai|anthropic|google)\//.exec(id);
		const nativeId = canonicalNativeId(nativePrefix ? id.slice(nativePrefix[0].length) : id);
		const rate = id.includes("/")
			? rates[`openrouter:${routedId}`] ?? (nativePrefix ? rates[`${nativePrefix[1]}:${nativeId}`] : undefined)
			: rates[`openai:${id}`] ?? rates[`anthropic:${id}`] ?? rates[`google:${id}`]
				?? rates[`openai:${nativeId}`] ?? rates[`anthropic:${nativeId}`] ?? rates[`google:${nativeId}`];
		return rate ?? bundledRate(routedId);
	};
}

async function ensureCacheLoaded(): Promise<void> {
	if (loaded) return;
	loading ??= loadCache().finally(() => { loading = null; });
	await loading;
}

/** Return saved prices immediately; refresh future reports without blocking on the network. */
export async function getPricingResolver(): Promise<(modelId: string) => ModelRate | null> {
	await ensureCacheLoaded();
	const rates = cache?.rates ?? {};
	if (!pending) pending = refresh().finally(() => { pending = null; });
	return resolveFrom(rates);
}

/**
 * The resolver the usage report would use right now, for `dev3 stats prices`, and
 * when the saved table was fetched (null: built-in rates only). Never fetches.
 */
export async function describePricing(): Promise<{ fetchedAt: number | null; resolve: (modelId: string) => ModelRate | null }> {
	await ensureCacheLoaded();
	return { fetchedAt: cache?.fetchedAt ?? null, resolve: resolveFrom(cache?.rates ?? {}) };
}
