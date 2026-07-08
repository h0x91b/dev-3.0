import { computeTokenCostUsd, type TokenCounts } from "../../shared/agent-pricing";
import type { AgentUsageDay, AgentUsageSource } from "../../shared/types";

/**
 * Pure aggregation of Claude Code transcripts and Codex rollouts — no fs, no
 * logging, no electrobun. Kept separate from the handler so it is trivially
 * unit-testable.
 *
 * Each `type:"assistant"` transcript line carries `message.usage` (input/output/
 * cache tokens), `message.model`, `message.id`, `requestId`, and a `timestamp`.
 * We dedup by message+request id (resumed/summary transcripts repeat lines),
 * bucket into local calendar days, and price per model.
 */

export interface UsageState {
	/** date (YYYY-MM-DD) -> model id -> accumulated token counts */
	byDateModel: Map<string, Map<string, TokenCounts>>;
	/** date -> local-midnight epoch ms */
	startMsByDate: Map<string, number>;
	/** dedup: `${message.id}:${requestId}` already counted */
	seen: Set<string>;
	/** Model selected by the latest Codex turn_context in the current rollout. */
	codexModel: string;
}

export function newUsageState(): UsageState {
	return { byDateModel: new Map(), startMsByDate: new Map(), seen: new Set(), codexModel: "gpt-5" };
}

function pad2(n: number): string {
	return n < 10 ? `0${n}` : String(n);
}

/** Local calendar date + local-midnight epoch ms for an ISO timestamp. */
function localDayOf(iso: string): { date: string; startMs: number } | null {
	const t = Date.parse(iso);
	if (Number.isNaN(t)) return null;
	const d = new Date(t);
	const date = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
	const startMs = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
	return { date, startMs };
}

function emptyCounts(): TokenCounts {
	return {
		inputTokens: 0,
		outputTokens: 0,
		cacheCreationInputTokens: 0,
		cacheReadInputTokens: 0,
		cacheCreation5mInputTokens: 0,
		cacheCreation1hInputTokens: 0,
	};
}

function finiteNumber(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function countsFor(state: UsageState, date: string, startMs: number, model: string): TokenCounts {
	let models = state.byDateModel.get(date);
	if (!models) {
		models = new Map();
		state.byDateModel.set(date, models);
		state.startMsByDate.set(date, startMs);
	}
	let acc = models.get(model);
	if (!acc) {
		acc = emptyCounts();
		models.set(model, acc);
	}
	return acc;
}

/** Fold one parsed transcript line into the accumulator. Ignores non-assistant / malformed lines. */
export function foldClaudeEntry(state: UsageState, entry: unknown): void {
	if (!entry || typeof entry !== "object") return;
	const e = entry as Record<string, unknown>;
	if (e.type !== "assistant") return;
	const msg = e.message as Record<string, unknown> | undefined;
	const usage = msg?.usage as Record<string, unknown> | undefined;
	if (!msg || !usage || typeof e.timestamp !== "string") return;

	// Dedup: the same assistant message can appear across resumed/summary transcripts.
	const dedupKey = `${String(msg.id ?? "")}:${String(e.requestId ?? "")}`;
	if (dedupKey !== ":" && state.seen.has(dedupKey)) return;
	if (dedupKey !== ":") state.seen.add(dedupKey);

	const day = localDayOf(e.timestamp);
	if (!day) return;
	const model = typeof msg.model === "string" ? msg.model : "unknown";

	const acc = countsFor(state, day.date, day.startMs, model);
	const cacheCreation = usage.cache_creation as Record<string, unknown> | undefined;
	acc.inputTokens += finiteNumber(usage.input_tokens);
	acc.outputTokens += finiteNumber(usage.output_tokens);
	acc.cacheCreationInputTokens += finiteNumber(usage.cache_creation_input_tokens);
	acc.cacheReadInputTokens += finiteNumber(usage.cache_read_input_tokens);
	acc.cacheCreation5mInputTokens! += finiteNumber(cacheCreation?.ephemeral_5m_input_tokens);
	acc.cacheCreation1hInputTokens! += finiteNumber(cacheCreation?.ephemeral_1h_input_tokens);
}

/** Reset per-file Codex context while preserving accumulated usage and dedup state. */
export function beginCodexRollout(state: UsageState): void {
	// Very old rollouts predate turn_context; ccusage also falls back to gpt-5 for them.
	state.codexModel = "gpt-5";
}

/**
 * Fold one Codex rollout entry. `last_token_usage` is the per-turn delta;
 * `total_token_usage` is cumulative for the session and must never be summed.
 */
export function foldCodexEntry(state: UsageState, entry: unknown): void {
	if (!entry || typeof entry !== "object") return;
	const e = entry as Record<string, unknown>;
	const payload = e.payload as Record<string, unknown> | undefined;
	if (!payload) return;

	if (e.type === "turn_context") {
		if (typeof payload.model === "string" && payload.model.trim()) state.codexModel = payload.model;
		return;
	}

	if (e.type !== "event_msg" || payload.type !== "token_count" || typeof e.timestamp !== "string") return;
	const info = payload.info as Record<string, unknown> | undefined;
	const usage = info?.last_token_usage as Record<string, unknown> | undefined;
	if (!usage) return;
	const day = localDayOf(e.timestamp);
	if (!day) return;

	const input = Math.max(0, finiteNumber(usage.input_tokens));
	const cachedInput = Math.min(input, Math.max(0, finiteNumber(usage.cached_input_tokens)));
	const output = Math.max(0, finiteNumber(usage.output_tokens));
	if (input === 0 && cachedInput === 0 && output === 0) return;

	// Rollouts have no message id. Timestamp + delta + active model is stable across
	// copied/resumed rollout files while still distinguishing ordinary turns.
	const dedupKey = `codex:${e.timestamp}:${state.codexModel}:${input}:${cachedInput}:${output}`;
	if (state.seen.has(dedupKey)) return;
	state.seen.add(dedupKey);

	const acc = countsFor(state, day.date, day.startMs, state.codexModel);
	// Codex input_tokens includes cached input. Split it so dashboard totals and
	// pricing count every token exactly once.
	acc.inputTokens += Math.max(0, input - cachedInput);
	acc.outputTokens += output;
	acc.cacheReadInputTokens += cachedInput;
}

/** Collapse the per-(date,model) accumulator into per-day rows with priced cost. */
export function finalizeUsage(
	state: UsageState,
	source: AgentUsageSource,
): { days: AgentUsageDay[]; hasUnpriced: boolean } {
	const days: AgentUsageDay[] = [];
	let hasUnpriced = false;

	for (const [date, models] of state.byDateModel) {
		const row: AgentUsageDay = {
			date,
			startMs: state.startMsByDate.get(date) ?? Date.parse(`${date}T00:00:00`),
			source,
			inputTokens: 0,
			outputTokens: 0,
			cacheCreationInputTokens: 0,
			cacheReadInputTokens: 0,
			costUsd: 0,
			fullyPriced: true,
		};
		for (const [model, counts] of models) {
			row.inputTokens += counts.inputTokens;
			row.outputTokens += counts.outputTokens;
			row.cacheCreationInputTokens += counts.cacheCreationInputTokens;
			row.cacheReadInputTokens += counts.cacheReadInputTokens;
			const { costUsd, priced } = computeTokenCostUsd(model, counts);
			row.costUsd += costUsd;
			if (!priced) {
				row.fullyPriced = false;
				hasUnpriced = true;
			}
		}
		days.push(row);
	}

	days.sort((a, b) => a.startMs - b.startMs);
	return { days, hasUnpriced };
}

/** Pure convenience for tests: fold a flat list of transcript entries into day rows. */
export function buildClaudeUsageDays(entries: unknown[]): { days: AgentUsageDay[]; hasUnpriced: boolean } {
	const state = newUsageState();
	for (const entry of entries) foldClaudeEntry(state, entry);
	return finalizeUsage(state, "claude");
}

/** Pure convenience for tests: fold one rollout's entries into Codex day rows. */
export function buildCodexUsageDays(entries: unknown[]): { days: AgentUsageDay[]; hasUnpriced: boolean } {
	const state = newUsageState();
	beginCodexRollout(state);
	for (const entry of entries) foldCodexEntry(state, entry);
	return finalizeUsage(state, "codex");
}
