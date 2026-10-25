import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { TokenCounts } from "../shared/agent-pricing";
import { atomicWriteFile } from "./atomic-write";
import { withFileLock } from "./file-lock";
import { createLogger } from "./logger";
import { DEV3_HOME } from "./paths";
import { mergeUsageRecord, newUsageState, type UsageRecord, type UsageState } from "./rpc-handlers/agent-usage-parse";

const log = createLogger("agent-usage-history");
const HISTORY_FILE = join(DEV3_HOME, "agent-usage-history-v1.json");
const COUNT_KEYS = ["inputTokens", "outputTokens", "cacheCreationInputTokens", "cacheReadInputTokens", "cacheCreation5mInputTokens", "cacheCreation1hInputTokens"] as const;
type States = { claude: UsageState; codex: UsageState };

function readRecord(value: unknown): UsageRecord {
	if (!value || typeof value !== "object") throw new Error("Invalid usage history record");
	const r = value as UsageRecord;
	if (typeof r.model !== "string" || !Number.isFinite(r.timestamp) || !r.counts || typeof r.counts !== "object") {
		throw new Error("Invalid usage history record");
	}
	const counts = {} as TokenCounts;
	for (const key of COUNT_KEYS) {
		const n = r.counts[key];
		if (n === undefined && key.startsWith("cacheCreation") && key !== "cacheCreationInputTokens") continue;
		if (typeof n !== "number" || !Number.isFinite(n) || n < 0) throw new Error("Invalid usage history count");
		counts[key] = n;
	}
	if (r.pricingModel !== undefined && typeof r.pricingModel !== "string") throw new Error("Invalid usage pricing identity");
	return { model: r.model, timestamp: r.timestamp, counts, ...(r.pricingModel ? { pricingModel: r.pricingModel } : {}) };
}

function readHistory(): States {
	let raw: string;
	try { raw = readFileSync(HISTORY_FILE, "utf8"); }
	catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { claude: newUsageState(), codex: newUsageState() };
		throw error;
	}
	const parsed = JSON.parse(raw);
	if (parsed?.version !== 1) throw new Error("Unsupported usage history version");
	const states = { claude: newUsageState(), codex: newUsageState() };
	for (const source of ["claude", "codex"] as const) {
		const superseded = parsed.superseded?.[source] ?? [];
		if (!Array.isArray(superseded) || superseded.some((key: unknown) => typeof key !== "string")) throw new Error("Invalid superseded usage identities");
		for (const key of superseded) states[source].superseded.add(key);
		if (!Array.isArray(parsed[source])) throw new Error("Invalid usage history source");
		for (const pair of parsed[source]) {
			if (!Array.isArray(pair) || pair.length !== 2 || typeof pair[0] !== "string") throw new Error("Invalid usage history identity");
			mergeUsageRecord(states[source], pair[0], readRecord(pair[1]));
		}
	}
	return states;
}

/** Merge by response identity, never by daily maxima: missing logs must not offset new work. */
export async function retainUsageHistory(current: States): Promise<States> {
	try {
		return await withFileLock(HISTORY_FILE, async () => {
			const retained = readHistory();
			for (const source of ["claude", "codex"] as const) {
				for (const key of current[source].superseded) retained[source].superseded.add(key);
				for (const key of retained[source].superseded) retained[source].records.delete(key);
				for (const [key, value] of current[source].records) mergeUsageRecord(retained[source], key, value);
			}
			mkdirSync(DEV3_HOME, { recursive: true });
			await atomicWriteFile(HISTORY_FILE, JSON.stringify({
				version: 1, claude: [...retained.claude.records], codex: [...retained.codex.records],
				superseded: { claude: [...retained.claude.superseded], codex: [...retained.codex.superseded] },
			}));
			return retained;
		}, { staleThreshold: 120_000 });
	} catch (error) {
		// Leave unreadable or newer history intact; live usage remains available.
		log.warn("Usage history unavailable; returning current logs", { error: String(error) });
		return current;
	}
}
