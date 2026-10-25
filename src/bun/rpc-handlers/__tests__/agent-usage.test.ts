import { beginCodexRollout, buildClaudeUsageDays, buildCodexUsageDays, finalizeUsage, foldClaudeEntry, foldCodexEntry, newUsageState } from "../agent-usage-parse";

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
	it("ignores an invalid first snapshot and moves a completed response into its final local day", () => {
		const start = new Date(2026, 6, 1, 23, 59).toISOString();
		const end = new Date(2026, 6, 2, 0, 1).toISOString();
		const { days } = buildClaudeUsageDays([
			assistant("m", "r", "unknown", "invalid", { input_tokens: 99 }),
			assistant("m", "r", "unknown", start, { input_tokens: 1_000_000, output_tokens: 10 }),
			assistant("m", "r", "claude-sonnet-4-6", end, { input_tokens: 1_000_000, output_tokens: 1_000_000 }),
		]);
		expect(days).toHaveLength(1);
		expect(days[0]).toMatchObject({ date: "2026-07-02", inputTokens: 1_000_000, outputTokens: 1_000_000, costUsd: 18, fullyPriced: true });
	});

	it.each([false, true])("counts the final streamed response once across transcript copies (reversed: %s)", (reversed) => {
		const entries = [
			assistant("streamed", "request", "claude-sonnet-4-6", "2026-07-01T12:00:00Z", { input_tokens: 1_000_000, output_tokens: 10 }),
			assistant("streamed", "request", "claude-sonnet-4-6", "2026-07-01T12:00:01Z", { input_tokens: 1_000_000, output_tokens: 1_000_000 }),
		];
		const { days } = buildClaudeUsageDays(reversed ? entries.reverse() : entries);
		expect(days).toHaveLength(1);
		expect(days[0]).toMatchObject({ inputTokens: 1_000_000, outputTokens: 1_000_000, costUsd: 18 });
	});

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
		expect(day1.costUsd).toBeCloseTo(30 + 0.125, 6); // +0.25/M * 0.5M cache read (Opus 4.8 published rate)
		expect(day1.fullyPriced).toBe(true);
		expect(day1.source).toBe("claude");

		// Day 2: sonnet ($3) + unpriced model (tokens counted, cost 0).
		expect(day2.inputTokens).toBe(2_000_000);
		expect(day2.costUsd).toBeCloseTo(3, 6);
		expect(day2.fullyPriced).toBe(false);

		expect(hasUnpriced).toBe(true);
		expect(day1.startMs).toBeLessThan(day2.startMs);
	});

	it.each([
		["no split", undefined, 7.5],
		["empty split", {}, 7.5],
		["only a 5m bucket", { ephemeral_5m_input_tokens: 500_000 }, 7.5],
		["only a 1h bucket", { ephemeral_1h_input_tokens: 500_000 }, 8.625],
		["partial split", { ephemeral_5m_input_tokens: 500_000, ephemeral_1h_input_tokens: 500_000 }, 8.625],
		["complete split", { ephemeral_5m_input_tokens: 1_000_000, ephemeral_1h_input_tokens: 1_000_000 }, 9.75],
	] as const)("prices all cache writes with %s", (_label, cacheCreation, expectedCost) => {
		const { days } = buildClaudeUsageDays([
			assistant("m1", "r1", "claude-sonnet-4-6", "2026-06-30T12:00:00Z", {
				cache_creation_input_tokens: 2_000_000,
				cache_creation: cacheCreation,
			}),
		]);

		expect(days[0]).toMatchObject({ cacheCreationInputTokens: 2_000_000, costUsd: expectedCost });
	});

	it.each([false, true])("preserves mixed split and unsplit cache writes (reversed: %s)", (reversed) => {
		const entries = [
			assistant("m1", "r1", "claude-sonnet-4-6", "2026-06-30T12:00:00Z", {
				cache_creation_input_tokens: 1_000_000,
			}),
			assistant("m2", "r2", "claude-sonnet-4-6", "2026-06-30T12:05:00Z", {
				cache_creation_input_tokens: 2_000_000,
				cache_creation: { ephemeral_5m_input_tokens: 1_000_000, ephemeral_1h_input_tokens: 1_000_000 },
			}),
		];
		const { days } = buildClaudeUsageDays(reversed ? entries.reverse() : entries);

		expect(days[0]).toMatchObject({ cacheCreationInputTokens: 3_000_000, costUsd: 13.5 });
	});

	it("prices a routed session through the catalog, because the wire name is a label the rate table never saw", () => {
		const state = newUsageState();
		// What a routed transcript actually records: <provider>/<the name the user
		// invented>. Priced raw it is unpriced; translated it is the provider's own rate.
		foldClaudeEntry(
			state,
			assistant("m1", "r1", "openrouter/fast-gremlin", "2026-06-30T12:00:00Z", { input_tokens: 1_000_000 }),
		);

		const raw = finalizeUsage(state, "claude");
		expect(raw.days[0].fullyPriced).toBe(false);

		const priced = finalizeUsage(state, "claude", (model) =>
			model === "openrouter/fast-gremlin" ? "z-ai/glm-5.2" : model,
		);
		expect(priced.days[0].fullyPriced).toBe(true);
		expect(priced.days[0].costUsd).toBeCloseTo(1.19, 6);
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
	it.each(["legacy-first", "native-first", "alternating"])("reconciles matching legacy/native cumulative snapshots: %s", (order) => {
		const one = { input_tokens: 1_000_000, output_tokens: 0 };
		const two = { input_tokens: 500_000, output_tokens: 0 };
		const total = { input_tokens: 1_500_000, output_tokens: 0 };
		const legacy = [codexUsage("2026-07-01T12:01:00Z", one, one), codexUsage("2026-07-01T12:02:00Z", two, total)];
		const native = [
			{ type: "token_usage_record", timestamp: "2026-07-01T12:01:00Z", payload: { response_id: "one", usage: one, thread_token_usage: one } },
			{ type: "token_usage_record", timestamp: "2026-07-01T12:02:00Z", payload: { response_id: "two", usage: two, thread_token_usage: total } },
		];
		const state = newUsageState();
		beginCodexRollout(state);
		const entries = order === "legacy-first" ? [...legacy, ...native]
			: order === "native-first" ? [...native, ...legacy] : [legacy[0], native[0], legacy[1], native[1]];
		for (const entry of [
			{ type: "session_meta", payload: { id: "session" } },
			codexModel("gpt-6-sol", "2026-07-01T12:00:00Z"),
			...entries,
		]) foldCodexEntry(state, entry);
		expect(finalizeUsage(state, "codex").days[0]).toMatchObject({ inputTokens: 1_500_000, costUsd: 3 });
		expect(state.superseded.size).toBe(2);
	});

	it("resets native cumulative tracking for copied rollout files without recounting responses", () => {
		const state = newUsageState();
		const usage = { input_tokens: 1_000_000, output_tokens: 0 };
		const native = { type: "token_usage_record", timestamp: "2026-07-01T12:00:00Z", payload: { response_id: "one", usage } };
		for (const entries of [[native], [codexUsage(native.timestamp, usage, usage), native]]) {
			beginCodexRollout(state);
			foldCodexEntry(state, { type: "session_meta", payload: { id: "session" } });
			foldCodexEntry(state, codexModel("gpt-6-sol", native.timestamp));
			for (const entry of entries) foldCodexEntry(state, entry);
		}
		expect(finalizeUsage(state, "codex").days[0]).toMatchObject({ inputTokens: 1_000_000, costUsd: 2 });
		expect(state.superseded.size).toBe(1);
	});

	it("uses running native response totals when thread cumulative usage is absent", () => {
		const one = { input_tokens: 1_000_000, output_tokens: 0 };
		const { days } = buildCodexUsageDays([
			codexModel("gpt-6-sol", "2026-07-01T12:00:00Z"),
			codexUsage("2026-07-01T12:01:00Z", one, one),
			{ type: "token_usage_record", timestamp: "2026-07-01T12:01:00Z", payload: { response_id: "one", usage: one } },
		]);
		expect(days[0]).toMatchObject({ inputTokens: 1_000_000, costUsd: 2 });
	});

	it("retains unmatched historical legacy usage before a native upgrade", () => {
		const old = { input_tokens: 1_000_000, output_tokens: 0 };
		const { days } = buildCodexUsageDays([
			codexModel("gpt-6-sol", "2026-07-01T12:00:00Z"),
			codexUsage("2026-07-01T12:01:00Z", old, old),
			{ type: "token_usage_record", timestamp: "2026-07-01T12:02:00Z", payload: {
				response_id: "new", usage: old, thread_token_usage: { input_tokens: 2_000_000, output_tokens: 0 },
			} },
		]);
		expect(days[0]).toMatchObject({ inputTokens: 2_000_000, costUsd: 4 });
	});

	it("keeps the original day and model when copied legacy snapshots replay next month", () => {
		const state = newUsageState();
		const usage = { input_tokens: 1_000_000, output_tokens: 0 };
		for (const [timestamp, model] of [["2026-07-01T12:00:00Z", "gpt-6-sol"], ["2026-08-01T12:00:00Z", "gpt-6-astra"]]) {
			beginCodexRollout(state);
			foldCodexEntry(state, { type: "session_meta", payload: { id: "session" } });
			foldCodexEntry(state, codexModel(model, timestamp));
			foldCodexEntry(state, codexUsage(timestamp, usage, usage));
		}
		expect(finalizeUsage(state, "codex").days).toMatchObject([{ date: "2026-07-01", inputTokens: 1_000_000, costUsd: 2 }]);
	});

	it("marks covered identities superseded even when their old log is absent from the next scan", () => {
		const state = newUsageState();
		const usage = { input_tokens: 1_000_000, output_tokens: 0 };
		beginCodexRollout(state);
		foldCodexEntry(state, { type: "session_meta", payload: { id: "session" } });
		foldCodexEntry(state, codexUsage("2026-07-01T12:00:00Z", usage, usage));
		const oldKey = [...state.records.keys()][0];
		beginCodexRollout(state);
		foldCodexEntry(state, { type: "session_meta", payload: { id: "session" } });
		foldCodexEntry(state, { type: "token_usage_record", timestamp: "2026-07-01T12:00:00Z", payload: {
			response_id: "one", usage, thread_token_usage: usage,
		} });
		expect(state.superseded.has(oldKey)).toBe(true);
		expect(state.records.has(oldKey)).toBe(false);
		beginCodexRollout(state);
		foldCodexEntry(state, { type: "session_meta", payload: { id: "session" } });
		foldCodexEntry(state, codexUsage("2026-08-01T12:00:00Z", usage, usage));
		expect(state.records.has(oldKey)).toBe(false);
	});

	it("retains the legacy prefix and then counts native response snapshots without their legacy echo", () => {
		const native = (output: number, timestamp: string) => ({
			type: "token_usage_record", timestamp,
			payload: { response_id: "response-1", usage: { input_tokens: 1_000_000, cached_input_tokens: 500_000, cache_write_input_tokens: 100_000, output_tokens: output } },
		});
		const { days } = buildCodexUsageDays([
			codexModel("gpt-5.1-codex", "2026-07-01T12:00:00Z"),
			codexUsage("2026-07-01T12:01:00Z", { input_tokens: 1_000_000, output_tokens: 0 }),
			native(10, "2026-07-01T12:02:00Z"),
			native(100_000, "2026-07-01T12:03:00Z"),
			codexUsage("2026-07-01T12:04:00Z", { input_tokens: 1_000_000, cached_input_tokens: 500_000, output_tokens: 100_000 }),
		]);
		expect(days).toHaveLength(1);
		expect(days[0]).toMatchObject({ inputTokens: 1_400_000, cacheReadInputTokens: 500_000, cacheCreationInputTokens: 100_000, outputTokens: 100_000 });
		expect(days[0].costUsd).toBeCloseTo(2.96875, 6);
	});

	it("ignores repeated cumulative snapshots at new timestamps, even after a model change", () => {
		const last = { input_tokens: 1_000_000, cached_input_tokens: 500_000, output_tokens: 100_000 };
		const total = { ...last };
		const { days } = buildCodexUsageDays([
			codexModel("gpt-5.1-codex", "2026-07-01T12:00:00Z"),
			codexUsage("2026-07-01T12:01:00Z", last, total),
			codexUsage("2026-07-01T12:02:00Z", last, total),
			codexModel("gpt-5.4-mini", "2026-07-02T12:00:00Z"),
			codexUsage("2026-07-02T12:01:00Z", last, total),
			codexUsage("2026-07-02T12:02:00Z", last, { input_tokens: 2_000_000, cached_input_tokens: 1_000_000, output_tokens: 200_000 }),
		]);
		expect(days).toHaveLength(2);
		expect(days[0]).toMatchObject({ inputTokens: 500_000, cacheReadInputTokens: 500_000, outputTokens: 100_000 });
		expect(days[1]).toMatchObject({ inputTokens: 500_000, cacheReadInputTokens: 500_000, outputTokens: 100_000 });
		expect(days[0].costUsd).toBeCloseTo(1.6875);
		expect(days[1].costUsd).toBeCloseTo(0.8625);
	});

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
