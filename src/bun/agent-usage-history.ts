import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { TokenCounts } from "../shared/agent-pricing";
import type { AgentUsageSource } from "../shared/types";
import { atomicWriteFile } from "./atomic-write";
import { withFileLock } from "./file-lock";
import { createLogger } from "./logger";
import { DEV3_HOME } from "./paths";
import { mergeUsageRecord, newUsageState, type UsageRecord, type UsageState } from "./rpc-handlers/agent-usage-parse";

const log = createLogger("agent-usage-history");
const HISTORY_FILE = join(DEV3_HOME, "agent-usage-history-v1.json");
const COUNT_KEYS = ["inputTokens", "outputTokens", "cacheCreationInputTokens", "cacheReadInputTokens", "cacheCreation5mInputTokens", "cacheCreation1hInputTokens"] as const;
type LegacyStates = { claude: UsageState; codex: UsageState };
type States = Partial<Record<AgentUsageSource, UsageState>>;

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
	if (r.cumulativeScope !== undefined && (typeof r.cumulativeScope !== "string" || !r.cumulativeScope)) throw new Error("Invalid cumulative usage scope");
	return {
		model: r.model, timestamp: r.timestamp, counts,
		...(r.pricingModel ? { pricingModel: r.pricingModel } : {}),
		...(r.cumulativeScope ? { cumulativeScope: r.cumulativeScope } : {}),
	};
}

function restoreState(records: unknown, superseded: unknown = []): UsageState {
	const state = newUsageState();
	if (!Array.isArray(superseded) || superseded.some((key: unknown) => typeof key !== "string")) throw new Error("Invalid superseded usage identities");
	for (const key of superseded) state.superseded.add(key);
	if (!Array.isArray(records)) throw new Error("Invalid usage history source");
	for (const pair of records) {
		if (!Array.isArray(pair) || pair.length !== 2 || typeof pair[0] !== "string") throw new Error("Invalid usage history identity");
		mergeUsageRecord(state, pair[0], readRecord(pair[1]));
	}
	return state;
}

function readHistory(): LegacyStates {
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
		states[source] = restoreState(parsed[source], parsed.superseded?.[source] ?? []);
	}
	return states;
}

function sameRecord(previous: UsageRecord | undefined, next: UsageRecord | undefined): boolean {
	if (!previous || !next) return previous === next;
	return previous.model === next.model && previous.timestamp === next.timestamp &&
		previous.pricingModel === next.pricingModel && previous.cumulativeScope === next.cumulativeScope &&
		COUNT_KEYS.every((key) => previous.counts[key] === next.counts[key]);
}

function mergeState(retained: UsageState, current: UsageState): boolean {
	let changed = false;
	for (const key of current.superseded) {
		if (!retained.superseded.has(key)) changed = true;
		retained.superseded.add(key);
	}
	for (const key of retained.superseded) if (retained.records.delete(key)) changed = true;
	for (const [key, value] of current.records) {
		const previous = retained.records.get(key);
		mergeUsageRecord(retained, key, value);
		if (!sameRecord(previous, retained.records.get(key))) changed = true;
	}
	return changed;
}

async function retainLegacyHistory(current: States): Promise<States> {
	try {
		return await withFileLock(HISTORY_FILE, async () => {
			const retained = readHistory();
			let changed = false;
			for (const source of ["claude", "codex"] as const) {
				if (current[source]) changed = mergeState(retained[source], current[source]) || changed;
			}
			if (!changed) return retained;
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

type AdditionalSource = Exclude<AgentUsageSource, "claude" | "codex">;
const ADDITIONAL_SOURCES: AdditionalSource[] = ["gemini", "cursor", "copilot", "opencode", "pi", "omp"];

async function retainAdditionalHistory(source: AdditionalSource, current: UsageState): Promise<UsageState> {
	const file = join(DEV3_HOME, `agent-usage-history-${source}-v1.json`);
	try {
		return await withFileLock(file, async () => {
			let retained = newUsageState();
			try {
				const parsed = JSON.parse(readFileSync(file, "utf8"));
				if (parsed?.version !== 1) throw new Error("Unsupported usage history version");
				retained = restoreState(parsed.records, parsed.superseded ?? []);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			}
			if (!mergeState(retained, current)) return retained;
			mkdirSync(DEV3_HOME, { recursive: true });
			await atomicWriteFile(file, JSON.stringify({ version: 1, records: [...retained.records], superseded: [...retained.superseded] }));
			return retained;
		}, { staleThreshold: 120_000 });
	} catch (error) {
		log.warn("Usage history unavailable; returning current logs", { source, error: String(error) });
		return current;
	}
}

/** Keep new agent stores separate so older two-source writers cannot erase their history. */
export async function retainUsageHistory<S extends AgentUsageSource>(current: Record<S, UsageState>): Promise<Record<S, UsageState>> {
	const requested: States = current;
	const result: States = { ...current };
	const work: Promise<void>[] = [];
	if (requested.claude || requested.codex) {
		work.push(retainLegacyHistory(requested).then((retained) => {
			for (const source of ["claude", "codex"] as const) if (requested[source]) result[source] = retained[source];
		}));
	}
	for (const source of ADDITIONAL_SOURCES) {
		const state = requested[source];
		if (state) work.push(retainAdditionalHistory(source, state).then((retained) => { result[source] = retained; }));
	}
	await Promise.all(work);
	return result as Record<S, UsageState>;
}
