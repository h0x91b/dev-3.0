import { describe, expect, it } from "vitest";
import {
	buildProviderEnv,
	defaultModelMap,
	getProviderDefinition,
	isThirdPartyProvider,
	mapModelForProvider,
	normalizeAlias,
	providerOmitsModelFlag,
	providerPinnedModel,
	providersForAgent,
	thirdPartyProvidersForAgent,
	wantsLongContext,
} from "../../shared/llm-provider";
import { LLM_PROVIDER } from "../../shared/types";

describe("normalizeAlias", () => {
	it("strips the [1m] marker", () => {
		expect(normalizeAlias("claude-opus-4-8[1m]")).toBe("claude-opus-4-8");
	});
	it("strips an @-dated snapshot suffix", () => {
		expect(normalizeAlias("claude-haiku-4-5@20251001")).toBe("claude-haiku-4-5");
	});
	it("leaves a bare id untouched", () => {
		expect(normalizeAlias("claude-sonnet-4-6")).toBe("claude-sonnet-4-6");
	});
});

describe("wantsLongContext", () => {
	it("detects the [1m] marker", () => {
		expect(wantsLongContext("claude-opus-4-8[1m]")).toBe(true);
		expect(wantsLongContext("claude-opus-4-8")).toBe(false);
	});
});

describe("getProviderDefinition", () => {
	it("returns the Bedrock definition for the bedrock id", () => {
		const def = getProviderDefinition(LLM_PROVIDER.BedrockClaude);
		expect(def?.id).toBe(LLM_PROVIDER.BedrockClaude);
		expect(def?.enableEnv).toBe("CLAUDE_CODE_USE_BEDROCK");
		expect(def?.usesGeo).toBe(true);
	});
	it("returns the Codex Bedrock definition for the bedrock-codex id", () => {
		const def = getProviderDefinition(LLM_PROVIDER.BedrockCodex);
		expect(def?.id).toBe(LLM_PROVIDER.BedrockCodex);
		expect(def?.agentCommand).toBe("codex");
		expect(def?.enableArgs).toEqual(["-c", 'model_provider="amazon-bedrock"']);
		expect(def?.modelEnv).toBeUndefined();
		expect(def?.usesGeo).toBe(false);
	});
	it("returns undefined for the Anthropic default and unknown ids", () => {
		expect(getProviderDefinition(LLM_PROVIDER.Anthropic)).toBeUndefined();
		expect(getProviderDefinition(undefined)).toBeUndefined();
	});
});

describe("mapModelForProvider", () => {
	it("maps a known [1m] alias to a global Bedrock profile, preserving [1m]", () => {
		expect(mapModelForProvider("claude-opus-4-8[1m]", LLM_PROVIDER.BedrockClaude)).toBe(
			"global.anthropic.claude-opus-4-8[1m]",
		);
	});
	it("applies the selected Bedrock geo prefix", () => {
		expect(mapModelForProvider("claude-opus-4-8[1m]", LLM_PROVIDER.BedrockClaude, "us")).toBe(
			"us.anthropic.claude-opus-4-8[1m]",
		);
		expect(mapModelForProvider("sonnet", LLM_PROVIDER.BedrockClaude, "eu")).toBe(
			"eu.anthropic.claude-sonnet-4-6",
		);
		expect(mapModelForProvider("claude-fable-5", LLM_PROVIDER.BedrockClaude, "apac")).toBe(
			"apac.anthropic.claude-fable-5",
		);
	});
	it("resolves the 'sonnet' shorthand to its family", () => {
		expect(mapModelForProvider("sonnet", LLM_PROVIDER.BedrockClaude)).toBe(
			"global.anthropic.claude-sonnet-4-6",
		);
	});
	it("derives an id for an unknown/new model (always pins the model)", () => {
		expect(mapModelForProvider("claude-fable-5", LLM_PROVIDER.BedrockClaude)).toBe(
			"global.anthropic.claude-fable-5",
		);
	});
	it("preserves the [1m] marker when deriving an unknown model", () => {
		expect(mapModelForProvider("claude-fable-5[1m]", LLM_PROVIDER.BedrockClaude)).toBe(
			"global.anthropic.claude-fable-5[1m]",
		);
	});
	it("returns undefined for the Anthropic default or when no model is given", () => {
		expect(mapModelForProvider("claude-opus-4-8[1m]", LLM_PROVIDER.Anthropic)).toBeUndefined();
		expect(mapModelForProvider(undefined, LLM_PROVIDER.BedrockClaude)).toBeUndefined();
		expect(mapModelForProvider("", LLM_PROVIDER.BedrockClaude)).toBeUndefined();
	});
});

describe("thirdPartyProvidersForAgent", () => {
	it("returns Bedrock for the claude command (incl. an absolute path)", () => {
		expect(thirdPartyProvidersForAgent("claude").map((d) => d.id)).toEqual([LLM_PROVIDER.BedrockClaude]);
		expect(thirdPartyProvidersForAgent("/opt/homebrew/bin/claude").map((d) => d.id)).toEqual([
			LLM_PROVIDER.BedrockClaude,
		]);
	});
	it("returns Bedrock (codex flavor) for the codex command", () => {
		expect(thirdPartyProvidersForAgent("codex").map((d) => d.id)).toEqual([
			LLM_PROVIDER.BedrockCodex,
		]);
	});
	it("returns nothing for agents with no registered backend", () => {
		expect(thirdPartyProvidersForAgent("gemini")).toEqual([]);
	});
});

describe("providersForAgent", () => {
	it("lists the native option first, then registered backends, for claude", () => {
		expect(providersForAgent("claude")).toEqual([
			{ id: LLM_PROVIDER.Anthropic, labelKey: "settings.providerAnthropic" },
			{ id: LLM_PROVIDER.BedrockClaude, labelKey: "settings.providerBedrock" },
		]);
	});
	it("lists OpenAI (native) first, then Bedrock, for codex", () => {
		expect(providersForAgent("codex")).toEqual([
			{ id: LLM_PROVIDER.Anthropic, labelKey: "settings.providerOpenAI" },
			{ id: LLM_PROVIDER.BedrockCodex, labelKey: "settings.providerBedrock" },
		]);
	});
	it("is empty for an agent with no backend (no toggle shown)", () => {
		expect(providersForAgent("gemini")).toEqual([]);
	});
});

describe("isThirdPartyProvider", () => {
	it("is true for bedrock and bedrock-codex, false otherwise", () => {
		expect(isThirdPartyProvider(LLM_PROVIDER.BedrockClaude)).toBe(true);
		expect(isThirdPartyProvider(LLM_PROVIDER.BedrockCodex)).toBe(true);
		expect(isThirdPartyProvider(LLM_PROVIDER.Anthropic)).toBe(false);
		expect(isThirdPartyProvider(undefined)).toBe(false);
	});
});

describe("providerOmitsModelFlag", () => {
	it("is true only for env-delivering backends (Claude on Bedrock)", () => {
		expect(providerOmitsModelFlag(LLM_PROVIDER.BedrockClaude)).toBe(true);
		// Codex delivers the model via a rewritten --model flag, not env.
		expect(providerOmitsModelFlag(LLM_PROVIDER.BedrockCodex)).toBe(false);
		expect(providerOmitsModelFlag(LLM_PROVIDER.Anthropic)).toBe(false);
		expect(providerOmitsModelFlag(undefined)).toBe(false);
	});
});

describe("providerPinnedModel (bedrock-codex)", () => {
	it("maps a codex alias to the flat openai.<family> Bedrock id (no geo prefix)", () => {
		expect(providerPinnedModel(LLM_PROVIDER.BedrockCodex, undefined, "gpt-5.6-sol")).toBe(
			"openai.gpt-5.6-sol",
		);
		expect(providerPinnedModel(LLM_PROVIDER.BedrockCodex, undefined, "gpt-5.5")).toBe(
			"openai.gpt-5.5",
		);
	});
	it("a per-model manual override wins over the map", () => {
		expect(
			providerPinnedModel(
				LLM_PROVIDER.BedrockCodex,
				{ "bedrock-codex": { modelOverrides: { "gpt-5.6-sol": "openai.custom-id" } } },
				"gpt-5.6-sol",
			),
		).toBe("openai.custom-id");
	});
	it("is undefined for the native default or when the config has no model", () => {
		expect(providerPinnedModel(LLM_PROVIDER.Anthropic, undefined, "gpt-5.6-sol")).toBeUndefined();
		expect(providerPinnedModel(LLM_PROVIDER.BedrockCodex, undefined, undefined)).toBeUndefined();
	});
});

describe("buildProviderEnv", () => {
	it("returns {} for bedrock-codex — Codex is routed via CLI args, not env", () => {
		expect(buildProviderEnv(LLM_PROVIDER.BedrockCodex, undefined, "gpt-5.6-sol")).toEqual({});
	});
	it("returns {} for anthropic (default) — nothing injected", () => {
		expect(buildProviderEnv(LLM_PROVIDER.Anthropic, undefined, "claude-opus-4-8[1m]")).toEqual({});
		expect(buildProviderEnv(undefined, undefined, "claude-opus-4-8[1m]")).toEqual({});
	});

	it("bedrock: enables the flag and maps the model from the launching config", () => {
		const env = buildProviderEnv(LLM_PROVIDER.BedrockClaude, undefined, "claude-opus-4-8[1m]");
		expect(env.CLAUDE_CODE_USE_BEDROCK).toBe("1");
		expect(env.ANTHROPIC_MODEL).toBe("global.anthropic.claude-opus-4-8[1m]");
	});

	it("bedrock: per-model override (keyed by alias) wins over the map", () => {
		const env = buildProviderEnv(
			LLM_PROVIDER.BedrockClaude,
			{ bedrock: { modelOverrides: { "claude-opus-4-8[1m]": "us.anthropic.claude-opus-4-8" } } },
			"claude-opus-4-8[1m]",
		);
		expect(env.ANTHROPIC_MODEL).toBe("us.anthropic.claude-opus-4-8");
	});

	it("bedrock: geo prefixes the mapped model id", () => {
		const env = buildProviderEnv(LLM_PROVIDER.BedrockClaude, { bedrock: { geo: "eu" } }, "claude-opus-4-8[1m]");
		expect(env.ANTHROPIC_MODEL).toBe("eu.anthropic.claude-opus-4-8[1m]");
	});

	it("bedrock: a manual override still wins over the geo", () => {
		const env = buildProviderEnv(
			LLM_PROVIDER.BedrockClaude,
			{ bedrock: { geo: "eu", modelOverrides: { "claude-opus-4-8[1m]": "arn:aws:bedrock:custom" } } },
			"claude-opus-4-8[1m]",
		);
		expect(env.ANTHROPIC_MODEL).toBe("arn:aws:bedrock:custom");
	});

	it("does not inject region/profile (customer's global Claude config owns those)", () => {
		const env = buildProviderEnv(LLM_PROVIDER.BedrockClaude, undefined, "claude-opus-4-8[1m]");
		expect(env.AWS_REGION).toBeUndefined();
		expect(env.AWS_PROFILE).toBeUndefined();
		// Only the flag + model are injected.
		expect(Object.keys(env).sort()).toEqual(["ANTHROPIC_MODEL", "CLAUDE_CODE_USE_BEDROCK"]);
	});

	it("bedrock: an override for a DIFFERENT alias doesn't apply; this model uses the map", () => {
		const env = buildProviderEnv(
			LLM_PROVIDER.BedrockClaude,
			{ bedrock: { modelOverrides: { sonnet: "us.anthropic.claude-sonnet-4-6" } } },
			"claude-opus-4-8[1m]",
		);
		expect(env.ANTHROPIC_MODEL).toBe("global.anthropic.claude-opus-4-8[1m]");
	});

	it("bedrock: a blank override falls back to the map", () => {
		const env = buildProviderEnv(
			LLM_PROVIDER.BedrockClaude,
			{ bedrock: { modelOverrides: { "claude-opus-4-8[1m]": "  " } } },
			"claude-opus-4-8[1m]",
		);
		expect(env.ANTHROPIC_MODEL).toBe("global.anthropic.claude-opus-4-8[1m]");
	});

	it("bedrock: always pins the model, deriving an id for an unknown model", () => {
		const env = buildProviderEnv(LLM_PROVIDER.BedrockClaude, undefined, "claude-fable-5");
		expect(env.CLAUDE_CODE_USE_BEDROCK).toBe("1");
		expect(env.ANTHROPIC_MODEL).toBe("global.anthropic.claude-fable-5");
	});
});

describe("defaultModelMap", () => {
	it("returns one row per distinct model with its mapped default id", () => {
		const rows = defaultModelMap(
			["claude-opus-4-8[1m]", "sonnet", "claude-opus-4-8[1m]"],
			LLM_PROVIDER.BedrockClaude,
		);
		expect(rows).toEqual([
			{ model: "claude-opus-4-8[1m]", defaultId: "global.anthropic.claude-opus-4-8[1m]" },
			{ model: "sonnet", defaultId: "global.anthropic.claude-sonnet-4-6" },
		]);
	});
	it("derives ids for unknown models too (always pinned)", () => {
		const rows = defaultModelMap(["claude-fable-5"], LLM_PROVIDER.BedrockClaude);
		expect(rows).toEqual([
			{ model: "claude-fable-5", defaultId: "global.anthropic.claude-fable-5" },
		]);
	});
});
