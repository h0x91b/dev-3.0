import { describe, expect, it } from "vitest";
import {
	buildProviderEnv,
	defaultModelMap,
	getProviderDefinition,
	isThirdPartyProvider,
	mapModelForProvider,
	normalizeAlias,
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
		const def = getProviderDefinition(LLM_PROVIDER.Bedrock);
		expect(def?.id).toBe(LLM_PROVIDER.Bedrock);
		expect(def?.enableEnv).toBe("CLAUDE_CODE_USE_BEDROCK");
		expect(def?.usesGeo).toBe(true);
	});
	it("returns undefined for the Anthropic default and unknown ids", () => {
		expect(getProviderDefinition(LLM_PROVIDER.Anthropic)).toBeUndefined();
		expect(getProviderDefinition(undefined)).toBeUndefined();
	});
});

describe("mapModelForProvider", () => {
	it("maps a known [1m] alias to a global Bedrock profile, preserving [1m]", () => {
		expect(mapModelForProvider("claude-opus-4-8[1m]", LLM_PROVIDER.Bedrock)).toBe(
			"global.anthropic.claude-opus-4-8[1m]",
		);
	});
	it("applies the selected Bedrock geo prefix", () => {
		expect(mapModelForProvider("claude-opus-4-8[1m]", LLM_PROVIDER.Bedrock, "us")).toBe(
			"us.anthropic.claude-opus-4-8[1m]",
		);
		expect(mapModelForProvider("sonnet", LLM_PROVIDER.Bedrock, "eu")).toBe(
			"eu.anthropic.claude-sonnet-4-6",
		);
		expect(mapModelForProvider("claude-fable-5", LLM_PROVIDER.Bedrock, "apac")).toBe(
			"apac.anthropic.claude-fable-5",
		);
	});
	it("resolves the 'sonnet' shorthand to its family", () => {
		expect(mapModelForProvider("sonnet", LLM_PROVIDER.Bedrock)).toBe(
			"global.anthropic.claude-sonnet-4-6",
		);
	});
	it("maps Opus 5 and resolves the 'opus' shorthand to it", () => {
		expect(mapModelForProvider("claude-opus-5[1m]", LLM_PROVIDER.Bedrock)).toBe(
			"global.anthropic.claude-opus-5[1m]",
		);
		expect(mapModelForProvider("claude-opus-5", LLM_PROVIDER.Bedrock)).toBe(
			"global.anthropic.claude-opus-5",
		);
		expect(mapModelForProvider("opus", LLM_PROVIDER.Bedrock)).toBe(
			"global.anthropic.claude-opus-5",
		);
	});
	it("derives an id for an unknown/new model (always pins the model)", () => {
		expect(mapModelForProvider("claude-fable-5", LLM_PROVIDER.Bedrock)).toBe(
			"global.anthropic.claude-fable-5",
		);
	});
	it("preserves the [1m] marker when deriving an unknown model", () => {
		expect(mapModelForProvider("claude-fable-5[1m]", LLM_PROVIDER.Bedrock)).toBe(
			"global.anthropic.claude-fable-5[1m]",
		);
	});
	it("returns undefined for the Anthropic default or when no model is given", () => {
		expect(mapModelForProvider("claude-opus-4-8[1m]", LLM_PROVIDER.Anthropic)).toBeUndefined();
		expect(mapModelForProvider(undefined, LLM_PROVIDER.Bedrock)).toBeUndefined();
		expect(mapModelForProvider("", LLM_PROVIDER.Bedrock)).toBeUndefined();
	});
});

describe("thirdPartyProvidersForAgent", () => {
	it("returns Bedrock for the claude command (incl. an absolute path)", () => {
		expect(thirdPartyProvidersForAgent("claude").map((d) => d.id)).toEqual([LLM_PROVIDER.Bedrock]);
		expect(thirdPartyProvidersForAgent("/opt/homebrew/bin/claude").map((d) => d.id)).toEqual([
			LLM_PROVIDER.Bedrock,
		]);
	});
	it("returns nothing for agents with no registered backend", () => {
		expect(thirdPartyProvidersForAgent("codex")).toEqual([]);
		expect(thirdPartyProvidersForAgent("gemini")).toEqual([]);
	});
});

describe("providersForAgent", () => {
	it("lists the native option first, then registered backends, for claude", () => {
		expect(providersForAgent("claude")).toEqual([
			{ id: LLM_PROVIDER.Anthropic, labelKey: "settings.providerAnthropic" },
			{ id: LLM_PROVIDER.Bedrock, labelKey: "settings.providerBedrock" },
		]);
	});
	it("is empty for an agent with no backend (no toggle shown)", () => {
		expect(providersForAgent("codex")).toEqual([]);
	});
});

describe("isThirdPartyProvider", () => {
	it("is true for bedrock, false otherwise", () => {
		expect(isThirdPartyProvider(LLM_PROVIDER.Bedrock)).toBe(true);
		expect(isThirdPartyProvider(LLM_PROVIDER.Anthropic)).toBe(false);
		expect(isThirdPartyProvider(undefined)).toBe(false);
	});
});

describe("buildProviderEnv", () => {
	it("returns {} for anthropic (default) — nothing injected", () => {
		expect(buildProviderEnv(LLM_PROVIDER.Anthropic, undefined, "claude-opus-4-8[1m]")).toEqual({});
		expect(buildProviderEnv(undefined, undefined, "claude-opus-4-8[1m]")).toEqual({});
	});

	it("bedrock: enables the flag and maps the model from the launching config", () => {
		const env = buildProviderEnv(LLM_PROVIDER.Bedrock, undefined, "claude-opus-4-8[1m]");
		expect(env.CLAUDE_CODE_USE_BEDROCK).toBe("1");
		expect(env.ANTHROPIC_MODEL).toBe("global.anthropic.claude-opus-4-8[1m]");
	});

	it("bedrock: per-model override (keyed by alias) wins over the map", () => {
		const env = buildProviderEnv(
			LLM_PROVIDER.Bedrock,
			{ bedrock: { modelOverrides: { "claude-opus-4-8[1m]": "us.anthropic.claude-opus-4-8" } } },
			"claude-opus-4-8[1m]",
		);
		expect(env.ANTHROPIC_MODEL).toBe("us.anthropic.claude-opus-4-8");
	});

	it("bedrock: geo prefixes the mapped model id", () => {
		const env = buildProviderEnv(LLM_PROVIDER.Bedrock, { bedrock: { geo: "eu" } }, "claude-opus-4-8[1m]");
		expect(env.ANTHROPIC_MODEL).toBe("eu.anthropic.claude-opus-4-8[1m]");
	});

	it("bedrock: a manual override still wins over the geo", () => {
		const env = buildProviderEnv(
			LLM_PROVIDER.Bedrock,
			{ bedrock: { geo: "eu", modelOverrides: { "claude-opus-4-8[1m]": "arn:aws:bedrock:custom" } } },
			"claude-opus-4-8[1m]",
		);
		expect(env.ANTHROPIC_MODEL).toBe("arn:aws:bedrock:custom");
	});

	it("does not inject region/profile (customer's global Claude config owns those)", () => {
		const env = buildProviderEnv(LLM_PROVIDER.Bedrock, undefined, "claude-opus-4-8[1m]");
		expect(env.AWS_REGION).toBeUndefined();
		expect(env.AWS_PROFILE).toBeUndefined();
		// Only the flag + model are injected.
		expect(Object.keys(env).sort()).toEqual(["ANTHROPIC_MODEL", "CLAUDE_CODE_USE_BEDROCK"]);
	});

	it("bedrock: an override for a DIFFERENT alias doesn't apply; this model uses the map", () => {
		const env = buildProviderEnv(
			LLM_PROVIDER.Bedrock,
			{ bedrock: { modelOverrides: { sonnet: "us.anthropic.claude-sonnet-4-6" } } },
			"claude-opus-4-8[1m]",
		);
		expect(env.ANTHROPIC_MODEL).toBe("global.anthropic.claude-opus-4-8[1m]");
	});

	it("bedrock: a blank override falls back to the map", () => {
		const env = buildProviderEnv(
			LLM_PROVIDER.Bedrock,
			{ bedrock: { modelOverrides: { "claude-opus-4-8[1m]": "  " } } },
			"claude-opus-4-8[1m]",
		);
		expect(env.ANTHROPIC_MODEL).toBe("global.anthropic.claude-opus-4-8[1m]");
	});

	it("bedrock: always pins the model, deriving an id for an unknown model", () => {
		const env = buildProviderEnv(LLM_PROVIDER.Bedrock, undefined, "claude-fable-5");
		expect(env.CLAUDE_CODE_USE_BEDROCK).toBe("1");
		expect(env.ANTHROPIC_MODEL).toBe("global.anthropic.claude-fable-5");
	});
});

describe("defaultModelMap", () => {
	it("returns one row per distinct model with its mapped default id", () => {
		const rows = defaultModelMap(
			["claude-opus-4-8[1m]", "sonnet", "claude-opus-4-8[1m]"],
			LLM_PROVIDER.Bedrock,
		);
		expect(rows).toEqual([
			{ model: "claude-opus-4-8[1m]", defaultId: "global.anthropic.claude-opus-4-8[1m]" },
			{ model: "sonnet", defaultId: "global.anthropic.claude-sonnet-4-6" },
		]);
	});
	it("derives ids for unknown models too (always pinned)", () => {
		const rows = defaultModelMap(["claude-fable-5"], LLM_PROVIDER.Bedrock);
		expect(rows).toEqual([
			{ model: "claude-fable-5", defaultId: "global.anthropic.claude-fable-5" },
		]);
	});
});
