import { buildClaudeUsageDays, buildCodexUsageDays } from "../agent-usage-parse";

// Midday-UTC timestamps so local-day bucketing is stable across test-runner timezones.
function assistant(
	id: string,
	requestId: string,
	model: string,
	timestamp: string,
	usage: Record<string, unknown>,
) {
	return { type: "assistant", requestId, timestamp, message: { id, model, usage } };
}

describe("buildClaudeUsageDays", () => {
	it("buckets by local day, dedups by message+request id, and prices per model", () => {
		const entries = [
			assistant("m1", "r1", "claude-opus-4-8", "2026-06-30T12:00:00Z", { input_tokens: 1_000_000, output_tokens: 0 }),
			// exact duplicate of m1 (resumed transcript) — must not double-count
			assistant("m1", "r1", "claude-opus-4-8", "2026-06-30T12:00:00Z", { input_tokens: 1_000_000, output_tokens: 0 }),
			assistant("m2", "r2", "claude-opus-4-8", "2026-06-30T12:05:00Z", { output_tokens: 1_000_000, cache_read_input_tokens: 500_000 }),
			assistant("m3", "r3", "claude-sonnet-4-6", "2026-07-01T12:00:00Z", { input_tokens: 1_000_000 }),
			// unknown model on day 2 — counted in tokens, not in cost, flips fullyPriced
			assistant("m4", "r4", "mystery-model", "2026-07-01T12:00:00Z", { input_tokens: 1_000_000 }),
			// non-assistant + malformed lines are ignored
			{ type: "user", message: { content: "hi" } },
			{ type: "assistant" },
			null,
		];

		const { days, hasUnpriced } = buildClaudeUsageDays(entries);

		expect(days).toHaveLength(2);
		const [day1, day2] = days;

		// Day 1: dedup means input is 1M (not 2M); opus cost = $5 in + $25 out.
		expect(day1.inputTokens).toBe(1_000_000);
		expect(day1.outputTokens).toBe(1_000_000);
		expect(day1.cacheReadInputTokens).toBe(500_000);
		expect(day1.costUsd).toBeCloseTo(30 + 0.25, 6); // +0.5/M * 0.5M cache read
		expect(day1.fullyPriced).toBe(true);
		expect(day1.source).toBe("claude");

		// Day 2: sonnet ($3) + unpriced model (tokens counted, cost 0).
		expect(day2.inputTokens).toBe(2_000_000);
		expect(day2.costUsd).toBeCloseTo(3, 6);
		expect(day2.fullyPriced).toBe(false);

		expect(hasUnpriced).toBe(true);
		expect(day1.startMs).toBeLessThan(day2.startMs);
	});

	it("returns an empty report for no usable entries", () => {
		const { days, hasUnpriced } = buildClaudeUsageDays([{ type: "user" }, null, 42]);
		expect(days).toEqual([]);
		expect(hasUnpriced).toBe(false);
	});
});

function codexModel(model: string, timestamp: string) {
	return { type: "turn_context", timestamp, payload: { model } };
}

function codexUsage(timestamp: string, last: Record<string, unknown>, total: Record<string, unknown> = {}) {
	return {
		type: "event_msg",
		timestamp,
		payload: {
			type: "token_count",
			info: { last_token_usage: last, total_token_usage: total },
		},
	};
}

describe("buildCodexUsageDays", () => {
	it("sums per-turn deltas, tracks model changes, and dedups repeated rollout events", () => {
		const duplicate = codexUsage(
			"2026-07-01T12:05:00Z",
			{ input_tokens: 1_500_000, cached_input_tokens: 500_000, output_tokens: 1_000_000 },
			{ input_tokens: 99_000_000, cached_input_tokens: 80_000_000, output_tokens: 40_000_000 },
		);
		const { days, hasUnpriced } = buildCodexUsageDays([
			codexModel("gpt-5.1-codex", "2026-07-01T12:00:00Z"),
			duplicate,
			duplicate,
			codexModel("gpt-5.4-mini", "2026-07-01T12:10:00Z"),
			codexUsage("2026-07-01T12:15:00Z", { input_tokens: 1_000_000, output_tokens: 1_000_000 }),
		]);

		expect(days).toHaveLength(1);
		expect(days[0]).toMatchObject({
			date: "2026-07-01",
			source: "codex",
			inputTokens: 2_000_000,
			outputTokens: 2_000_000,
			cacheCreationInputTokens: 0,
			cacheReadInputTokens: 500_000,
			fullyPriced: true,
		});
		// gpt-5.1-codex: $1.25 input + $0.0625 cached + $10 output;
		// gpt-5.4-mini: $0.75 input + $4.50 output.
		expect(days[0].costUsd).toBeCloseTo(16.5625, 6);
		expect(hasUnpriced).toBe(false);
	});

	it("counts unknown-model tokens without pricing and ignores malformed events", () => {
		const { days, hasUnpriced } = buildCodexUsageDays([
			codexModel("gpt-5.6-sol", "2026-07-02T12:00:00Z"),
			codexUsage("2026-07-02T12:05:00Z", { input_tokens: 10, cached_input_tokens: 4, output_tokens: 3 }),
			codexUsage("not-a-timestamp", { input_tokens: 100 }),
			{ type: "event_msg", timestamp: "2026-07-02T12:10:00Z", payload: { type: "token_count" } },
			null,
		]);

		expect(days).toHaveLength(1);
		expect(days[0]).toMatchObject({ inputTokens: 6, outputTokens: 3, cacheReadInputTokens: 4, costUsd: 0, fullyPriced: false });
		expect(hasUnpriced).toBe(true);
	});
});
