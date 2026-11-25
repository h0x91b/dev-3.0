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
import { type BedrockGeo, LLM_PROVIDER, type LlmProvider } from "../../shared/types";

describe("normalizeAlias", () => {
	it("strips the [1m] marker and an @-dated snapshot suffix, leaving a bare id untouched", () => {
		for (const [input, expected] of [
			["claude-opus-4-8[1m]", "claude-opus-4-8"],
			["claude-haiku-4-5@20251001", "claude-haiku-4-5"],
			["claude-sonnet-4-6", "claude-sonnet-4-6"],
		]) {
			expect(normalizeAlias(input), input).toBe(expected);
		}
	});
});

describe("wantsLongContext", () => {
	it("detects the [1m] marker", () => {
		expect(wantsLongContext("claude-opus-4-8[1m]")).toBe(true);
		expect(wantsLongContext("claude-opus-4-8")).toBe(false);
	});
});

describe("getProviderDefinition", () => {
	it("returns the Bedrock definitions for Claude and Codex, and undefined for the Anthropic default and unknown ids", () => {
		const claude = getProviderDefinition(LLM_PROVIDER.BedrockClaude);
		expect(claude?.id).toBe(LLM_PROVIDER.BedrockClaude);
		expect(claude?.enableEnv).toBe("CLAUDE_CODE_USE_BEDROCK");
		expect(claude?.usesGeo).toBe(true);

		const codex = getProviderDefinition(LLM_PROVIDER.BedrockCodex);
		expect(codex?.id).toBe(LLM_PROVIDER.BedrockCodex);
		expect(codex?.agentCommand).toBe("codex");
		// The Bedrock Runtime provider: the OpenAI-compatible `amazon-bedrock`
		// endpoint does not serve gpt-6-astra (verified 2026-09-09, 404).
		expect(codex?.enableArgs).toEqual(["-c", 'model_provider="amazon-bedrock-runtime"']);
		expect(codex?.modelEnv).toBeUndefined();
		expect(codex?.usesGeo).toBe(true);

		expect(getProviderDefinition(LLM_PROVIDER.Native)).toBeUndefined();
		expect(getProviderDefinition(undefined)).toBeUndefined();
	});
});

describe("mapModelForProvider", () => {
	it("maps aliases and shorthands to a Bedrock profile, global by default, geo-prefixed, preserving [1m]", () => {
		const cases: Array<[model: string, geo: BedrockGeo | undefined, expected: string]> = [
			["claude-opus-4-8[1m]", undefined, "global.anthropic.claude-opus-4-8[1m]"],
			["claude-opus-4-8[1m]", "us", "us.anthropic.claude-opus-4-8[1m]"],
			["sonnet", "eu", "eu.anthropic.claude-sonnet-4-6"],
			["claude-opus-4-8", "jp", "jp.anthropic.claude-opus-4-8"],
			["sonnet", undefined, "global.anthropic.claude-sonnet-4-6"],
			["claude-opus-5[1m]", undefined, "global.anthropic.claude-opus-5[1m]"],
			["claude-opus-5", undefined, "global.anthropic.claude-opus-5"],
			["opus", undefined, "global.anthropic.claude-opus-5"],
		];
		for (const [model, geo, expected] of cases) {
			expect(mapModelForProvider(model, LLM_PROVIDER.BedrockClaude, geo), `${model} @ ${geo ?? "default"}`).toBe(expected);
		}
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
	it("derives an id for an unknown/new model (always pins the model), preserving [1m]", () => {
		expect(mapModelForProvider("claude-fable-5", LLM_PROVIDER.BedrockClaude)).toBe("global.anthropic.claude-fable-5");
		expect(mapModelForProvider("claude-fable-5[1m]", LLM_PROVIDER.BedrockClaude)).toBe("global.anthropic.claude-fable-5[1m]");
	});
	it("returns undefined for the Anthropic default or when no model is given", () => {
		expect(mapModelForProvider("claude-opus-4-8[1m]", LLM_PROVIDER.Native)).toBeUndefined();
		expect(mapModelForProvider(undefined, LLM_PROVIDER.BedrockClaude)).toBeUndefined();
		expect(mapModelForProvider("", LLM_PROVIDER.BedrockClaude)).toBeUndefined();
	});
});

describe("thirdPartyProvidersForAgent / providersForAgent", () => {
	it("offers Bedrock to claude (incl. an absolute path) and codex, native first, and nothing to other agents", () => {
		const cases: Array<[agent: string, thirdParty: string[], all: Array<{ id: string; labelKey: string }>]> = [
			["claude", [LLM_PROVIDER.BedrockClaude], [
				{ id: LLM_PROVIDER.Native, labelKey: "settings.providerAnthropic" },
				{ id: LLM_PROVIDER.BedrockClaude, labelKey: "settings.providerBedrock" },
			]],
			["/opt/homebrew/bin/claude", [LLM_PROVIDER.BedrockClaude], [
				{ id: LLM_PROVIDER.Native, labelKey: "settings.providerAnthropic" },
				{ id: LLM_PROVIDER.BedrockClaude, labelKey: "settings.providerBedrock" },
			]],
			["codex", [LLM_PROVIDER.BedrockCodex], [
				{ id: LLM_PROVIDER.Native, labelKey: "settings.providerOpenAI" },
				{ id: LLM_PROVIDER.BedrockCodex, labelKey: "settings.providerBedrock" },
			]],
			// No backend means no toggle shown.
			["gemini", [], []],
		];
		for (const [agent, thirdParty, all] of cases) {
			expect(thirdPartyProvidersForAgent(agent).map((d) => d.id), agent).toEqual(thirdParty);
			expect(providersForAgent(agent), agent).toEqual(all);
		}
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
		expect(providerPinnedModel(LLM_PROVIDER.BedrockCodex, undefined, "gpt-6-astra")).toBe("global.openai.gpt-6-astra");
		expect(providerPinnedModel(LLM_PROVIDER.BedrockCodex, undefined, "gpt-5.6-sol")).toBe("global.openai.gpt-5.6-sol");
		expect(providerPinnedModel(LLM_PROVIDER.BedrockCodex, { "bedrock-codex": { geo: "us" } }, "gpt-5.6-sol")).toBe("us.openai.gpt-5.6-sol");
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
	it("injects nothing for bedrock-codex (routed via CLI args) or the Anthropic default", () => {
		expect(buildProviderEnv(LLM_PROVIDER.BedrockCodex, undefined, "gpt-5.6-sol")).toEqual({});
		expect(buildProviderEnv(LLM_PROVIDER.Native, undefined, "claude-opus-4-8[1m]")).toEqual({});
		expect(buildProviderEnv(undefined, undefined, "claude-opus-4-8[1m]")).toEqual({});
	});

	it("bedrock: enables the flag and maps the model, without injecting region/profile (customer's global Claude config owns those)", () => {
		const env = buildProviderEnv(LLM_PROVIDER.BedrockClaude, undefined, "claude-opus-4-8[1m]");
		expect(env.CLAUDE_CODE_USE_BEDROCK).toBe("1");
		expect(env.ANTHROPIC_MODEL).toBe("global.anthropic.claude-opus-4-8[1m]");
		expect(env.AWS_REGION).toBeUndefined();
		expect(env.AWS_PROFILE).toBeUndefined();
		// Only the flag, the main model and the alias-slot models are injected.
		expect(Object.keys(env).sort()).toEqual([
			"ANTHROPIC_DEFAULT_FABLE_MODEL",
			"ANTHROPIC_DEFAULT_HAIKU_MODEL",
			"ANTHROPIC_DEFAULT_OPUS_MODEL",
			"ANTHROPIC_DEFAULT_SONNET_MODEL",
			"ANTHROPIC_MODEL",
			"CLAUDE_CODE_USE_BEDROCK",
		]);
	});

	it("bedrock: the geo prefixes the mapped model and an alias-keyed override wins over both", () => {
		const cases: Array<[name: string, config: Parameters<typeof buildProviderEnv>[1], expected: string]> = [
			["geo prefix", { bedrock: { geo: "eu" } }, "eu.anthropic.claude-opus-4-8[1m]"],
			["override wins over the map", { bedrock: { modelOverrides: { "claude-opus-4-8[1m]": "us.anthropic.claude-opus-4-8" } } }, "us.anthropic.claude-opus-4-8"],
			["override wins over the geo", { bedrock: { geo: "eu", modelOverrides: { "claude-opus-4-8[1m]": "arn:aws:bedrock:custom" } } }, "arn:aws:bedrock:custom"],
			["override for a DIFFERENT alias does not apply", { bedrock: { modelOverrides: { sonnet: "us.anthropic.claude-sonnet-4-6" } } }, "global.anthropic.claude-opus-4-8[1m]"],
			["blank override falls back to the map", { bedrock: { modelOverrides: { "claude-opus-4-8[1m]": "  " } } }, "global.anthropic.claude-opus-4-8[1m]"],
		];
		for (const [name, config, expected] of cases) {
			expect(buildProviderEnv(LLM_PROVIDER.BedrockClaude, config, "claude-opus-4-8[1m]").ANTHROPIC_MODEL, name).toBe(expected);
		}
	});

	it("bedrock: pins every alias slot to the newest built-in model, so /model haiku never hits a built-in id", () => {
		const env = buildProviderEnv(LLM_PROVIDER.BedrockClaude, undefined, "claude-sonnet-5-5");
		expect(env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe("global.anthropic.claude-haiku-5-5");
		expect(env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe("global.anthropic.claude-opus-5-5[1m]");
		expect(env.ANTHROPIC_DEFAULT_FABLE_MODEL).toBe("global.anthropic.claude-fable-5-2[1m]");
		expect(env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe(env.ANTHROPIC_MODEL);
	});

	it("bedrock: the launching model owns its own slot, even when a newer one exists", () => {
		const env = buildProviderEnv(LLM_PROVIDER.BedrockClaude, undefined, "claude-opus-4-8[1m]");
		expect(env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe("global.anthropic.claude-opus-4-8[1m]");
		expect(env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe(env.ANTHROPIC_MODEL);
	});

	it("bedrock: slot models follow the geo and the per-model overrides", () => {
		const env = buildProviderEnv(
			LLM_PROVIDER.BedrockClaude,
			{ bedrock: { geo: "us", modelOverrides: { "claude-haiku-5-5": "arn:aws:bedrock:haiku" } } },
			"claude-opus-5-5[1m]",
		);
		expect(env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe("arn:aws:bedrock:haiku");
		expect(env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe("us.anthropic.claude-sonnet-5-5");
	});

	it("bedrock: a slot whose models the geo does not serve stands in with the launching model", () => {
		const env = buildProviderEnv(LLM_PROVIDER.BedrockClaude, { bedrock: { geo: "eu" } }, "claude-opus-5-5[1m]");
		expect(env.ANTHROPIC_DEFAULT_FABLE_MODEL).toBe("eu.anthropic.claude-opus-5-5[1m]");
		expect(env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe("eu.anthropic.claude-haiku-5-5");
	});
});

describe("bedrockModelServedInGeo", () => {
	// Snapshot of `aws bedrock list-inference-profiles` per region, 2026-09-09.
	it("knows Fable is global/us only, jp carries only the 4.x generation, OpenAI is global/us, and never flags a model it has no data for", () => {
		const cases: Array<[provider: LlmProvider, model: string, geo: BedrockGeo, served: boolean]> = [
			[LLM_PROVIDER.BedrockClaude, "claude-fable-5-1[1m]", "eu", false],
			[LLM_PROVIDER.BedrockClaude, "claude-fable-5-2[1m]", "eu", false],
			[LLM_PROVIDER.BedrockClaude, "claude-fable-5-2[1m]", "jp", false],
			[LLM_PROVIDER.BedrockClaude, "claude-fable-5-2[1m]", "global", true],
			[LLM_PROVIDER.BedrockClaude, "claude-fable-5", "us", true],
			[LLM_PROVIDER.BedrockClaude, "claude-opus-5[1m]", "eu", true],
			[LLM_PROVIDER.BedrockClaude, "claude-opus-5[1m]", "jp", false],
			[LLM_PROVIDER.BedrockClaude, "claude-opus-4-8[1m]", "jp", true],
			[LLM_PROVIDER.BedrockCodex, "gpt-6-astra", "global", true],
			[LLM_PROVIDER.BedrockCodex, "gpt-6-astra", "eu", false],
			[LLM_PROVIDER.BedrockClaude, "claude-future-9", "eu", true],
			[LLM_PROVIDER.Native, "claude-fable-5", "eu", true],
		];
		for (const [provider, model, geo, served] of cases) {
			expect(bedrockModelServedInGeo(provider, model, geo), `${provider} ${model} @ ${geo}`).toBe(served);
		}
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
});
