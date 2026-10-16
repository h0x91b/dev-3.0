import { describe, expect, it } from "vitest";
import {
	findAgentConfig,
	liveModelConfigId,
	parseLiveModelConfigId,
	sortLiveModelsNewestFirst,
	withLiveModelConfigs,
	withSelectedLiveConfig,
	type LiveModel,
} from "../../shared/agent-live-models";
import type { CodingAgent } from "../../shared/types";

const agent: CodingAgent = {
	id: "builtin-omp",
	name: "Oh My Pi",
	baseCommand: "omp",
	configurations: [
		{ id: "omp-default", name: "Default" },
		{ id: "omp-yolo-high", name: "Bypass (High)", modeLabel: "Bypass · High", permissionMode: "bypassPermissions" },
		{ id: "pinned", name: "Pinned", model: "x/y" },
	],
	defaultConfigId: "omp-default",
};

const model = (provider: string, id: string, name = id): LiveModel => ({ selector: `${provider}/${id}`, provider, id, name });

describe("live model config ids", () => {
	it("round-trips a preset id and a selector with slashes and colons", () => {
		const id = liveModelConfigId("omp-default", "amazon-bedrock/anthropic.claude-x-v1:0");
		expect(parseLiveModelConfigId(id)).toEqual({ presetId: "omp-default", selector: "amazon-bedrock/anthropic.claude-x-v1:0" });
		expect(parseLiveModelConfigId("omp-default")).toBeNull();
	});

	it("resolves a live id to its preset with the model swapped in", () => {
		const config = findAgentConfig(agent, liveModelConfigId("omp-yolo-high", "openai-codex/gpt-6.1-sol"));
		expect(config).toMatchObject({ model: "openai-codex/gpt-6.1-sol", permissionMode: "bypassPermissions", modeLabel: "Bypass · High" });
	});

	it("refuses a live id over a preset that already pins a model, or an unknown preset", () => {
		expect(findAgentConfig(agent, liveModelConfigId("pinned", "a/b"))).toBeUndefined();
		expect(findAgentConfig(agent, liveModelConfigId("nope", "a/b"))).toBeUndefined();
	});
});

describe("withLiveModelConfigs", () => {
	it("offers every model-free preset under each model, in the given order", () => {
		const expanded = withLiveModelConfigs(agent, [model("openai-codex", "gpt-6.1-sol", "GPT-6.1 Sol")]);
		const live = expanded.configurations.slice(agent.configurations.length);
		expect(live.map((c) => c.id)).toEqual([
			"omp-default|model=openai-codex/gpt-6.1-sol",
			"omp-yolo-high|model=openai-codex/gpt-6.1-sol",
		]);
		expect(new Set(live.map((c) => c.groupLabel))).toEqual(new Set(["GPT-6.1 Sol"]));
	});

	it("names the provider when two providers serve a model under one name", () => {
		const expanded = withLiveModelConfigs(agent, [model("openai-codex", "gpt-6-sol", "GPT-6 Sol"), model("github-copilot", "gpt-6-sol", "GPT-6 Sol")]);
		const labels = new Set(expanded.configurations.map((c) => c.groupLabel).filter(Boolean));
		expect(labels).toEqual(new Set(["GPT-6 Sol · openai-codex", "GPT-6 Sol · github-copilot"]));
	});

	it("keeps a selected live model visible before the list arrives", () => {
		const id = liveModelConfigId("omp-default", "openai-codex/gpt-6-luna");
		expect(withSelectedLiveConfig(agent, id).configurations.some((c) => c.id === id)).toBe(true);
		expect(withSelectedLiveConfig(agent, "omp-default")).toBe(agent);
	});
});

describe("sortLiveModelsNewestFirst", () => {
	it("orders by version inside a family, so a model dev3 never dated still leads", () => {
		const sorted = sortLiveModelsNewestFirst([
			model("openai-codex", "gpt-5.6-luna"),
			model("openai-codex", "gpt-6.1-sol"),
			model("openai-codex", "gpt-7-sol"),
			model("openai-codex", "gpt-6-astra"),
		]);
		expect(sorted.map((m) => m.id)).toEqual(["gpt-7-sol", "gpt-6.1-sol", "gpt-6-astra", "gpt-5.6-luna"]);
	});

	it("puts the family with the newest known release first", () => {
		const sorted = sortLiveModelsNewestFirst([model("cursor", "claude-opus-4-7[1m]"), model("cursor", "claude-haiku-5-5")]);
		expect(sorted[0].id).toBe("claude-haiku-5-5");
	});
});
