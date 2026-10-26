import { computeTokenCostUsd, resolveModelRate, type ModelRate, type TokenCounts } from "../../shared/agent-pricing";
import type { AgentUsageDay, AgentUsageSource } from "../../shared/types";

/** Content-free response snapshots; identities let history survive source-log cleanup. */
export interface UsageRecord {
	model: string;
	pricingModel?: string;
	cumulativeScope?: string;
	timestamp: number;
	counts: TokenCounts;
}

type CodexTotals = [number, number, number, number];

export interface UsageState {
	records: Map<string, UsageRecord>;
	superseded: Set<string>;
	codexCumulativeSeen: Set<string>;
	codexLegacyByCumulative: Map<string, Set<string>>;
	codexNativeCumulative: Set<string>;
	codexNativeSnapshots: Map<string, CodexTotals>;
	codexNativeTotals: CodexTotals;
	codexModel: string;
	codexNativeStarted: boolean;
	codexSession: string;
}

export function newUsageState(): UsageState {
	return {
		records: new Map(), superseded: new Set(), codexCumulativeSeen: new Set(), codexModel: "gpt-5",
		codexLegacyByCumulative: new Map(), codexNativeCumulative: new Set(),
		codexNativeSnapshots: new Map(), codexNativeTotals: [0, 0, 0, 0],
		codexNativeStarted: false, codexSession: "",
	};
}

function record(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function finiteNumber(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : 0;
}

function timestampOf(entry: Record<string, unknown>): number | null {
	const value = typeof entry.timestamp === "string" ? Date.parse(entry.timestamp) : NaN;
	return Number.isFinite(value) ? value : null;
}

/** A response can appear as several streaming snapshots and in several copied logs. */
export function mergeUsageRecord(state: UsageState, key: string, next: UsageRecord): void {
	if (state.superseded.has(key)) return;
	const previous = state.records.get(key);
	const legacy = key.startsWith("codex-legacy:");
	const keepPrevious = previous && (legacy ? previous.timestamp <= next.timestamp
		: previous.timestamp > next.timestamp ||
			previous.timestamp === next.timestamp && previous.counts.outputTokens > next.counts.outputTokens);
	const merged: UsageRecord = {
		...(keepPrevious ? previous : next),
		pricingModel: previous?.pricingModel ?? next.pricingModel,
		cumulativeScope: previous?.cumulativeScope ?? next.cumulativeScope,
	};
	if (previous && key.startsWith("cursor:")) {
		merged.timestamp = Math.min(previous.timestamp, next.timestamp);
		if (previous.model === next.model) {
			merged.counts = { ...previous.counts, ...next.counts };
			for (const token of Object.keys(merged.counts) as (keyof TokenCounts)[]) {
				merged.counts[token] = Math.max(previous.counts[token] ?? 0, next.counts[token] ?? 0);
			}
		}
	}
	state.records.set(key, merged);
}

export function foldClaudeEntry(state: UsageState, entry: unknown): void {
	const e = record(entry);
	if (!e || e.type !== "assistant") return;
	const msg = record(e.message);
	const usage = record(msg?.usage);
	const timestamp = timestampOf(e);
	if (!msg || !usage || timestamp === null) return;
	const model = typeof msg.model === "string" ? msg.model : "unknown";
	if (model === "<synthetic>") return;
	const cacheCreation = record(usage.cache_creation);
	const cacheTotal = finiteNumber(usage.cache_creation_input_tokens);
	const cache5m = finiteNumber(cacheCreation?.ephemeral_5m_input_tokens);
	const cache1h = finiteNumber(cacheCreation?.ephemeral_1h_input_tokens);
	const counts: TokenCounts = {
		inputTokens: finiteNumber(usage.input_tokens),
		outputTokens: finiteNumber(usage.output_tokens),
		cacheCreationInputTokens: cacheTotal,
		cacheReadInputTokens: finiteNumber(usage.cache_read_input_tokens),
		cacheCreation5mInputTokens: cache5m + Math.max(0, cacheTotal - cache5m - cache1h),
		cacheCreation1hInputTokens: cache1h,
	};
	const identity = msg.id || e.requestId ? [msg.id ?? "", e.requestId ?? ""]
		: [e.uuid ?? timestamp, model, counts];
	mergeUsageRecord(state, `claude:${JSON.stringify(identity)}`, { model, timestamp, counts });
}

/** Reset only the per-file context, retaining usage from previous files. */
export function beginCodexRollout(state: UsageState): void {
	state.codexModel = "gpt-5";
	state.codexCumulativeSeen.clear();
	state.codexLegacyByCumulative.clear();
	state.codexNativeCumulative.clear();
	state.codexNativeSnapshots.clear();
	state.codexNativeTotals = [0, 0, 0, 0];
	state.codexNativeStarted = false;
	state.codexSession = "";
}

function cumulativeSignature(usage: Record<string, unknown> | undefined): string | null {
	const values = [usage?.input_tokens, usage?.output_tokens, usage?.cached_input_tokens ?? 0, usage?.cache_write_input_tokens ?? 0];
	return values.every((v) => typeof v === "number" && Number.isFinite(v) && v >= 0) ? values.join(":") : null;
}

function supersedeLegacy(state: UsageState, cumulative: string): void {
	const keys = new Set(state.codexLegacyByCumulative.get(cumulative));
	if (state.codexSession) keys.add(`codex-legacy:${JSON.stringify([state.codexSession, cumulative])}`);
	for (const key of keys) {
		state.superseded.add(key);
		state.records.delete(key);
	}
}

export function foldCodexEntry(state: UsageState, entry: unknown): void {
	const e = record(entry);
	const payload = record(e?.payload);
	if (!e || !payload) return;
	if (e.type === "session_meta") {
		state.codexSession = typeof payload.id === "string" ? payload.id : "";
		return;
	}
	if (e.type === "turn_context") {
		if (typeof payload.model === "string" && payload.model.trim()) state.codexModel = payload.model;
		return;
	}
	const native = e.type === "token_usage_record";
	if (!native && (e.type !== "event_msg" || payload.type !== "token_count")) return;
	const info = record(payload.info);
	const usage = native ? record(payload.usage) : record(info?.last_token_usage);
	const timestamp = timestampOf(e);
	if (!usage || timestamp === null) return;
	const input = finiteNumber(usage.input_tokens);
	const cachedInput = Math.min(input, finiteNumber(usage.cached_input_tokens));
	const cacheWrite = Math.min(input - cachedInput, finiteNumber(usage.cache_write_input_tokens));
	const output = finiteNumber(usage.output_tokens);
	if (input === 0 && output === 0) return;
	let key: string;
	if (native) {
		state.codexNativeStarted = true;
		key = `codex-native:${typeof payload.response_id === "string" && payload.response_id
			? payload.response_id : JSON.stringify([state.codexSession, timestamp, usage])}`;
		const values: CodexTotals = [input, output, cachedInput, cacheWrite];
		const previous = state.codexNativeSnapshots.get(key);
		for (let i = 0; i < values.length; i++) state.codexNativeTotals[i] += values[i] - (previous?.[i] ?? 0);
		state.codexNativeSnapshots.set(key, values);
		const cumulative = cumulativeSignature(record(payload.thread_token_usage)) ?? state.codexNativeTotals.join(":");
		state.codexNativeCumulative.add(cumulative);
		supersedeLegacy(state, cumulative);
	} else {
		const cumulative = cumulativeSignature(record(info?.total_token_usage));
		if (!cumulative && state.codexNativeStarted) return;
		if (cumulative && state.codexCumulativeSeen.has(cumulative)) return;
		if (cumulative) state.codexCumulativeSeen.add(cumulative);
		const identity = cumulative && state.codexSession ? [state.codexSession, cumulative]
			: [timestamp, state.codexModel, input, cachedInput, cacheWrite, output];
		key = `codex-legacy:${JSON.stringify(identity)}`;
		if (cumulative) {
			let keys = state.codexLegacyByCumulative.get(cumulative);
			if (!keys) state.codexLegacyByCumulative.set(cumulative, keys = new Set());
			keys.add(key);
			if (state.codexNativeCumulative.has(cumulative)) {
				supersedeLegacy(state, cumulative);
				return;
			}
		}
	}
	mergeUsageRecord(state, key, {
		model: state.codexModel, timestamp,
		counts: {
			inputTokens: input - cachedInput - cacheWrite,
			outputTokens: output, cacheReadInputTokens: cachedInput, cacheCreationInputTokens: cacheWrite,
		},
	});
}

function recordsForReport(state: UsageState): UsageRecord[] {
	const records: UsageRecord[] = [];
	const checkpoints = new Map<string, UsageRecord[]>();
	for (const snapshot of state.records.values()) {
		if (!snapshot.cumulativeScope) { records.push(snapshot); continue; }
		const key = JSON.stringify([snapshot.cumulativeScope, snapshot.model]);
		let group = checkpoints.get(key);
		if (!group) checkpoints.set(key, group = []);
		group.push(snapshot);
	}
	for (const group of checkpoints.values()) {
		const highWater: Partial<TokenCounts> = {};
		group.sort((a, b) => a.timestamp - b.timestamp);
		for (const snapshot of group) {
			const counts = { ...snapshot.counts };
			for (const key of Object.keys(counts) as (keyof TokenCounts)[]) {
				const total = counts[key] ?? 0;
				counts[key] = Math.max(0, total - (highWater[key] ?? 0));
				highWater[key] = Math.max(total, highWater[key] ?? 0);
			}
			if (counts.inputTokens + counts.outputTokens + counts.cacheReadInputTokens + counts.cacheCreationInputTokens > 0) {
				records.push({ ...snapshot, counts });
			}
		}
	}
	return records;
}

/** Reprice retained raw counts on every report, including newly recognised models. */
export function finalizeUsage(
	state: UsageState,
	source: AgentUsageSource,
	pricingId: (model: string) => string = (model) => model,
	resolveRate: (model: string) => ModelRate | null = resolveModelRate,
): { days: AgentUsageDay[]; hasUnpriced: boolean } {
	const byDate = new Map<string, AgentUsageDay>();
	let hasUnpriced = false;
	for (const { model, pricingModel, timestamp, counts } of recordsForReport(state)) {
		const d = new Date(timestamp);
		const startMs = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
		const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
		let row = byDate.get(date);
		if (!row) {
			row = {
				date, startMs, source, inputTokens: 0, outputTokens: 0,
				cacheCreationInputTokens: 0, cacheReadInputTokens: 0, costUsd: 0, fullyPriced: true,
			};
			byDate.set(date, row);
		}
		row.inputTokens += counts.inputTokens;
		row.outputTokens += counts.outputTokens;
		row.cacheCreationInputTokens += counts.cacheCreationInputTokens;
		row.cacheReadInputTokens += counts.cacheReadInputTokens;
		const { costUsd, priced } = computeTokenCostUsd(pricingModel ?? pricingId(model), counts, resolveRate);
		row.costUsd += costUsd;
		if (!priced) { row.fullyPriced = false; hasUnpriced = true; }
	}
	return { days: [...byDate.values()].sort((a, b) => a.startMs - b.startMs), hasUnpriced };
}

export function buildClaudeUsageDays(entries: unknown[]): { days: AgentUsageDay[]; hasUnpriced: boolean } {
	const state = newUsageState();
	for (const entry of entries) foldClaudeEntry(state, entry);
	return finalizeUsage(state, "claude");
}

export function buildCodexUsageDays(entries: unknown[]): { days: AgentUsageDay[]; hasUnpriced: boolean } {
	const state = newUsageState();
	beginCodexRollout(state);
	for (const entry of entries) foldCodexEntry(state, entry);
	return finalizeUsage(state, "codex");
}
