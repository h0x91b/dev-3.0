import { computeTokenCostUsd, type TokenCounts } from "../../shared/agent-pricing";
import type { AgentUsageDay, AgentUsageSource } from "../../shared/types";

/**
 * Pure aggregation of Claude Code transcript usage — no fs, no logging, no
 * electrobun. Kept separate from the handler so it is trivially unit-testable.
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
}

export function newUsageState(): UsageState {
	return { byDateModel: new Map(), startMsByDate: new Map(), seen: new Set() };
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

	let models = state.byDateModel.get(day.date);
	if (!models) {
		models = new Map();
		state.byDateModel.set(day.date, models);
		state.startMsByDate.set(day.date, day.startMs);
	}
	let acc = models.get(model);
	if (!acc) {
		acc = emptyCounts();
		models.set(model, acc);
	}

	const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
	const cacheCreation = usage.cache_creation as Record<string, unknown> | undefined;
	acc.inputTokens += num(usage.input_tokens);
	acc.outputTokens += num(usage.output_tokens);
	acc.cacheCreationInputTokens += num(usage.cache_creation_input_tokens);
	acc.cacheReadInputTokens += num(usage.cache_read_input_tokens);
	acc.cacheCreation5mInputTokens! += num(cacheCreation?.ephemeral_5m_input_tokens);
	acc.cacheCreation1hInputTokens! += num(cacheCreation?.ephemeral_1h_input_tokens);
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
