import { computeTokenCostUsd, resolveModelRate, totalTokens, type TokenCounts } from "../../shared/agent-pricing";

describe("resolveModelRate", () => {
	it("prices current Opus tier (4.5–4.8) at $5/$25 with derived cache rates", () => {
		const rate = resolveModelRate("claude-opus-4-8");
		expect(rate).toEqual({ input: 5, output: 25, cacheWrite5m: 6.25, cacheWrite1h: 10, cacheRead: 0.5 });
	});

	it("prices Sonnet at $3/$15 regardless of minor version (incl. the sonnet-5 placeholder)", () => {
		expect(resolveModelRate("claude-sonnet-4-6")?.input).toBe(3);
		expect(resolveModelRate("claude-sonnet-5")?.output).toBe(15);
	});

	it("prices Haiku 4.5 at $1/$5", () => {
		expect(resolveModelRate("claude-haiku-4-5-20251001")).toMatchObject({ input: 1, output: 5, cacheRead: 0.1 });
	});

	it("prices legacy Opus (4.0/4.1) higher at $15/$75", () => {
		expect(resolveModelRate("claude-opus-4-1")?.input).toBe(15);
	});

	it("prices Fable 5 at $10/$50", () => {
		expect(resolveModelRate("claude-fable-5")).toMatchObject({ input: 10, output: 50 });
	});

	it("returns null for an unknown model", () => {
		expect(resolveModelRate("some-other-llm")).toBeNull();
		expect(resolveModelRate("")).toBeNull();
	});
});

describe("computeTokenCostUsd", () => {
	it("computes cost from input/output tokens at API rates", () => {
		const tokens: TokenCounts = {
			inputTokens: 1_000_000,
			outputTokens: 1_000_000,
			cacheCreationInputTokens: 0,
			cacheReadInputTokens: 0,
		};
		const { costUsd, priced } = computeTokenCostUsd("claude-opus-4-8", tokens);
		expect(priced).toBe(true);
		expect(costUsd).toBeCloseTo(30, 6); // $5 in + $25 out
	});

	it("prices the 5m/1h cache split separately when provided", () => {
		const tokens: TokenCounts = {
			inputTokens: 0,
			outputTokens: 0,
			cacheCreationInputTokens: 2_000_000,
			cacheReadInputTokens: 1_000_000,
			cacheCreation5mInputTokens: 1_000_000,
			cacheCreation1hInputTokens: 1_000_000,
		};
		const { costUsd } = computeTokenCostUsd("claude-opus-4-8", tokens);
		// 1M @ 6.25 (5m write) + 1M @ 10 (1h write) + 1M @ 0.5 (read) = 16.75
		expect(costUsd).toBeCloseTo(16.75, 6);
	});

	it("falls back to the 5m rate for undifferentiated cache-creation tokens", () => {
		const tokens: TokenCounts = {
			inputTokens: 0,
			outputTokens: 0,
			cacheCreationInputTokens: 1_000_000,
			cacheReadInputTokens: 0,
		};
		const { costUsd } = computeTokenCostUsd("claude-opus-4-8", tokens);
		expect(costUsd).toBeCloseTo(6.25, 6);
	});

	it("returns priced=false and zero cost for an unknown model", () => {
		const { costUsd, priced } = computeTokenCostUsd("mystery-model", {
			inputTokens: 1_000_000,
			outputTokens: 0,
			cacheCreationInputTokens: 0,
			cacheReadInputTokens: 0,
		});
		expect(priced).toBe(false);
		expect(costUsd).toBe(0);
	});
});

describe("totalTokens", () => {
	it("sums every token category", () => {
		expect(
			totalTokens({ inputTokens: 1, outputTokens: 2, cacheCreationInputTokens: 4, cacheReadInputTokens: 8 }),
		).toBe(15);
	});
});
