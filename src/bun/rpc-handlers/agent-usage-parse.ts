import { computeTokenCostUsd, resolveModelRate, type ModelRate, type TokenCounts } from "../../shared/agent-pricing";
import type { AgentUsageDay, AgentUsageSource } from "../../shared/types";

/** Content-free response snapshots; identities let history survive source-log cleanup. */
export interface UsageRecord {
	model: string;
	timestamp: number;
	counts: TokenCounts;
}

export interface UsageState {
	records: Map<string, UsageRecord>;
	codexCumulativeSeen: Set<string>;
	codexModel: string;
	codexNativeStarted: boolean;
	codexSession: string;
}

export function newUsageState(): UsageState {
	return {
		records: new Map(), codexCumulativeSeen: new Set(), codexModel: "gpt-5",
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
	const previous = state.records.get(key);
	if (previous && (previous.timestamp > next.timestamp ||
		(previous.timestamp === next.timestamp && previous.counts.outputTokens > next.counts.outputTokens))) return;
	state.records.set(key, next);
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
	state.codexNativeStarted = false;
	state.codexSession = "";
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
	if (!native && (e.type !== "event_msg" || payload.type !== "token_count" || state.codexNativeStarted)) return;
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
		// Keep the legacy prefix of upgraded rollouts; subsequent token_count events
		// echo native responses and must not add a second charge.
		state.codexNativeStarted = true;
		key = `codex-native:${typeof payload.response_id === "string" && payload.response_id
			? payload.response_id : JSON.stringify([state.codexSession, timestamp, usage])}`;
	} else {
		const total = record(info?.total_token_usage);
		const values = [total?.input_tokens, total?.output_tokens, total?.cached_input_tokens ?? 0, total?.cache_write_input_tokens ?? 0];
		const cumulative = values.every((v) => typeof v === "number" && Number.isFinite(v) && v >= 0) ? values.join(":") : null;
		if (cumulative && state.codexCumulativeSeen.has(cumulative)) return;
		if (cumulative) state.codexCumulativeSeen.add(cumulative);
		const identity = cumulative && state.codexSession ? [state.codexSession, cumulative]
			: [timestamp, state.codexModel, input, cachedInput, cacheWrite, output];
		key = `codex-legacy:${JSON.stringify(identity)}`;
	}
	mergeUsageRecord(state, key, {
		model: state.codexModel, timestamp,
		counts: {
			inputTokens: input - cachedInput - cacheWrite,
			outputTokens: output, cacheReadInputTokens: cachedInput, cacheCreationInputTokens: cacheWrite,
		},
	});
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
	for (const { model, timestamp, counts } of state.records.values()) {
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
		const { costUsd, priced } = computeTokenCostUsd(pricingId(model), counts, resolveRate);
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
