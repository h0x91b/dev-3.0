import {
	CLAUDE_ROLE_BUILTIN_MODEL,
	RECOMMENDED_MODELS,
	RECOMMENDED_REVISION,
	applyPresetUpdates,
	catalogForCurrentRevision,
	markRevisionSeen,
	pendingPresetUpdates,
	SEEDED_GROUP_LABEL,
	recommendedClaudeRoleModelIds,
	recommendedCodexRoleModelIds,
	seedAgentPresets,
	seedCatalogModels,
	seedPresetForAgent,
	unconnectedRecommendations,
} from "../../shared/recommended-models";
import type { CodingAgent, ModelCatalogView } from "../../shared/types";
import { resolveModelRate } from "../../shared/agent-pricing";
import { isValidCatalogModelName } from "../../shared/model-catalog";

describe("the curated list itself", () => {
	it("gives every recommendation a name the wire format accepts", () => {
		// The name travels inside `provider/name`; an invalid one is an
		// unroutable request that only shows up at launch.
		for (const model of RECOMMENDED_MODELS) {
			expect(isValidCatalogModelName(model.name)).toBe(true);
		}
	});

	it("prices every recommendation, so no locked row can render without a number", () => {
		for (const model of RECOMMENDED_MODELS) {
			expect(resolveModelRate(model.modelId), model.modelId).not.toBeNull();
		}
	});

	it("prices every built-in it is compared against", () => {
		for (const builtin of Object.values(CLAUDE_ROLE_BUILTIN_MODEL)) {
			expect(resolveModelRate(builtin), builtin).not.toBeNull();
		}
	});

	it("is actually cheaper than what it replaces — the whole premise", () => {
		for (const model of RECOMMENDED_MODELS) {
			const ours = resolveModelRate(model.modelId)!;
			const theirs = resolveModelRate(CLAUDE_ROLE_BUILTIN_MODEL[model.claudeRole])!;
			expect(ours.output, model.modelId).toBeLessThan(theirs.output);
		}
	});

	it("uses distinct names and distinct ids", () => {
		expect(new Set(RECOMMENDED_MODELS.map((m) => m.name)).size).toBe(RECOMMENDED_MODELS.length);
		expect(new Set(RECOMMENDED_MODELS.map((m) => m.modelId)).size).toBe(RECOMMENDED_MODELS.length);
	});
});

describe("seeded role bindings", () => {
	it("leaves no Claude slot unbound, since an unbound one reaches a proxy that cannot serve it", () => {
		const roles = recommendedClaudeRoleModelIds();
		expect(Object.keys(roles).sort()).toEqual(["fable", "haiku", "opus", "sonnet"]);
	});

	it("gives the fast slots the same cheap model", () => {
		const roles = recommendedClaudeRoleModelIds();
		expect(roles.haiku).toBe(roles.sonnet);
	});

	it("never puts the cheapest model in Codex review", () => {
		const roles = recommendedCodexRoleModelIds();
		expect(roles.review).toBe(roles.main);
		expect(roles.review).not.toBe(roles.subagent);
	});

	it("binds every Codex role", () => {
		expect(Object.keys(recommendedCodexRoleModelIds()).sort()).toEqual(["main", "review", "subagent"]);
	});
});

describe("unconnectedRecommendations", () => {
	const provider = { id: "p1", kind: "openrouter" as const };

	it("offers everything when the catalog is empty", () => {
		expect(unconnectedRecommendations({ providers: [] })).toHaveLength(RECOMMENDED_MODELS.length);
	});

	it("goes silent the moment the user has a provider of their own", () => {
		// They already know third-party models exist — that is the only thing
		// these rows are for. Keeping them up would be nagging.
		expect(unconnectedRecommendations({ providers: [provider] })).toEqual([]);
	});

	it("goes silent for a local provider too, not just the one dev3 recommends", () => {
		expect(
			unconnectedRecommendations({ providers: [{ id: "p2", kind: "custom" }] }),
		).toEqual([]);
	});

	it("still offers everything when the last provider was deleted", () => {
		expect(unconnectedRecommendations({ providers: [] })).toHaveLength(RECOMMENDED_MODELS.length);
	});
});

describe("seeding a freshly connected provider", () => {
	let n = 0;
	const newId = () => `id-${++n}`;
	beforeEach(() => {
		n = 0;
	});

	const provider = { id: "p1", kind: "openrouter" as const, label: "OpenRouter", hasKey: true };
	const emptyCatalog: ModelCatalogView = { providers: [provider], models: [] };

	function claudeAgent(): CodingAgent {
		return {
			id: "claude",
			name: "Claude Code",
			baseCommand: "claude",
			defaultConfigId: "c1",
			configurations: [
				{ id: "c1", name: "Default (Opus 5)", model: "claude-opus-5[1m]", permissionMode: "auto", additionalArgs: ["--verbose"] },
			],
		};
	}

	function codexAgent(): CodingAgent {
		return {
			id: "codex",
			name: "Codex",
			baseCommand: "codex",
			defaultConfigId: "x1",
			configurations: [{ id: "x1", name: "GPT-5.5 Medium", model: "gpt-5.5", effort: "medium" }],
		};
	}

	it("adds every recommendation to the catalog under that provider", () => {
		const seeded = seedCatalogModels(emptyCatalog, "p1", newId);
		expect(seeded.models.map((m) => m.modelId).sort()).toEqual(RECOMMENDED_MODELS.map((m) => m.modelId).sort());
		expect(seeded.models.every((m) => m.providerId === "p1")).toBe(true);
	});

	it("adds nothing the second time, so connecting twice cannot duplicate a model", () => {
		const once = seedCatalogModels(emptyCatalog, "p1", newId);
		const twice = seedCatalogModels(once, "p1", newId);
		expect(twice.models).toHaveLength(once.models.length);
	});

	it("renames around a name another provider already took, instead of failing the save", () => {
		const taken: ModelCatalogView = {
			providers: [provider, { id: "p2", kind: "custom", label: "Mine", hasKey: false }],
			models: [{ id: "m0", providerId: "p2", name: RECOMMENDED_MODELS[0].name, modelId: "something/else" }],
		};
		const seeded = seedCatalogModels(taken, "p1", newId);
		const names = seeded.models.map((m) => m.name);
		expect(new Set(names).size).toBe(names.length);
	});

	it("binds the model it just seeded, never a stranger's model that owns the same name", () => {
		// The user already has a model with the curated name on their own endpoint. The
		// seeded recommendation is renamed around it, so a lookup by curated name
		// would resolve to THEIR model — the silent wrong-model case.
		const taken: ModelCatalogView = {
			providers: [provider, { id: "p2", kind: "custom", label: "Mine", hasKey: false }],
			models: [{ id: "stranger", providerId: "p2", name: RECOMMENDED_MODELS[1].name, modelId: "mine/whatever" }],
		};
		const catalog = seedCatalogModels(taken, "p1", newId);
		const preset = seedPresetForAgent(claudeAgent(), catalog, newId)!;
		expect(Object.values(preset.modelRoles!)).not.toContain("stranger");
		const opus = catalog.models.find((m) => m.id === preset.modelRoles!.opus);
		expect(opus?.modelId).toBe(RECOMMENDED_MODELS[1].modelId);
		expect(opus?.providerId).toBe("p1");
	});

	it("binds every Claude role to a catalog model id, not to a name", () => {
		const catalog = seedCatalogModels(emptyCatalog, "p1", newId);
		const preset = seedPresetForAgent(claudeAgent(), catalog, newId)!;
		const ids = catalog.models.map((m) => m.id);
		expect(Object.keys(preset.modelRoles!).sort()).toEqual(["fable", "haiku", "opus", "sonnet"]);
		for (const bound of Object.values(preset.modelRoles!)) expect(ids).toContain(bound);
	});

	it("binds Codex's own three roles, not Claude's", () => {
		const catalog = seedCatalogModels(emptyCatalog, "p1", newId);
		const preset = seedPresetForAgent(codexAgent(), catalog, newId)!;
		expect(Object.keys(preset.modelRoles!).sort()).toEqual(["main", "review", "subagent"]);
	});

	it("keeps the default preset's own args and permissions, and drops its pinned model", () => {
		const catalog = seedCatalogModels(emptyCatalog, "p1", newId);
		const preset = seedPresetForAgent(claudeAgent(), catalog, newId)!;
		expect(preset.additionalArgs).toEqual(["--verbose"]);
		expect(preset.permissionMode).toBe("auto");
		expect(preset.model).toBeUndefined();
		expect(preset.groupLabel).toBe(SEEDED_GROUP_LABEL);
		// The clone's name names the model it no longer uses.
		expect(preset.name).not.toContain("Opus 5");
	});

	it("refuses to seed an agent dev3 cannot route", () => {
		const gemini: CodingAgent = { ...claudeAgent(), id: "gemini", baseCommand: "gemini" };
		expect(seedPresetForAgent(gemini, seedCatalogModels(emptyCatalog, "p1", newId), newId)).toBeNull();
	});

	it("refuses a partial binding rather than sending one role to a model the proxy has no idea about", () => {
		const catalog = seedCatalogModels(emptyCatalog, "p1", newId);
		const short = { ...catalog, models: catalog.models.slice(1) };
		expect(seedPresetForAgent(claudeAgent(), short, newId)).toBeNull();
	});

	it("seeds each agent once — a second connect adds no second preset", () => {
		const catalog = seedCatalogModels(emptyCatalog, "p1", newId);
		const once = seedAgentPresets([claudeAgent(), codexAgent()], catalog, newId);
		expect(once.map((a) => a.configurations.length)).toEqual([2, 2]);
		const twice = seedAgentPresets(once, catalog, newId);
		expect(twice.map((a) => a.configurations.length)).toEqual([2, 2]);
	});

	it("leaves an agent it cannot route completely untouched", () => {
		const gemini: CodingAgent = { ...claudeAgent(), id: "gemini", baseCommand: "gemini" };
		const [out] = seedAgentPresets([gemini], seedCatalogModels(emptyCatalog, "p1", newId), newId);
		expect(out).toEqual(gemini);
	});
});

describe("keeping an already-seeded user current", () => {
	let n = 0;
	const newId = () => `new-${++n}`;
	beforeEach(() => {
		n = 0;
	});

	const provider = { id: "p1", kind: "openrouter" as const, label: "OpenRouter", hasKey: true };

	/** A user seeded by an older revision: the preset is stamped behind the
	 *  current one and its catalog is missing what the new revision added. */
	function oldWorld() {
		const catalog: ModelCatalogView = {
			providers: [provider],
			models: [{ id: "m-old", providerId: "p1", name: "legacy", modelId: "legacy/model" }],
		};
		const agent: CodingAgent = {
			id: "claude",
			name: "Claude Code",
			baseCommand: "claude",
			defaultConfigId: "c1",
			configurations: [
				{ id: "c1", name: "Default", model: "claude-opus-5[1m]" },
				{
					id: "seeded",
					name: SEEDED_GROUP_LABEL,
					groupLabel: SEEDED_GROUP_LABEL,
					modelRoles: { fable: "m-old", opus: "m-old", sonnet: "m-old", haiku: "m-old" },
					seededRevision: RECOMMENDED_REVISION - 1,
				},
			],
		};
		return { catalog, agent };
	}

	it("proposes the models this revision added, without saving them first", () => {
		const { catalog, agent } = oldWorld();
		const proposed = catalogForCurrentRevision(catalog, newId)!;
		// The saved catalog is untouched — the user has not agreed to anything.
		expect(catalog.models).toHaveLength(1);
		expect(proposed.models.length).toBe(1 + RECOMMENDED_MODELS.length);

		const [update] = pendingPresetUpdates([agent], proposed);
		expect(update.configId).toBe("seeded");
		expect(update.changes.map((c) => c.roleId).sort()).toEqual(["fable", "haiku", "opus", "sonnet"]);
		// Both sides named, so the modal can show what is being replaced.
		expect(update.changes.every((c) => c.from === "legacy")).toBe(true);
		expect(update.changes.map((c) => c.to)).toContain(RECOMMENDED_MODELS[1].name);
	});

	it("says nothing about a preset already on the current revision", () => {
		const { catalog, agent } = oldWorld();
		const current = {
			...agent,
			configurations: agent.configurations.map((c) =>
				c.id === "seeded" ? { ...c, seededRevision: RECOMMENDED_REVISION } : c,
			),
		};
		const proposed = catalogForCurrentRevision(catalog, newId)!;
		expect(pendingPresetUpdates([current], proposed)).toEqual([]);
	});

	it("says nothing about a preset the user built themselves", () => {
		const { catalog, agent } = oldWorld();
		const mine = {
			...agent,
			configurations: agent.configurations.map((c) =>
				c.id === "seeded" ? { ...c, groupLabel: "My own mix" } : c,
			),
		};
		expect(pendingPresetUpdates([mine], catalogForCurrentRevision(catalog, newId)!)).toEqual([]);
	});

	it("says nothing when the bindings already match, even at an old revision", () => {
		const { catalog, agent } = oldWorld();
		const proposed = catalogForCurrentRevision(catalog, newId)!;
		const [update] = pendingPresetUpdates([agent], proposed);
		const rebound = applyPresetUpdates([agent], [update]);
		expect(pendingPresetUpdates(rebound, proposed)).toEqual([]);
	});

	it("has nothing to propose when no provider could serve the models", () => {
		expect(catalogForCurrentRevision({ providers: [], models: [] }, newId)).toBeNull();
	});

	it("rebinds and stamps on approval", () => {
		const { catalog, agent } = oldWorld();
		const proposed = catalogForCurrentRevision(catalog, newId)!;
		const updates = pendingPresetUpdates([agent], proposed);
		const [out] = applyPresetUpdates([agent], updates);
		const seeded = out.configurations.find((c) => c.id === "seeded")!;
		expect(seeded.seededRevision).toBe(RECOMMENDED_REVISION);
		expect(seeded.modelRoles).toEqual(updates[0].modelRoles);
		// Everything else the user has is left exactly where it was.
		expect(out.configurations.find((c) => c.id === "c1")).toEqual(agent.configurations[0]);
	});

	it("stamps but changes nothing when the answer is no, so the question is asked once", () => {
		const { catalog, agent } = oldWorld();
		const proposed = catalogForCurrentRevision(catalog, newId)!;
		const updates = pendingPresetUpdates([agent], proposed);
		const [out] = markRevisionSeen([agent], updates);
		const seeded = out.configurations.find((c) => c.id === "seeded")!;
		expect(seeded.modelRoles).toEqual(agent.configurations[1].modelRoles);
		expect(seeded.seededRevision).toBe(RECOMMENDED_REVISION);
		expect(pendingPresetUpdates([out], proposed)).toEqual([]);
	});

	it("stamps a freshly seeded preset, so a new user is never asked about the set they just took", () => {
		const catalog = seedCatalogModels({ providers: [provider], models: [] }, "p1", newId);
		const agent: CodingAgent = {
			id: "claude",
			name: "Claude Code",
			baseCommand: "claude",
			defaultConfigId: "c1",
			configurations: [{ id: "c1", name: "Default" }],
		};
		const [seededAgent] = seedAgentPresets([agent], catalog, newId);
		expect(pendingPresetUpdates([seededAgent], catalog)).toEqual([]);
	});
});
