import { describe, expect, it } from "vitest";
import {
	BEDROCK_GEOS,
	bedrockModelServedInGeo,
	normalizeBedrockGeo,
	buildProviderEnv,
	defaultModelMap,
	getProviderDefinition,
	mapModelForProvider,
	normalizeAlias,
	providerOmitsModelFlag,
	providerPinnedModel,
	providersForAgent,
	thirdPartyProvidersForAgent,
	wantsLongContext,
} from "../../shared/llm-provider";
import { type BedrockGeo, LLM_PROVIDER } from "../../shared/types";

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
		// The Bedrock Runtime provider: the OpenAI-compatible `amazon-bedrock`
		// endpoint does not serve gpt-6-astra (verified 2026-09-09, 404).
		expect(def?.enableArgs).toEqual(["-c", 'model_provider="amazon-bedrock-runtime"']);
		expect(def?.modelEnv).toBeUndefined();
		expect(def?.usesGeo).toBe(true);
	});
	it("returns undefined for the Anthropic default and unknown ids", () => {
		expect(getProviderDefinition(LLM_PROVIDER.Native)).toBeUndefined();
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
		expect(mapModelForProvider("claude-opus-4-8", LLM_PROVIDER.BedrockClaude, "jp")).toBe(
			"jp.anthropic.claude-opus-4-8",
		);
	});
	it("offers jp, not apac: no current-generation model has an apac. profile", () => {
		expect(BEDROCK_GEOS).toEqual(["global", "us", "eu", "jp"]);
	});
	it("uses Bedrock's dated ids for the families that carry one", () => {
		// Verified live 2026-09-09: the bare family id is rejected with 400 for these two.
		expect(mapModelForProvider("haiku", LLM_PROVIDER.BedrockClaude)).toBe(
			"global.anthropic.claude-haiku-4-5-20251001-v1:0",
		);
		expect(mapModelForProvider("claude-haiku-4-5", LLM_PROVIDER.BedrockClaude, "us")).toBe(
			"us.anthropic.claude-haiku-4-5-20251001-v1:0",
		);
		expect(mapModelForProvider("anthropic/claude-opus-4-6", LLM_PROVIDER.BedrockClaude)).toBe(
			"global.anthropic.claude-opus-4-6-v1",
		);
	});
	it("resolves the 'sonnet' shorthand to its family", () => {
		expect(mapModelForProvider("sonnet", LLM_PROVIDER.BedrockClaude)).toBe(
			"global.anthropic.claude-sonnet-4-6",
		);
	});
	it("maps Opus 5 and resolves the 'opus' shorthand to it", () => {
		expect(mapModelForProvider("claude-opus-5[1m]", LLM_PROVIDER.BedrockClaude)).toBe(
			"global.anthropic.claude-opus-5[1m]",
		);
		expect(mapModelForProvider("claude-opus-5", LLM_PROVIDER.BedrockClaude)).toBe(
			"global.anthropic.claude-opus-5",
		);
		expect(mapModelForProvider("opus", LLM_PROVIDER.BedrockClaude)).toBe(
			"global.anthropic.claude-opus-5",
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
		expect(mapModelForProvider("claude-opus-4-8[1m]", LLM_PROVIDER.Native)).toBeUndefined();
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
			{ id: LLM_PROVIDER.Native, labelKey: "settings.providerAnthropic" },
			{ id: LLM_PROVIDER.BedrockClaude, labelKey: "settings.providerBedrock" },
		]);
	});
	it("lists OpenAI (native) first, then Bedrock, for codex", () => {
		expect(providersForAgent("codex")).toEqual([
			{ id: LLM_PROVIDER.Native, labelKey: "settings.providerOpenAI" },
			{ id: LLM_PROVIDER.BedrockCodex, labelKey: "settings.providerBedrock" },
		]);
	});
	it("is empty for an agent with no backend (no toggle shown)", () => {
		expect(providersForAgent("gemini")).toEqual([]);
	});
});

describe("providerOmitsModelFlag", () => {
	it("is true only for env-delivering backends (Claude on Bedrock)", () => {
		expect(providerOmitsModelFlag(LLM_PROVIDER.BedrockClaude)).toBe(true);
		// Codex delivers the model via a rewritten --model flag, not env.
		expect(providerOmitsModelFlag(LLM_PROVIDER.BedrockCodex)).toBe(false);
		expect(providerOmitsModelFlag(LLM_PROVIDER.Native)).toBe(false);
		expect(providerOmitsModelFlag(undefined)).toBe(false);
	});
});

describe("providerPinnedModel (bedrock-codex)", () => {
	it("maps a codex alias to a <geo>.openai.<family> inference profile, global by default", () => {
		// Bedrock Runtime rejects the bare `openai.<family>` id ("on-demand
		// throughput isn't supported"); the profile form was verified live 2026-09-09.
		expect(providerPinnedModel(LLM_PROVIDER.BedrockCodex, undefined, "gpt-6-astra")).toBe(
			"global.openai.gpt-6-astra",
		);
		expect(providerPinnedModel(LLM_PROVIDER.BedrockCodex, undefined, "gpt-5.6-sol")).toBe(
			"global.openai.gpt-5.6-sol",
		);
	});
	it("applies the selected geo to the codex id", () => {
		expect(
			providerPinnedModel(LLM_PROVIDER.BedrockCodex, { "bedrock-codex": { geo: "us" } }, "gpt-5.6-sol"),
		).toBe("us.openai.gpt-5.6-sol");
	});
	it("treats a stored geo it no longer offers (apac) as the default", () => {
		const stale = { bedrock: { geo: "apac" as unknown as BedrockGeo } };
		expect(providerPinnedModel(LLM_PROVIDER.BedrockClaude, stale, "claude-opus-5")).toBe(
			"global.anthropic.claude-opus-5",
		);
		expect(normalizeBedrockGeo("apac" as unknown as BedrockGeo)).toBe("global");
		expect(normalizeBedrockGeo("eu")).toBe("eu");
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
		expect(providerPinnedModel(LLM_PROVIDER.Native, undefined, "gpt-5.6-sol")).toBeUndefined();
		expect(providerPinnedModel(LLM_PROVIDER.BedrockCodex, undefined, undefined)).toBeUndefined();
	});
});

describe("buildProviderEnv", () => {
	it("returns {} for bedrock-codex — Codex is routed via CLI args, not env", () => {
		expect(buildProviderEnv(LLM_PROVIDER.BedrockCodex, undefined, "gpt-5.6-sol")).toEqual({});
	});
	it("returns {} for anthropic (default) — nothing injected", () => {
		expect(buildProviderEnv(LLM_PROVIDER.Native, undefined, "claude-opus-4-8[1m]")).toEqual({});
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

describe("bedrockModelServedInGeo", () => {
	// Snapshot of `aws bedrock list-inference-profiles` per region, 2026-09-09.
	it("knows Fable is global/us only and jp carries only the 4.x generation", () => {
		expect(bedrockModelServedInGeo(LLM_PROVIDER.BedrockClaude, "claude-fable-5-1[1m]", "eu")).toBe(false);
		expect(bedrockModelServedInGeo(LLM_PROVIDER.BedrockClaude, "claude-fable-5", "us")).toBe(true);
		expect(bedrockModelServedInGeo(LLM_PROVIDER.BedrockClaude, "claude-opus-5[1m]", "eu")).toBe(true);
		expect(bedrockModelServedInGeo(LLM_PROVIDER.BedrockClaude, "claude-opus-5[1m]", "jp")).toBe(false);
		expect(bedrockModelServedInGeo(LLM_PROVIDER.BedrockClaude, "claude-opus-4-8[1m]", "jp")).toBe(true);
	});
	it("knows OpenAI models only have global and us profiles", () => {
		expect(bedrockModelServedInGeo(LLM_PROVIDER.BedrockCodex, "gpt-6-astra", "global")).toBe(true);
		expect(bedrockModelServedInGeo(LLM_PROVIDER.BedrockCodex, "gpt-6-astra", "eu")).toBe(false);
	});
	it("never flags a model it has no data for", () => {
		expect(bedrockModelServedInGeo(LLM_PROVIDER.BedrockClaude, "claude-future-9", "eu")).toBe(true);
		expect(bedrockModelServedInGeo(LLM_PROVIDER.Native, "claude-fable-5", "eu")).toBe(true);
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
