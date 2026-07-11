import { describe, it, expect } from "vitest";
import type { AgentConfiguration, CodingAgent, FavoriteAgentConfig } from "../../../shared/types";
import {
	buildPickerGroups,
	getModelGroupLabel,
	getModeLeafLabel,
	groupLabelForConfig,
	pickConfigForModelChange,
	prettifyModel,
	resolveFavoriteChips,
	MODEL_GROUP_LABELS,
	type PickerGroup,
} from "../agentPicker";

const claude: CodingAgent = {
	id: "builtin-claude",
	name: "Claude",
	baseCommand: "claude",
	configurations: [
		{ id: "auto-fable", name: "Auto (Fable 5)", model: "claude-fable-5", permissionMode: "auto" },
		{ id: "auto-opus-xhigh", name: "Auto (Opus 4.8, X-High)", model: "claude-opus-4-8[1m]", permissionMode: "auto", effort: "xhigh" },
		{ id: "bypass-opus-xhigh", name: "Bypass (Opus 4.8, X-High)", model: "claude-opus-4-8[1m]", permissionMode: "bypassPermissions", effort: "xhigh" },
		{ id: "bypass-opus-medium", name: "Bypass (Opus 4.8, Medium)", model: "claude-opus-4-8[1m]", permissionMode: "bypassPermissions", effort: "medium" },
		{ id: "default-fable", name: "Default (Fable 5)", model: "claude-fable-5" },
		{ id: "plan-fable", name: "Plan (Fable 5)", model: "claude-fable-5", permissionMode: "plan" },
	],
	defaultConfigId: "bypass-opus-xhigh",
};

describe("getModelGroupLabel", () => {
	it("maps known model strings to clean labels", () => {
		expect(getModelGroupLabel({ id: "a", name: "x", model: "claude-opus-4-8[1m]" })).toBe("Opus 4.8");
		expect(getModelGroupLabel({ id: "a", name: "x", model: "claude-fable-5" })).toBe("Fable 5");
		expect(getModelGroupLabel({ id: "a", name: "x", model: "gpt-5.6-sol" })).toBe("GPT-5.6 Sol");
		expect(getModelGroupLabel({ id: "a", name: "x", model: "gpt-5.6-terra" })).toBe("GPT-5.6 Terra");
		expect(getModelGroupLabel({ id: "a", name: "x", model: "gpt-5.6-luna" })).toBe("GPT-5.6 Luna");
		expect(getModelGroupLabel({ id: "a", name: "x", model: "gpt-5.3-codex" })).toBe("GPT-5.3 Codex");
	});

	it("prefers an explicit groupLabel over the model", () => {
		expect(getModelGroupLabel({ id: "a", name: "x", model: "openai/gpt-5.5", groupLabel: "Sisyphus" })).toBe("Sisyphus");
	});

	it("prettifies unknown models and falls back to Default when no model", () => {
		expect(getModelGroupLabel({ id: "a", name: "x", model: "some-new-model-preview" })).toBe("Some New Model");
		expect(getModelGroupLabel({ id: "a", name: "x" })).toBe("Default");
	});
});

describe("prettifyModel", () => {
	it("strips duration, vendor prefix, preview/thinking and title-cases", () => {
		expect(prettifyModel("claude-opus-4-8[1m]")).toBe("Claude Opus 4 8");
		expect(prettifyModel("anthropic/claude-sonnet-4-6")).toBe("Claude Sonnet 4 6");
		expect(prettifyModel("opus-4.6-thinking")).toBe("Opus 4.6");
	});

	it("preserves canonical GPT casing and version punctuation for unknown GPT models", () => {
		expect(prettifyModel("gpt-5.7-nova-preview")).toBe("GPT-5.7 Nova");
		expect(prettifyModel("openai/gpt-6-codex")).toBe("GPT-6 Codex");
	});
});

describe("getModeLeafLabel", () => {
	it("builds from permissionMode + effort when present", () => {
		expect(getModeLeafLabel({ id: "a", name: "Bypass (Opus 4.8, X-High)", model: "claude-opus-4-8[1m]", permissionMode: "bypassPermissions", effort: "xhigh" })).toBe("Bypass · X-High");
		expect(getModeLeafLabel({ id: "a", name: "Auto (Fable 5)", model: "claude-fable-5", permissionMode: "auto" })).toBe("Auto");
		expect(getModeLeafLabel({ id: "a", name: "Plan (Fable 5)", model: "claude-fable-5", permissionMode: "plan" })).toBe("Plan");
		expect(getModeLeafLabel({ id: "a", name: "x", model: "y", permissionMode: "acceptEdits" })).toBe("Accept Edits");
	});

	it("prefers an explicit modeLabel", () => {
		expect(getModeLeafLabel({ id: "a", name: "whatever", model: "gpt-5.5", modeLabel: "Heavy · Bypass" })).toBe("Heavy · Bypass");
	});

	it("derives from the name (minus model) for arg-encoded presets with no structured fields", () => {
		// Codex-style: no permissionMode/effort, model is a prefix or parenthetical
		expect(getModeLeafLabel({ id: "a", name: "GPT-5.5 Heavy Bypass", model: "gpt-5.5" })).toBe("Heavy Bypass");
		expect(getModeLeafLabel({ id: "a", name: "Default (GPT-5.5 Heavy Bypass)", model: "gpt-5.5" })).toBe("Default (Heavy Bypass)");
		expect(getModeLeafLabel({ id: "a", name: "Plan (GPT-5.5)", model: "gpt-5.5" })).toBe("Plan");
		// Multi-word group label ("GPT-5.6 Sol") strips cleanly too
		expect(getModeLeafLabel({ id: "a", name: "GPT-5.6 Sol Medium Bypass", model: "gpt-5.6-sol" })).toBe("Medium Bypass");
		expect(getModeLeafLabel({ id: "a", name: "Default (GPT-5.6 Sol Heavy Bypass)", model: "gpt-5.6-sol" })).toBe("Default (Heavy Bypass)");
		// Claude "Default" (no fields) collapses to just the mode word
		expect(getModeLeafLabel({ id: "a", name: "Default (Fable 5)", model: "claude-fable-5" })).toBe("Default");
		// OpenCode persona-style
		expect(getModeLeafLabel({ id: "a", name: "Orchestrator / Sisyphus (Opus 4.6)", model: "anthropic/claude-opus-4-6" })).toBe("Orchestrator / Sisyphus");
	});

	it("falls back to the raw name when stripping empties it", () => {
		expect(getModeLeafLabel({ id: "a", name: "Fable 5", model: "claude-fable-5" })).toBe("Fable 5");
	});
});

describe("buildPickerGroups", () => {
	it("groups by model preserving first-seen order", () => {
		const groups = buildPickerGroups(claude);
		expect(groups.map((g) => g.label)).toEqual(["Fable 5", "Opus 4.8"]);
		expect(groups[0].configs.map((c) => c.id)).toEqual(["auto-fable", "default-fable", "plan-fable"]);
		expect(groups[1].configs.map((c) => c.id)).toEqual(["auto-opus-xhigh", "bypass-opus-xhigh", "bypass-opus-medium"]);
	});

	it("returns [] for a missing agent", () => {
		expect(buildPickerGroups(null)).toEqual([]);
		expect(buildPickerGroups(undefined)).toEqual([]);
	});

	it("puts model-less custom configs under a single Default group", () => {
		const custom: CodingAgent = {
			id: "custom",
			name: "Custom",
			baseCommand: "bash",
			configurations: [
				{ id: "a", name: "Alpha" },
				{ id: "b", name: "Beta" },
			],
		};
		const groups = buildPickerGroups(custom);
		expect(groups).toHaveLength(1);
		expect(groups[0].label).toBe("Default");
		expect(groups[0].configs.map((c) => c.id)).toEqual(["a", "b"]);
	});
});

describe("groupLabelForConfig", () => {
	it("returns the owning group label", () => {
		expect(groupLabelForConfig(claude, "bypass-opus-xhigh")).toBe("Opus 4.8");
		expect(groupLabelForConfig(claude, "plan-fable")).toBe("Fable 5");
	});

	it("returns null for unknown / missing input", () => {
		expect(groupLabelForConfig(claude, "nope")).toBeNull();
		expect(groupLabelForConfig(claude, null)).toBeNull();
		expect(groupLabelForConfig(null, "x")).toBeNull();
	});
});

describe("pickConfigForModelChange", () => {
	const groups = buildPickerGroups(claude);
	const opus = groups.find((g) => g.label === "Opus 4.8") as { label: string; configs: AgentConfiguration[] };
	const fable = groups.find((g) => g.label === "Fable 5") as { label: string; configs: AgentConfiguration[] };

	it("preserves exact permissionMode+effort signature", () => {
		const prev: AgentConfiguration = { id: "x", name: "Bypass (Sonnet 5, X-High)", model: "claude-sonnet-5", permissionMode: "bypassPermissions", effort: "xhigh" };
		expect(pickConfigForModelChange(opus, prev)?.id).toBe("bypass-opus-xhigh");
	});

	it("falls back to same permissionMode when effort differs (target group has no effort)", () => {
		// Previous is Bypass·X-High on Opus; switching to Fable (no effort tiers)
		// should keep Bypass — but Fable has no Bypass here, so it keeps the mode
		// where available. Use auto to show mode-preservation across effort loss.
		const prev = opus.configs.find((c) => c.id === "auto-opus-xhigh") as AgentConfiguration;
		expect(pickConfigForModelChange(fable, prev)?.id).toBe("auto-fable");
	});

	it("falls back to the group's first preset when nothing matches", () => {
		const prev: AgentConfiguration = { id: "x", name: "Accept Edits", model: "m", permissionMode: "acceptEdits" };
		expect(pickConfigForModelChange(fable, prev)?.id).toBe("auto-fable");
	});

	it("preserves the derived mode label for arg-encoded Codex presets", () => {
		const terra: PickerGroup = {
			label: "GPT-5.6 Terra",
			configs: [
				{ id: "terra-medium", name: "GPT-5.6 Terra Medium", model: "gpt-5.6-terra" },
				{ id: "terra-high-bypass", name: "GPT-5.6 Terra High Bypass", model: "gpt-5.6-terra" },
			],
		};
		const previous: AgentConfiguration = {
			id: "sol-high-bypass",
			name: "GPT-5.6 Sol High Bypass",
			model: "gpt-5.6-sol",
		};

		expect(pickConfigForModelChange(terra, previous)?.id).toBe("terra-high-bypass");
	});

	it("matches a default-marked Codex mode to the same mode on another model", () => {
		const terra: PickerGroup = {
			label: "GPT-5.6 Terra",
			configs: [
				{ id: "terra-medium-bypass", name: "x", modeLabel: "Bypass [Medium]", model: "gpt-5.6-terra" },
				{ id: "terra-high-bypass", name: "x", modeLabel: "Bypass [High]", model: "gpt-5.6-terra" },
			],
		};
		const previous: AgentConfiguration = {
			id: "codex-default",
			name: "x",
			modeLabel: "Bypass [High] — Default",
			model: "gpt-5.6-sol",
		};

		expect(pickConfigForModelChange(terra, previous)?.id).toBe("terra-high-bypass");
	});

	it("returns the first preset when there is no previous", () => {
		expect(pickConfigForModelChange(opus, null)?.id).toBe("auto-opus-xhigh");
	});

	it("returns null for an empty group", () => {
		expect(pickConfigForModelChange({ label: "x", configs: [] }, null)).toBeNull();
	});
});

describe("MODEL_GROUP_LABELS", () => {
	it("covers the Claude model strings that drove the redesign", () => {
		expect(MODEL_GROUP_LABELS["claude-fable-5"]).toBe("Fable 5");
		expect(MODEL_GROUP_LABELS["claude-opus-4-8[1m]"]).toBe("Opus 4.8");
		expect(MODEL_GROUP_LABELS["claude-sonnet-5"]).toBe("Sonnet 5");
		expect(MODEL_GROUP_LABELS["claude-opus-4-7[1m]"]).toBe("Opus 4.7");
	});
});

describe("resolveFavoriteChips", () => {
	const codex: CodingAgent = {
		id: "builtin-codex",
		name: "Codex",
		baseCommand: "codex",
		configurations: [{ id: "codex-default", name: "Default (GPT-5.5)", model: "gpt-5.5" }],
	};
	// A config whose id is the live target of a real DEPRECATED_DEFAULT_CONFIG_REMAP entry.
	const remapAgent: CodingAgent = {
		id: "builtin-claude",
		name: "Claude",
		baseCommand: "claude",
		configurations: [
			{ id: "claude-bypass-sonnet5-xhigh", name: "Bypass (Sonnet 5, X-High)", model: "claude-sonnet-5", permissionMode: "bypassPermissions", effort: "xhigh" },
		],
	};
	const fav = (agentId: string, configId: string, uses = 0, lastUsedAt = 0): FavoriteAgentConfig => ({ agentId, configId, uses, lastUsedAt });

	it("orders by uses (then recency) and builds Provider · Model · Mode labels", () => {
		const chips = resolveFavoriteChips(
			[fav("builtin-claude", "bypass-opus-medium", 1, 5), fav("builtin-codex", "codex-default", 9, 1)],
			[claude, codex],
		);
		expect(chips.map((c) => c.label)).toEqual([
			"Codex · GPT-5.5 · Default",
			"Claude · Opus 4.8 · Bypass · Medium",
		]);
		expect(chips[1]).toMatchObject({ agentId: "builtin-claude", configId: "bypass-opus-medium", storedConfigId: "bypass-opus-medium" });
	});

	it("drops favorites whose agent or config no longer resolves (without touching storage)", () => {
		const favs = [fav("builtin-claude", "gone"), fav("ghost-agent", "bypass-opus-medium"), fav("builtin-claude", "bypass-opus-medium")];
		const chips = resolveFavoriteChips(favs, [claude]);
		expect(chips.map((c) => c.configId)).toEqual(["bypass-opus-medium"]);
	});

	it("remaps a deprecated stored configId to its live equivalent, keeping storedConfigId for removal", () => {
		const chips = resolveFavoriteChips([fav("builtin-claude", "claude-bypass-sonnet5")], [remapAgent]);
		expect(chips).toHaveLength(1);
		expect(chips[0]).toMatchObject({
			agentId: "builtin-claude",
			configId: "claude-bypass-sonnet5-xhigh",
			storedConfigId: "claude-bypass-sonnet5",
		});
	});

	it("de-dupes favorites that resolve to the same live pair, keeping the higher-ranked one", () => {
		const chips = resolveFavoriteChips(
			[fav("builtin-claude", "claude-bypass-sonnet5", 1, 0), fav("builtin-claude", "claude-bypass-sonnet5-xhigh", 5, 0)],
			[remapAgent],
		);
		expect(chips).toHaveLength(1);
		// Higher uses (the -xhigh entry) wins; its storedConfigId is the live id.
		expect(chips[0].storedConfigId).toBe("claude-bypass-sonnet5-xhigh");
	});
});
