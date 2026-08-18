import { computeTokenCostUsd, resolveModelRate, totalTokens, type TokenCounts } from "../../shared/agent-pricing";

describe("resolveModelRate", () => {
	it("prices current Opus tier (4.5–4.8) at $5/$25 with derived cache rates", () => {
		const rate = resolveModelRate("claude-opus-4-8");
		expect(rate).toEqual({ input: 5, output: 25, cacheWrite5m: 6.25, cacheWrite1h: 10, cacheRead: 0.5 });
	});

	it("prices Opus 5 at the current Opus tier via the generic opus fallback", () => {
		expect(resolveModelRate("claude-opus-5")).toMatchObject({ input: 5, output: 25 });
		expect(resolveModelRate("claude-opus-5[1m]")).toMatchObject({ input: 5, output: 25 });
	});

	it("prices Sonnet 5 at its own lower $2/$10, not at the older Sonnet tier", () => {
		expect(resolveModelRate("claude-sonnet-5")).toMatchObject({ input: 2, output: 10 });
	});

	it("keeps Sonnet 3.x/4.x at $3/$15", () => {
		expect(resolveModelRate("claude-sonnet-4-6")).toMatchObject({ input: 3, output: 15 });
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

	it("prices the open-source models dev3 recommends, by their OpenRouter slug", () => {
		expect(resolveModelRate("deepseek/deepseek-v4-flash-0731")).toMatchObject({ input: 0.14, output: 0.28 });
		expect(resolveModelRate("deepseek/deepseek-v4-pro-0813")).toMatchObject({ input: 1.32, output: 3.96 });
		expect(resolveModelRate("z-ai/glm-5.2")).toMatchObject({ input: 1.19, output: 3.74 });
		expect(resolveModelRate("qwen/qwen3.8-2.4t-a95b")).toMatchObject({ input: 2, output: 6 });
		expect(resolveModelRate("moonshotai/kimi-k3")).toMatchObject({ input: 3, output: 15 });
	});

	it("keeps flash cheaper than pro, so a mis-ordered rule cannot pass unnoticed", () => {
		const flash = resolveModelRate("deepseek/deepseek-v4-flash-0731");
		const pro = resolveModelRate("deepseek/deepseek-v4-pro-0813");
		expect(flash!.output).toBeLessThan(pro!.output);
	});

	it("prices Codex models with OpenAI cached-input rates", () => {
		expect(resolveModelRate("gpt-5.5")).toMatchObject({ input: 5, output: 30, cacheRead: 0.5 });
		expect(resolveModelRate("gpt-5.4-mini")).toMatchObject({ input: 0.75, output: 4.5, cacheRead: 0.075 });
		expect(resolveModelRate("gpt-5.3-codex")).toMatchObject({ input: 1.75, output: 14, cacheRead: 0.175 });
		expect(resolveModelRate("openai/gpt-5.2-codex")).toMatchObject({ input: 1.75, output: 14, cacheRead: 0.175 });
		expect(resolveModelRate("gpt-5.1-codex-max")).toMatchObject({ input: 1.25, output: 10, cacheRead: 0.125 });
		expect(resolveModelRate("gpt-5-codex")).toMatchObject({ input: 1.25, output: 10, cacheRead: 0.125 });
	});

	it("leaves unpriced Codex preview models unresolved", () => {
		expect(resolveModelRate("gpt-5.5-cyber")).toBeNull();
		expect(resolveModelRate("gpt-5.3-codex-spark-preview")).toBeNull();
		expect(resolveModelRate("gpt-5.6-sol")).toBeNull();
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
