import { computeTokenCostUsd, resolveModelRate, totalTokens, type TokenCounts } from "../../shared/agent-pricing";

describe("resolveModelRate", () => {
	it("prices every Claude tier at its published rates", () => {
		// prices current Opus tier (4.5–4.8) at $5/$25 with derived cache rates
		const rate = resolveModelRate("claude-opus-4-8");
		expect(rate, "prices current Opus tier (4.5–4.8) at $5/$25 with derived cache rates").toEqual({ input: 5, output: 25, cacheWrite5m: 6.25, cacheWrite1h: 10, cacheRead: 0.25 });

		// prices Opus 5.5 at $4/$20 with $0.20 cache reads
		const rate2 = resolveModelRate("claude-opus-5-5[1m]");
		expect(rate2, "prices Opus 5.5 at $4/$20 with $0.20 cache reads").toEqual({ input: 4, output: 20, cacheWrite5m: 5, cacheWrite1h: 8, cacheRead: 0.2 });

		// prices Opus 5 at the current Opus tier via the generic opus fallback
		expect(resolveModelRate("claude-opus-5"), "prices Opus 5 at the current Opus tier via the generic opus fallback").toMatchObject({ input: 5, output: 25 });
		expect(resolveModelRate("claude-opus-5[1m]"), "prices Opus 5 at the current Opus tier via the generic opus fallback").toMatchObject({ input: 5, output: 25 });

		// prices Sonnet 5 at its own lower $2/$10, not at the older Sonnet tier
		expect(resolveModelRate("claude-sonnet-5"), "prices Sonnet 5 at its own lower $2/$10, not at the older Sonnet tier").toMatchObject({ input: 2, output: 10 });

		// prices Sonnet 5.5 at the same $2/$10 tier as Sonnet 5, cache reads at $0.20
		expect(resolveModelRate("claude-sonnet-5-5"), "prices Sonnet 5.5 at the same $2/$10 tier as Sonnet 5, cache reads at $0.20").toEqual({ input: 2, output: 10, cacheWrite5m: 2.5, cacheWrite1h: 4, cacheRead: 0.2 });

		// keeps Sonnet 3.x/4.x at $3/$15
		expect(resolveModelRate("claude-sonnet-4-6"), "keeps Sonnet 3.x/4.x at $3/$15").toMatchObject({ input: 3, output: 15 });

		// prices Haiku 4.5 at $1/$5
		expect(resolveModelRate("claude-haiku-4-5-20251001"), "prices Haiku 4.5 at $1/$5").toMatchObject({ input: 1, output: 5, cacheRead: 0.1 });

		// prices legacy Opus (4.0/4.1) higher at $15/$75
		expect(resolveModelRate("claude-opus-4-1")?.input, "prices legacy Opus (4.0/4.1) higher at $15/$75").toBe(15);

		// prices Fable 5.2 / Mythos 5.2 at their published $8/$40 with $0.20 cache reads
		expect(resolveModelRate("claude-fable-5-2[1m]"), "prices Fable 5.2 / Mythos 5.2 at their published $8/$40 with $0.20 cache reads").toEqual({ input: 8, output: 40, cacheWrite5m: 10, cacheWrite1h: 16, cacheRead: 0.2 });
		expect(resolveModelRate("claude-mythos-5-2"), "prices Fable 5.2 / Mythos 5.2 at their published $8/$40 with $0.20 cache reads").toMatchObject({ input: 8, output: 40, cacheRead: 0.2 });

		// prices Fable 5 at $10/$50
		expect(resolveModelRate("claude-fable-5"), "prices Fable 5 at $10/$50").toMatchObject({ input: 10, output: 50, cacheWrite5m: 12.5, cacheWrite1h: 20, cacheRead: 1 });
		expect(resolveModelRate("claude-fable-5-1[1m]"), "prices Fable 5 at $10/$50").toMatchObject({ input: 10, output: 50, cacheWrite5m: 12.5, cacheWrite1h: 20, cacheRead: 0.25 });
		expect(resolveModelRate("claude-mythos-5-1"), "prices Fable 5 at $10/$50").toMatchObject({ cacheRead: 0.25 });
		expect(resolveModelRate("claude-opus-5"), "prices Fable 5 at $10/$50").toMatchObject({ cacheRead: 0.5 });
	});

	it("prices the recommended open-source models by OpenRouter slug, flash cheaper than pro", () => {
		// prices the open-source models dev3 recommends, by their OpenRouter slug
		expect(resolveModelRate("deepseek/deepseek-v4-flash-0731"), "prices the open-source models dev3 recommends, by their OpenRouter slug").toMatchObject({ input: 0.14, output: 0.28 });
		expect(resolveModelRate("deepseek/deepseek-v4-pro-0813"), "prices the open-source models dev3 recommends, by their OpenRouter slug").toMatchObject({ input: 1.32, output: 3.96 });
		expect(resolveModelRate("z-ai/glm-5.2"), "prices the open-source models dev3 recommends, by their OpenRouter slug").toMatchObject({ input: 1.19, output: 3.74 });
		expect(resolveModelRate("qwen/qwen3.8-2.4t-a95b"), "prices the open-source models dev3 recommends, by their OpenRouter slug").toMatchObject({ input: 2, output: 6 });
		expect(resolveModelRate("moonshotai/kimi-k3"), "prices the open-source models dev3 recommends, by their OpenRouter slug").toMatchObject({ input: 3, output: 15 });

		// keeps flash cheaper than pro, so a mis-ordered rule cannot pass unnoticed
		const flash = resolveModelRate("deepseek/deepseek-v4-flash-0731");
		const pro = resolveModelRate("deepseek/deepseek-v4-pro-0813");
		expect(flash!.output, "keeps flash cheaper than pro, so a mis-ordered rule cannot pass unnoticed").toBeLessThan(pro!.output);
	});

	it("prices Codex and GPT-6 models, leaving previews and unknown models unresolved", () => {
		// prices Codex models with OpenAI cached-input rates
		expect(resolveModelRate("gpt-5.5"), "prices Codex models with OpenAI cached-input rates").toMatchObject({ input: 5, output: 30, cacheRead: 0.5 });
		expect(resolveModelRate("gpt-5.4-mini"), "prices Codex models with OpenAI cached-input rates").toMatchObject({ input: 0.75, output: 4.5, cacheRead: 0.075 });
		expect(resolveModelRate("gpt-5.3-codex"), "prices Codex models with OpenAI cached-input rates").toMatchObject({ input: 1.75, output: 14, cacheRead: 0.175 });
		expect(resolveModelRate("openai/gpt-5.2-codex"), "prices Codex models with OpenAI cached-input rates").toMatchObject({ input: 1.75, output: 14, cacheRead: 0.175 });
		expect(resolveModelRate("gpt-5.1-codex-max"), "prices Codex models with OpenAI cached-input rates").toMatchObject({ input: 1.25, output: 10, cacheRead: 0.125 });
		expect(resolveModelRate("gpt-5-codex"), "prices Codex models with OpenAI cached-input rates").toMatchObject({ input: 1.25, output: 10, cacheRead: 0.125 });

		// prices the GPT-6 lineup at its short-context API rates
		expect(resolveModelRate("gpt-6.2-astra"), "prices the GPT-6 lineup at its short-context API rates").toMatchObject({ input: 8, output: 40, cacheWrite5m: 10, cacheRead: 0.4 });
		expect(resolveModelRate("gpt-6.2-sol"), "prices the GPT-6 lineup at its short-context API rates").toMatchObject({ input: 2, output: 10, cacheWrite5m: 2.5, cacheRead: 0.1 });
		expect(resolveModelRate("openai/gpt-6.2-astra"), "prices the GPT-6 lineup at its short-context API rates").toMatchObject({ input: 8, output: 40 });
		expect(resolveModelRate("gpt-6.1-sol"), "prices the GPT-6 lineup at its short-context API rates").toMatchObject({ input: 2, output: 10, cacheWrite5m: 2.5, cacheRead: 0.1 });
		expect(resolveModelRate("gpt-6-astra"), "prices the GPT-6 lineup at its short-context API rates").toMatchObject({ input: 10, output: 50, cacheWrite5m: 12.5, cacheRead: 1 });
		expect(resolveModelRate("gpt-6-sol"), "prices the GPT-6 lineup at its short-context API rates").toMatchObject({ input: 2, output: 10, cacheWrite5m: 2.5, cacheRead: 0.2 });
		expect(resolveModelRate("gpt-6-luna"), "prices the GPT-6 lineup at its short-context API rates").toMatchObject({ input: 0.1, output: 0.5, cacheWrite5m: 0.125, cacheRead: 0.01 });

		// leaves unpriced Codex preview models unresolved
		expect(resolveModelRate("gpt-5.5-cyber"), "leaves unpriced Codex preview models unresolved").toBeNull();
		expect(resolveModelRate("gpt-5.3-codex-spark-preview"), "leaves unpriced Codex preview models unresolved").toBeNull();
		expect(resolveModelRate("gpt-5.6-sol"), "leaves unpriced Codex preview models unresolved").toBeNull();

		// returns null for an unknown model
		expect(resolveModelRate("some-other-llm"), "returns null for an unknown model").toBeNull();
		expect(resolveModelRate(""), "returns null for an unknown model").toBeNull();
	});

});

describe("computeTokenCostUsd", () => {
	it("computes cost at API or caller-supplied rates, and zero unpriced for an unknown model", () => {
		// uses refreshed model and cache rates supplied by the caller
		const { costUsd, priced } = computeTokenCostUsd("new-model", {
			inputTokens: 1_000_000, outputTokens: 1_000_000,
			cacheCreationInputTokens: 2_000_000, cacheReadInputTokens: 1_000_000,
			cacheCreation5mInputTokens: 1_000_000, cacheCreation1hInputTokens: 1_000_000,
		}, () => ({ input: 2, output: 5, cacheRead: 0.25, cacheWrite5m: 3, cacheWrite1h: 4 }));
		expect(priced, "uses refreshed model and cache rates supplied by the caller").toBe(true);
		expect(costUsd, "uses refreshed model and cache rates supplied by the caller").toBe(14.25);

		// computes cost from input/output tokens at API rates
		const tokens: TokenCounts = {
			inputTokens: 1_000_000,
			outputTokens: 1_000_000,
			cacheCreationInputTokens: 0,
			cacheReadInputTokens: 0,
		};
		const { costUsd: costUsd2, priced: priced2 } = computeTokenCostUsd("claude-opus-4-8", tokens);
		expect(priced2, "computes cost from input/output tokens at API rates").toBe(true);
		expect(costUsd2, "computes cost from input/output tokens at API rates").toBeCloseTo(30, 6); // $5 in + $25 out

		// returns priced=false and zero cost for an unknown model
		const { costUsd: costUsd3, priced: priced3 } = computeTokenCostUsd("mystery-model", {
			inputTokens: 1_000_000,
			outputTokens: 0,
			cacheCreationInputTokens: 0,
			cacheReadInputTokens: 0,
		});
		expect(priced3, "returns priced=false and zero cost for an unknown model").toBe(false);
		expect(costUsd3, "returns priced=false and zero cost for an unknown model").toBe(0);
	});

	it("prices the 5m/1h cache split separately, falling back to the 5m rate", () => {
		// prices the 5m/1h cache split separately when provided
		const tokens: TokenCounts = {
			inputTokens: 0,
			outputTokens: 0,
			cacheCreationInputTokens: 2_000_000,
			cacheReadInputTokens: 1_000_000,
			cacheCreation5mInputTokens: 1_000_000,
			cacheCreation1hInputTokens: 1_000_000,
		};
		const { costUsd } = computeTokenCostUsd("claude-opus-4-8", tokens);
		// 1M @ 6.25 (5m write) + 1M @ 10 (1h write) + 1M @ 0.25 (read) = 16.5
		expect(costUsd, "prices the 5m/1h cache split separately when provided").toBeCloseTo(16.5, 6);

		// falls back to the 5m rate for undifferentiated cache-creation tokens
		const tokens2: TokenCounts = {
			inputTokens: 0,
			outputTokens: 0,
			cacheCreationInputTokens: 1_000_000,
			cacheReadInputTokens: 0,
		};
		const { costUsd: costUsd2 } = computeTokenCostUsd("claude-opus-4-8", tokens2);
		expect(costUsd2, "falls back to the 5m rate for undifferentiated cache-creation tokens").toBeCloseTo(6.25, 6);
	});

});

describe("totalTokens", () => {
	it("sums every token category", () => {
		expect(
			totalTokens({ inputTokens: 1, outputTokens: 2, cacheCreationInputTokens: 4, cacheReadInputTokens: 8 }),
		).toBe(15);
	});
});
