import {
	CLAUDE_ROLE_BUILTIN_MODEL,
	RECOMMENDED_MODELS,
	RECOMMENDED_REVISION,
	applyPresetUpdates,
	catalogForCurrentRevision,
	markRevisionSeen,
	pendingPresetUpdates,
	RECOMMENDED_TIERS,
	SEEDED_GROUP_LABEL,
	SMART_GROUP_LABEL,
	seedAgentPresets,
	seedCatalogModels,
	seedPresetForTier,
	seedPresetsForAgent,
	tierOfPreset,
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
			const theirs = resolveModelRate(CLAUDE_ROLE_BUILTIN_MODEL[model.pricedAgainst])!;
			expect(ours.output, model.modelId).toBeLessThan(theirs.output);
		}
	});

	it("uses distinct names and distinct ids", () => {
		expect(new Set(RECOMMENDED_MODELS.map((m) => m.name)).size).toBe(RECOMMENDED_MODELS.length);
		expect(new Set(RECOMMENDED_MODELS.map((m) => m.modelId)).size).toBe(RECOMMENDED_MODELS.length);
	});
});

describe("the tiers", () => {
	const practical = RECOMMENDED_TIERS.find((tier) => tier.id === "practical")!;
	const smart = RECOMMENDED_TIERS.find((tier) => tier.id === "smart")!;
	const curated = new Set(RECOMMENDED_MODELS.map((model) => model.name));

	it("names only curated models, since a tier cannot seed a model that is not in the list", () => {
		for (const tier of RECOMMENDED_TIERS) {
			for (const name of [...Object.values(tier.claude), ...Object.values(tier.codex)]) {
				expect(curated.has(name), `${tier.id}: ${name}`).toBe(true);
			}
		}
	});

	it("leaves no slot of either CLI unbound — an unbound one reaches a proxy that cannot serve it", () => {
		for (const tier of RECOMMENDED_TIERS) {
			expect(Object.keys(tier.claude).sort(), tier.id).toEqual(["fable", "haiku", "opus", "sonnet"]);
			expect(Object.keys(tier.codex).sort(), tier.id).toEqual(["main", "review", "subagent"]);
		}
	});

	it("uses distinct ids and distinct labels, because the label IS the Model group", () => {
		expect(new Set(RECOMMENDED_TIERS.map((tier) => tier.id)).size).toBe(RECOMMENDED_TIERS.length);
		expect(new Set(RECOMMENDED_TIERS.map((tier) => tier.label)).size).toBe(RECOMMENDED_TIERS.length);
	});

	it("starts the practical tier on the workhorse and the smart tier on the premium slot", () => {
		expect(practical.launchSlot).toBe("opus");
		expect(smart.launchSlot).toBe("fable");
	});

	it("never puts the cheapest model in Codex review", () => {
		for (const tier of RECOMMENDED_TIERS) {
			const rate = (name: string) =>
				resolveModelRate(RECOMMENDED_MODELS.find((model) => model.name === name)!.modelId)!.output;
			expect(rate(tier.codex.review), tier.id).toBeGreaterThan(rate(tier.codex.subagent));
		}
	});

	it("makes the smart tier genuinely smarter where the work happens, not only on the slot you escalate to", () => {
		// Two tiers that differ only in the premium slot would be the same tier in
		// everyday use: Claude Code does its work on opus/sonnet.
		const everyday = (tier: typeof practical) => [tier.claude.opus, tier.claude.sonnet].join("+");
		expect(everyday(smart)).not.toBe(everyday(practical));
	});

	it("keeps the practical tier's label, so an already-seeded preset stays the tier it always was", () => {
		expect(practical.label).toBe(SEEDED_GROUP_LABEL);
		expect(smart.label).toBe(SMART_GROUP_LABEL);
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
		const preset = seedPresetForTier(claudeAgent(), catalog, RECOMMENDED_TIERS[0], newId)!;
		expect(Object.values(preset.modelRoles!)).not.toContain("stranger");
		const fable = catalog.models.find((m) => m.id === preset.modelRoles!.fable);
		expect(fable?.modelId).toBe(RECOMMENDED_MODELS[1].modelId);
		expect(fable?.providerId).toBe("p1");
	});

	it("binds every Claude role to a catalog model id, not to a name", () => {
		const catalog = seedCatalogModels(emptyCatalog, "p1", newId);
		const preset = seedPresetForTier(claudeAgent(), catalog, RECOMMENDED_TIERS[0], newId)!;
		const ids = catalog.models.map((m) => m.id);
		expect(Object.keys(preset.modelRoles!).sort()).toEqual(["fable", "haiku", "opus", "sonnet"]);
		for (const bound of Object.values(preset.modelRoles!)) expect(ids).toContain(bound);
	});

	it("binds Codex's own three roles, not Claude's", () => {
		const catalog = seedCatalogModels(emptyCatalog, "p1", newId);
		const preset = seedPresetForTier(codexAgent(), catalog, RECOMMENDED_TIERS[0], newId)!;
		expect(Object.keys(preset.modelRoles!).sort()).toEqual(["main", "review", "subagent"]);
	});

	it("keeps the default preset's own args and permissions, and renames it after its tier", () => {
		const catalog = seedCatalogModels(emptyCatalog, "p1", newId);
		const preset = seedPresetForTier(claudeAgent(), catalog, RECOMMENDED_TIERS[0], newId)!;
		expect(preset.additionalArgs).toEqual(["--verbose"]);
		expect(preset.permissionMode).toBe("auto");
		expect(preset.groupLabel).toBe(SEEDED_GROUP_LABEL);
		expect(preset.seededTier).toBe("practical");
		// The clone's name names the model it no longer uses.
		expect(preset.name).not.toContain("Opus 5");
	});

	it("pins each tier's launch slot through the preset's own model, so the session does not start on the priciest bound slot", () => {
		const catalog = seedCatalogModels(emptyCatalog, "p1", newId);
		const [practical, smart] = RECOMMENDED_TIERS.map(
			(tier) => seedPresetForTier(claudeAgent(), catalog, tier, newId)!,
		);
		expect(practical.model).toBe(CLAUDE_ROLE_BUILTIN_MODEL.opus);
		expect(smart.model).toBe(CLAUDE_ROLE_BUILTIN_MODEL.fable);
	});

	it("gives a Codex preset no Claude model, because Codex has no slot to choose between", () => {
		// A Claude id on a Codex preset is invisible while the preset is routed and a
		// broken launch the moment it is not.
		const catalog = seedCatalogModels(emptyCatalog, "p1", newId);
		for (const tier of RECOMMENDED_TIERS) {
			expect(seedPresetForTier(codexAgent(), catalog, tier, newId)!.model, tier.id).toBeUndefined();
		}
	});

	it("refuses to seed an agent dev3 cannot route", () => {
		const gemini: CodingAgent = { ...claudeAgent(), id: "gemini", baseCommand: "gemini" };
		expect(seedPresetForTier(gemini, seedCatalogModels(emptyCatalog, "p1", newId), RECOMMENDED_TIERS[0], newId)).toBeNull();
		expect(seedPresetsForAgent(gemini, seedCatalogModels(emptyCatalog, "p1", newId), newId)).toEqual([]);
	});

	it("refuses a partial binding rather than sending one role to a model the proxy has no idea about", () => {
		const catalog = seedCatalogModels(emptyCatalog, "p1", newId);
		// Drop a model this tier genuinely needs, not just any model in the list.
		const needed = RECOMMENDED_TIERS[0].claude.opus;
		const short = { ...catalog, models: catalog.models.filter((m) => m.name !== needed) };
		expect(seedPresetForTier(claudeAgent(), short, RECOMMENDED_TIERS[0], newId)).toBeNull();
	});

	it("seeds one preset per tier, and a second connect adds none of them again", () => {
		const catalog = seedCatalogModels(emptyCatalog, "p1", newId);
		const tiers = RECOMMENDED_TIERS.length;
		const once = seedAgentPresets([claudeAgent(), codexAgent()], catalog, newId);
		expect(once.map((a) => a.configurations.length)).toEqual([1 + tiers, 1 + tiers]);
		const twice = seedAgentPresets(once, catalog, newId);
		expect(twice.map((a) => a.configurations.length)).toEqual([1 + tiers, 1 + tiers]);
	});

	it("reads a preset seeded before tiers existed as the practical tier, and completes it instead of duplicating it", () => {
		const catalog = seedCatalogModels(emptyCatalog, "p1", newId);
		const legacy: CodingAgent = {
			...claudeAgent(),
			configurations: [
				...claudeAgent().configurations,
				{ id: "old", name: SEEDED_GROUP_LABEL, groupLabel: SEEDED_GROUP_LABEL, modelRoles: { opus: "whatever" } },
			],
		};
		expect(tierOfPreset(legacy.configurations[1])).toBe("practical");
		const seeded = seedPresetsForAgent(legacy, catalog, newId);
		expect(seeded.map((preset) => preset.seededTier)).toEqual(["smart"]);
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

	it("offers a tier this revision introduced to a user who is already seeded", () => {
		// Without this, an existing user would never see a new tier at all: the
		// connect flow is the only other place that seeds, and they connected long ago.
		const { catalog, agent } = oldWorld();
		const proposed = catalogForCurrentRevision(catalog, newId)!;
		const updates = pendingPresetUpdates([agent], proposed, newId);
		const added = updates.filter((update) => update.newPreset);
		expect(added.map((update) => update.tierId)).toEqual(["smart"]);
		// Every role reads as "nothing → model", so the modal shows a whole preset
		// rather than pretending something was replaced.
		expect(added[0].changes.every((change) => change.from === null)).toBe(true);
		expect(added[0].newPreset!.id).not.toBe("");
	});

	it("appends that tier on approval, and rebinds the old one in the same write", () => {
		const { catalog, agent } = oldWorld();
		const proposed = catalogForCurrentRevision(catalog, newId)!;
		const updates = pendingPresetUpdates([agent], proposed, newId);
		const [out] = applyPresetUpdates([agent], updates);
		const tiers = out.configurations.map(tierOfPreset).filter(Boolean);
		expect(tiers.sort()).toEqual(["practical", "smart"]);
		expect(out.configurations).toHaveLength(agent.configurations.length + 1);
		// And the appended one is a launchable preset, not a stub.
		const smart = out.configurations.find((c) => c.seededTier === "smart")!;
		expect(smart.groupLabel).toBe(SMART_GROUP_LABEL);
		expect(Object.keys(smart.modelRoles!).sort()).toEqual(["fable", "haiku", "opus", "sonnet"]);
	});

	it("stamps the launch slot of the tier it rebinds, so an approved practical preset stops starting on the premium slot", () => {
		const { catalog, agent } = oldWorld();
		const proposed = catalogForCurrentRevision(catalog, newId)!;
		const updates = pendingPresetUpdates([agent], proposed, newId);
		const [out] = applyPresetUpdates([agent], updates);
		expect(out.configurations.find((c) => c.id === "seeded")!.model).toBe(CLAUDE_ROLE_BUILTIN_MODEL.opus);
	});

	it("does not ask again about a declined tier it never created", () => {
		// Declining leaves the smart preset non-existent. If the decline only
		// stamped the presets it listed, the offer would return every launch.
		const { catalog, agent } = oldWorld();
		const proposed = catalogForCurrentRevision(catalog, newId)!;
		const [out] = markRevisionSeen([agent], pendingPresetUpdates([agent], proposed, newId));
		expect(out.configurations).toHaveLength(agent.configurations.length);
		expect(pendingPresetUpdates([out], proposed, newId)).toEqual([]);
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
