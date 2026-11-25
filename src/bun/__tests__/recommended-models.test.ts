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
import { hasMillionTokenWindow, isValidCatalogModelName } from "../../shared/model-catalog";

describe("the curated list itself", () => {
	it("gives every recommendation a distinct name the wire format accepts and a distinct id", () => {
		// The name travels inside `provider/name`; an invalid one is an
		// unroutable request that only shows up at launch.
		for (const model of RECOMMENDED_MODELS) {
			expect(isValidCatalogModelName(model.name)).toBe(true);
		}
		expect(new Set(RECOMMENDED_MODELS.map((m) => m.name)).size).toBe(RECOMMENDED_MODELS.length);
		expect(new Set(RECOMMENDED_MODELS.map((m) => m.modelId)).size).toBe(RECOMMENDED_MODELS.length);
	});

	it("prices every recommendation and built-in, and is actually cheaper than what it replaces — the whole premise", () => {
		for (const builtin of Object.values(CLAUDE_ROLE_BUILTIN_MODEL)) {
			expect(resolveModelRate(builtin), builtin).not.toBeNull();
		}
		for (const model of RECOMMENDED_MODELS) {
			expect(resolveModelRate(model.modelId), model.modelId).not.toBeNull();
			const ours = resolveModelRate(model.modelId)!;
			const theirs = resolveModelRate(CLAUDE_ROLE_BUILTIN_MODEL[model.pricedAgainst])!;
			expect(ours.output, model.modelId).toBeLessThan(theirs.output);
		}
	});

	// The workhorse the list is built around. Verified against OpenRouter's live
	// catalog on 2026-09-11: a typo here is an unroutable 404 at launch, and the
	// two ids it replaced would quietly cost the user more.
	it("routes the everyday slots to DeepSeek V4.1 Flash, priced and sized under its own name", () => {
		const ids = RECOMMENDED_MODELS.map((model) => model.modelId);
		expect(ids).toContain("deepseek/deepseek-v4.1-flash");
		expect(ids).not.toContain("z-ai/glm-5.2");
		expect(ids).not.toContain("deepseek/deepseek-v4-flash-0731");
		// `deepseek-v4-flash` does not match `deepseek-v4.1-flash` — a dot is not a
		// dash — so both tables need their own row or the model falls through.
		expect(resolveModelRate("deepseek/deepseek-v4.1-flash")).toEqual(
			expect.objectContaining({ input: 0.3, output: 1.2 }),
		);
		expect(hasMillionTokenWindow("deepseek/deepseek-v4.1-flash")).toBe(true);
	});
});

describe("the tiers", () => {
	const practical = RECOMMENDED_TIERS.find((tier) => tier.id === "practical")!;
	const smart = RECOMMENDED_TIERS.find((tier) => tier.id === "smart")!;
	const curated = new Set(RECOMMENDED_MODELS.map((model) => model.name));

	it("names only curated models, leaves no slot of either CLI unbound, and uses distinct ids and labels", () => {
		// A tier cannot seed a model that is not in the list; an unbound slot reaches a
		// proxy that cannot serve it; the label IS the Model group.
		for (const tier of RECOMMENDED_TIERS) {
			for (const name of [...Object.values(tier.claude), ...Object.values(tier.codex)]) {
				expect(curated.has(name), `${tier.id}: ${name}`).toBe(true);
			}
			expect(Object.keys(tier.claude).sort(), tier.id).toEqual(["fable", "haiku", "opus", "sonnet"]);
			expect(Object.keys(tier.codex).sort(), tier.id).toEqual(["main", "review", "subagent"]);
		}
		expect(new Set(RECOMMENDED_TIERS.map((tier) => tier.id)).size).toBe(RECOMMENDED_TIERS.length);
		expect(new Set(RECOMMENDED_TIERS.map((tier) => tier.label)).size).toBe(RECOMMENDED_TIERS.length);
	});

	it("never downgrades Codex review below the subagents it reviews", () => {
		// Was "strictly pricier than the subagent". One model now serves both the
		// everyday and the escalation class, so a tier may legitimately run the same
		// model in both slots; what must never happen is review being the CHEAPER one.
		for (const tier of RECOMMENDED_TIERS) {
			const rate = (name: string) =>
				resolveModelRate(RECOMMENDED_MODELS.find((model) => model.name === name)!.modelId)!.output;
			expect(rate(tier.codex.review), tier.id).toBeGreaterThanOrEqual(rate(tier.codex.subagent));
		}
	});

	it("starts practical on the workhorse and smart on a genuinely different premium model, keeping the practical label", () => {
		expect(practical.launchSlot).toBe("opus");
		expect(smart.launchSlot).toBe("fable");
		// Two tiers that run the same model on the slot the session launches on would
		// be the same tier in everyday use, whatever the other slots say.
		const launch = (tier: typeof practical) => tier.claude[tier.launchSlot];
		expect(launch(smart)).not.toBe(launch(practical));
		// An already-seeded preset stays the tier it always was.
		expect(practical.label).toBe(SEEDED_GROUP_LABEL);
		expect(smart.label).toBe(SMART_GROUP_LABEL);
	});
});

describe("unconnectedRecommendations", () => {
	const provider = { id: "p1", kind: "openrouter" as const };

	it("offers everything with no provider, and goes silent the moment the user has any provider of their own", () => {
		expect(unconnectedRecommendations({ providers: [] })).toHaveLength(RECOMMENDED_MODELS.length);
		// They already know third-party models exist — that is the only thing
		// these rows are for. Keeping them up would be nagging.
		expect(unconnectedRecommendations({ providers: [provider] })).toEqual([]);
		expect(unconnectedRecommendations({ providers: [{ id: "p2", kind: "custom" }] })).toEqual([]);
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

	it("adds every recommendation under that provider, and nothing the second time", () => {
		const once = seedCatalogModels(emptyCatalog, "p1", newId);
		expect(once.models.map((m) => m.modelId).sort()).toEqual(RECOMMENDED_MODELS.map((m) => m.modelId).sort());
		expect(once.models.every((m) => m.providerId === "p1")).toBe(true);
		const twice = seedCatalogModels(once, "p1", newId);
		expect(twice.models).toHaveLength(once.models.length);
	});

	it("renames around a taken name and binds the model it just seeded, never a stranger's model that owns the same name", () => {
		// The user already has a model with the curated name on their own endpoint. The
		// seeded recommendation is renamed around it, so a lookup by curated name
		// would resolve to THEIR model — the silent wrong-model case.
		const taken: ModelCatalogView = {
			providers: [provider, { id: "p2", kind: "custom", label: "Mine", hasKey: false }],
			models: [{ id: "stranger", providerId: "p2", name: RECOMMENDED_MODELS[1].name, modelId: "mine/whatever" }],
		};
		const catalog = seedCatalogModels(taken, "p1", newId);
		const names = catalog.models.map((m) => m.name);
		expect(new Set(names).size).toBe(names.length);
		const preset = seedPresetForTier(claudeAgent(), catalog, RECOMMENDED_TIERS[0], newId)!;
		expect(Object.values(preset.modelRoles!)).not.toContain("stranger");
		const fable = catalog.models.find((m) => m.id === preset.modelRoles!.fable);
		expect(fable?.modelId).toBe(RECOMMENDED_MODELS[1].modelId);
		expect(fable?.providerId).toBe("p1");
	});

	it("binds every Claude role to a catalog model id, keeps the default preset's args and permissions, and renames it after its tier", () => {
		const catalog = seedCatalogModels(emptyCatalog, "p1", newId);
		const preset = seedPresetForTier(claudeAgent(), catalog, RECOMMENDED_TIERS[0], newId)!;
		const ids = catalog.models.map((m) => m.id);
		expect(Object.keys(preset.modelRoles!).sort()).toEqual(["fable", "haiku", "opus", "sonnet"]);
		for (const bound of Object.values(preset.modelRoles!)) expect(ids).toContain(bound);
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

	it("binds Codex's own three roles and gives a Codex preset no Claude model, because Codex has no slot to choose between", () => {
		// A Claude id on a Codex preset is invisible while the preset is routed and a
		// broken launch the moment it is not.
		const catalog = seedCatalogModels(emptyCatalog, "p1", newId);
		for (const tier of RECOMMENDED_TIERS) {
			const preset = seedPresetForTier(codexAgent(), catalog, tier, newId)!;
			expect(Object.keys(preset.modelRoles!).sort(), tier.id).toEqual(["main", "review", "subagent"]);
			expect(preset.model, tier.id).toBeUndefined();
		}
	});

	it("refuses to seed an agent dev3 cannot route, leaving it completely untouched", () => {
		const gemini: CodingAgent = { ...claudeAgent(), id: "gemini", baseCommand: "gemini" };
		expect(seedPresetForTier(gemini, seedCatalogModels(emptyCatalog, "p1", newId), RECOMMENDED_TIERS[0], newId)).toBeNull();
		expect(seedPresetsForAgent(gemini, seedCatalogModels(emptyCatalog, "p1", newId), newId)).toEqual([]);
		const [out] = seedAgentPresets([gemini], seedCatalogModels(emptyCatalog, "p1", newId), newId);
		expect(out).toEqual(gemini);
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

	it("says nothing about a current-revision preset, a user-built preset, matching bindings, or a catalog no provider serves", () => {
		const { catalog, agent } = oldWorld();
		const current = {
			...agent,
			configurations: agent.configurations.map((c) =>
				c.id === "seeded" ? { ...c, seededRevision: RECOMMENDED_REVISION } : c,
			),
		};
		const proposed = catalogForCurrentRevision(catalog, newId)!;
		expect(pendingPresetUpdates([current], proposed)).toEqual([]);

		const mine = {
			...agent,
			configurations: agent.configurations.map((c) =>
				c.id === "seeded" ? { ...c, groupLabel: "My own mix" } : c,
			),
		};
		expect(pendingPresetUpdates([mine], catalogForCurrentRevision(catalog, newId)!)).toEqual([]);

		const [update] = pendingPresetUpdates([agent], proposed);
		const rebound = applyPresetUpdates([agent], [update]);
		expect(pendingPresetUpdates(rebound, proposed)).toEqual([]);

		expect(catalogForCurrentRevision({ providers: [], models: [] }, newId)).toBeNull();
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

	it("appends that tier on approval, and rebinds, stamps and pins the launch slot of the old one in the same write", () => {
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
		// An approved practical preset stops starting on the premium slot.
		const seeded = out.configurations.find((c) => c.id === "seeded")!;
		expect(seeded.model).toBe(CLAUDE_ROLE_BUILTIN_MODEL.opus);
		expect(seeded.seededRevision).toBe(RECOMMENDED_REVISION);
		expect(seeded.modelRoles).toEqual(updates.find((u) => !u.newPreset)!.modelRoles);
		// Everything else the user has is left exactly where it was.
		expect(out.configurations.find((c) => c.id === "c1")).toEqual(agent.configurations[0]);
	});

	it("stamps but changes nothing when the answer is no, and does not ask again about a declined tier it never created", () => {
		// Declining leaves the smart preset non-existent. If the decline only
		// stamped the presets it listed, the offer would return every launch.
		const { catalog, agent } = oldWorld();
		const proposed = catalogForCurrentRevision(catalog, newId)!;
		const [out] = markRevisionSeen([agent], pendingPresetUpdates([agent], proposed, newId));
		expect(out.configurations).toHaveLength(agent.configurations.length);
		expect(pendingPresetUpdates([out], proposed, newId)).toEqual([]);
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
