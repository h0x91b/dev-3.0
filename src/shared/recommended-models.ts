/**
 * The open-source models dev3 offers before the user has connected anything.
 *
 * Two jobs, and they are the same data:
 *   - the launcher shows them in the Model list as locked rows with a price, so
 *     a user who never heard of this learns it exists at the moment they pick a
 *     model (that is the single biggest drop-off — nobody searches for a
 *     capability they do not know about);
 *   - connecting a provider seeds the catalog and the presets from the same
 *     list, so the user never types a model slug.
 *
 * Deliberately hardcoded rather than fetched: a first run must work offline, and
 * a stale list is a far smaller problem than an empty one. Prices are shown as
 * an order of magnitude, never as a bill — they move, and a release is how they
 * get corrected.
 */

import { modelRolesForAgent, type CatalogProviderKind } from "./model-catalog";
import type { AgentConfiguration, CodingAgent, ModelCatalogView } from "./types";

/** Claude Code's own slots, premium first — the order dev3 shows them in. */
export type ClaudeRoleId = "fable" | "opus" | "sonnet" | "haiku";

/** Group label of the everyday tier, and the marker of a preset seeded before
 *  tiers existed. Kept as-is on purpose: an installed app already carries this
 *  string, and the practical tier is what that preset always was.
 *
 *  Not named after the licence: "open source" describes where the weights came
 *  from, which is not why anyone picks this. What it promises is the same job
 *  for a fraction of the money. */
export const SEEDED_GROUP_LABEL = "Best value";

/** Group label of the escalation tier. A separate label rather than a second
 *  preset under the same one: the launcher's Model column groups BY label, so
 *  two tiers sharing a label would collapse into one Model row whose two modes
 *  are indistinguishable. */
export const SMART_GROUP_LABEL = "Best value · Smart";

export type RecommendedTierId = "practical" | "smart";

export interface RecommendedTier {
	id: RecommendedTierId;
	/** Both the preset name and its Model-column group. */
	label: string;
	/** The Claude slot the session starts on. Codex has no equivalent choice —
	 *  its `main` is the launch model by construction. */
	launchSlot: ClaudeRoleId;
	/** Claude role id → curated model name. */
	claude: Record<string, string>;
	/** Codex role id → curated model name. */
	codex: Record<string, string>;
}

export interface RecommendedModel {
	/** Provider that serves it. Only providers dev3 can configure unattended. */
	providerKind: CatalogProviderKind;
	/** The provider-native id, exactly as it travels on the wire. */
	modelId: string;
	/** The catalog name dev3 gives it — also what the user sees in role pickers. */
	name: string;
	/** Human label for the Model list. */
	label: string;
	/** The built-in Claude slot this model is priced AGAINST in the launcher —
	 *  a display choice, not a binding. Which role it actually fills is a
	 *  property of the tier, and one model fills different roles in different
	 *  tiers. */
	pricedAgainst: ClaudeRoleId;
	/** One short line on why this one. Shown under the model name. */
	blurbKey: string;
}

/**
 * Bump this — in the same commit — whenever the list or the tiers below change in
 * a way an existing user should hear about: a model added, removed, or moved to
 * another role. A seeded preset remembers the revision it was built from, and a
 * preset behind the current one is what the "new models are out" prompt is
 * looking for.
 *
 * Do NOT bump for a label, blurb, or price correction: nothing the user runs
 * changes, and the prompt is a promise that something did.
 */
export const RECOMMENDED_REVISION = 3;

/**
 * The curated models, in the order the launcher lists them. Every tier below
 * draws from exactly this set — a model that no tier uses has no reason to be
 * named, and a tier naming a model that is not here cannot be seeded.
 */

export const RECOMMENDED_MODELS: RecommendedModel[] = [
	{
		providerKind: "openrouter",
		modelId: "moonshotai/kimi-k3",
		name: "kimi-k3",
		label: "Kimi K3",
		pricedAgainst: "fable",
		blurbKey: "recommended.kimiK3",
	},
	{
		providerKind: "openrouter",
		modelId: "qwen/qwen3.8-max",
		name: "qwen3.8-max",
		label: "Qwen3.8 Max",
		pricedAgainst: "fable",
		blurbKey: "recommended.qwen38Max",
	},
	{
		providerKind: "openrouter",
		modelId: "z-ai/glm-5.2",
		name: "glm-5.2",
		label: "GLM 5.2",
		pricedAgainst: "opus",
		blurbKey: "recommended.glm52",
	},
	{
		providerKind: "openrouter",
		modelId: "deepseek/deepseek-v4-flash-0731",
		name: "ds-flash",
		label: "DeepSeek V4 Flash",
		pricedAgainst: "sonnet",
		blurbKey: "recommended.dsFlash",
	},
];

/**
 * The tiers a connected provider seeds, in the order they appear.
 *
 * A tier is a whole raster over an agent's roles, not one model: the point of
 * routing is that the slot doing the everyday work and the slot you escalate to
 * are different models. Both CLIs are declared explicitly rather than derived
 * from one another — Claude has four slots, Codex three, and Codex has no
 * premium slot at all, so "the same tier" means different things to them.
 *
 * `launchSlot` is the slot the session actually STARTS on. Practical starts on
 * the workhorse so an ordinary turn costs workhorse money and the premium model
 * is one `/model` away; smart starts on the premium model, because that is what
 * the user picked it for.
 */
export const RECOMMENDED_TIERS: RecommendedTier[] = [
	{
		id: "practical",
		label: SEEDED_GROUP_LABEL,
		launchSlot: "opus",
		claude: { fable: "qwen3.8-max", opus: "glm-5.2", sonnet: "ds-flash", haiku: "ds-flash" },
		codex: { main: "glm-5.2", subagent: "ds-flash", review: "glm-5.2" },
	},
	{
		id: "smart",
		label: SMART_GROUP_LABEL,
		launchSlot: "fable",
		claude: { fable: "kimi-k3", opus: "glm-5.2", sonnet: "glm-5.2", haiku: "ds-flash" },
		codex: { main: "kimi-k3", subagent: "glm-5.2", review: "kimi-k3" },
	},
];

/** The built-in model each recommendation stands next to in the launcher, so
 *  the price comparison is against something the user already recognises. */
export const CLAUDE_ROLE_BUILTIN_MODEL: Record<ClaudeRoleId, string> = {
	fable: "claude-fable-5",
	opus: "claude-opus-5",
	sonnet: "claude-sonnet-5",
	haiku: "claude-haiku-4-5",
};

/** Curated model name per role for one tier and one agent CLI. Claude's role
 *  ids and Codex's are disjoint, so the caller never has to say which it wants —
 *  it asks for a role it actually has. */
function tierRoleNames(tier: RecommendedTier): Record<string, string> {
	return { ...tier.claude, ...tier.codex };
}

/** The Claude model id whose family names this tier's launch slot. It reaches
 *  the launch as the preset's own `model`, and `resolveModelRoleLaunch` turns it
 *  into the wire name bound to that slot — never into a Claude request. */
function tierLaunchModel(tier: RecommendedTier): string {
	return CLAUDE_ROLE_BUILTIN_MODEL[tier.launchSlot];
}

/**
 * The recommendations the launcher shows as locked rows.
 *
 * Empty as soon as the user has ANY provider of their own — OpenRouter, Ollama,
 * Fireworks, a custom endpoint, anything. The rows exist to teach someone that
 * a third-party model is possible at all; a user who already configured a
 * provider knows, and advertising to them is nagging. The catalog's own
 * "add a provider" action stays available regardless — that is a separate
 * control and never depends on this list.
 *
 * Otherwise: the whole curated set. The rule is per-catalog, not per-model — an
 * empty catalog has nothing connected by definition.
 */
export function unconnectedRecommendations(
	catalog: { providers: { id: string; kind: CatalogProviderKind }[] },
): RecommendedModel[] {
	return catalog.providers.length > 0 ? [] : RECOMMENDED_MODELS;
}

// ------------------------------------------------------------------ seed ---

/**
 * Add the recommendations to the catalog under an existing provider.
 *
 * Matched on the provider-native id, so re-running it after the user renamed a
 * model adds nothing: connecting twice must not leave two rows that serve the
 * same thing and differ only by name.
 */
export function seedCatalogModels(
	catalog: ModelCatalogView,
	providerId: string,
	newId: () => string,
): ModelCatalogView {
	const existing = new Set(catalog.models.filter((m) => m.providerId === providerId).map((m) => m.modelId));
	const taken = new Set(catalog.models.map((m) => m.name));
	const added = RECOMMENDED_MODELS.filter((model) => !existing.has(model.modelId)).map((model) => ({
		id: newId(),
		providerId,
		// A name collision would be rejected on save, so a name already in use by
		// some other provider's model gets the provider id appended rather than
		// failing a flow the user only clicked one button for.
		name: taken.has(model.name) ? `${model.name}-${providerId.slice(0, 4)}` : model.name,
		modelId: model.modelId,
	}));
	return { providers: catalog.providers, models: [...catalog.models, ...added] };
}

/** Role id → catalog model **id** for one agent and one tier, resolved through
 *  the catalog. Roles bind by id, so this is where the curated names stop
 *  travelling. */
function bindingsForTier(
	agent: CodingAgent,
	catalog: ModelCatalogView,
	tier: RecommendedTier,
): Record<string, string> | null {
	const roles = modelRolesForAgent(agent.baseCommand);
	if (roles.length === 0) return null;
	// Resolved by provider-native id under the provider that serves the
	// recommendations, never by catalog name: `seedCatalogModels` renames a
	// recommendation whose name is already taken, and a name lookup across the
	// whole catalog would then bind the role to a DIFFERENT provider's model that
	// happens to own the name — the silent wrong-model case this feature exists
	// to prevent.
	const providerId = recommendedProviderId(catalog);
	const nativeByName = new Map(RECOMMENDED_MODELS.map((model) => [model.name, model.modelId]));
	const byNative = new Map(
		catalog.models.filter((model) => model.providerId === providerId).map((model) => [model.modelId, model.id]),
	);
	const wanted = tierRoleNames(tier);
	const bindings: Record<string, string> = {};
	for (const role of roles) {
		const native = nativeByName.get(wanted[role.id] ?? "");
		const catalogId = native ? byNative.get(native) : undefined;
		if (catalogId) bindings[role.id] = catalogId;
	}
	// A partial binding sends the unbound roles to a proxy that cannot serve
	// them, which fails mid-session rather than at launch. All or nothing.
	return Object.keys(bindings).length === roles.length ? bindings : null;
}

/** The tier a seeded preset belongs to, or null when the preset is not one of
 *  ours. A preset seeded before tiers existed carries only the group label, and
 *  it is the practical tier by definition — that is the raster it had. */
export function tierOfPreset(config: AgentConfiguration): RecommendedTierId | null {
	if (config.seededTier) {
		return RECOMMENDED_TIERS.some((tier) => tier.id === config.seededTier)
			? (config.seededTier as RecommendedTierId)
			: null;
	}
	return config.groupLabel === SEEDED_GROUP_LABEL ? "practical" : null;
}

/**
 * One ready-to-run preset for one tier.
 *
 * Cloned from the agent's own default preset rather than written from scratch:
 * whatever args and permissions that CLI needs are already right there, and a
 * hand-built preset is how a launch ends up missing one of them. Only the model
 * and the name are replaced — that is the entire point.
 *
 * Null when the agent cannot be routed or the catalog does not carry every model
 * the tier needs.
 */
export function seedPresetForTier(
	agent: CodingAgent,
	catalog: ModelCatalogView,
	tier: RecommendedTier,
	newId: () => string,
): AgentConfiguration | null {
	const modelRoles = bindingsForTier(agent, catalog, tier);
	if (!modelRoles) return null;
	const base = agent.configurations.find((c) => c.id === agent.defaultConfigId) ?? agent.configurations[0];
	if (!base) return null;
	const { model: _model, requiresPxpipeProxy: _gated, ...rest } = base;
	// The launch slot is a Claude concept: only Claude Code has slots to choose
	// between, and its `model` is what picks one. Writing it onto a Codex preset
	// would leave a Claude id sitting on an agent that cannot serve it — harmless
	// while the preset is routed, and a broken launch the moment it is not.
	const launchModel = modelRoles[tier.launchSlot] ? tierLaunchModel(tier) : undefined;
	// Named after the tier, not after the preset it was cloned from: that name
	// carries the old model ("Auto (Opus 5, Medium)"), which is exactly what this
	// preset no longer uses. The mode label is derived from the fields anyway.
	return {
		...rest,
		id: newId(),
		name: tier.label,
		groupLabel: tier.label,
		...(launchModel ? { model: launchModel } : {}),
		modelRoles,
		seededTier: tier.id,
		seededRevision: RECOMMENDED_REVISION,
	};
}

/** Presets for every tier this agent does not have yet. Empty when the agent
 *  cannot be routed or is already fully seeded. */
export function seedPresetsForAgent(
	agent: CodingAgent,
	catalog: ModelCatalogView,
	newId: () => string,
): AgentConfiguration[] {
	const present = new Set(agent.configurations.map(tierOfPreset).filter(Boolean));
	const seeded: AgentConfiguration[] = [];
	for (const tier of RECOMMENDED_TIERS) {
		if (present.has(tier.id)) continue;
		const preset = seedPresetForTier(agent, catalog, tier, newId);
		if (preset) seeded.push(preset);
	}
	return seeded;
}

/** Every agent with its missing seeded presets appended, agents that cannot be
 *  routed returned untouched. The caller saves the whole list back. */
export function seedAgentPresets(agents: CodingAgent[], catalog: ModelCatalogView, newId: () => string): CodingAgent[] {
	return agents.map((agent) => {
		const presets = seedPresetsForAgent(agent, catalog, newId);
		return presets.length > 0 ? { ...agent, configurations: [...agent.configurations, ...presets] } : agent;
	});
}

// ---------------------------------------------------------------- update ---

/**
 * Keeping an already-seeded user current with a newer curated list.
 *
 * Never silently: a seeded preset is what their sessions run on, and swapping
 * the models under it changes both the bill and the quality of the work. dev3
 * computes what it WOULD change, shows both sides, and only writes on approval.
 * Declining is answered the same way accepting is — by stamping the revision, so
 * the same question is never asked twice.
 */

/** The provider the recommendations live under: the one already serving them,
 *  else any OpenRouter provider (the only kind the curated ids belong to).
 *  Null when the user has nothing that could serve them. */
function recommendedProviderId(catalog: ModelCatalogView): string | null {
	const ids = new Set(RECOMMENDED_MODELS.map((model) => model.modelId));
	const serving = catalog.models.find((model) => ids.has(model.modelId));
	if (serving) return serving.providerId;
	return catalog.providers.find((provider) => provider.kind === "openrouter")?.id ?? null;
}

/**
 * The catalog the current revision needs — today's catalog plus whatever models
 * this revision added. Pure: nothing is saved, and the caller shows the diff
 * before deciding. Null when no provider can serve them.
 */
export function catalogForCurrentRevision(catalog: ModelCatalogView, newId: () => string): ModelCatalogView | null {
	const providerId = recommendedProviderId(catalog);
	return providerId ? seedCatalogModels(catalog, providerId, newId) : null;
}

/** One role that would change, in the words the modal shows. */
export interface RoleChange {
	roleId: string;
	/** Catalog model name bound today, null when the role is unbound. */
	from: string | null;
	/** Catalog model name it would be bound to. */
	to: string;
}

/** One preset the current revision has something to say about. */
export interface PresetUpdate {
	agentId: string;
	agentName: string;
	configId: string;
	presetName: string;
	tierId: RecommendedTierId;
	/** Roles whose binding would actually change. For a tier the user does not
	 *  have yet, every role is a change with no `from`. */
	changes: RoleChange[];
	/** The full binding to write on approval, changed roles and all. */
	modelRoles: Record<string, string>;
	/** Set when this tier has no preset yet: approval APPENDS this one rather than
	 *  rebinding anything. A revision that introduces a tier has to be able to
	 *  hand it to a user who is already seeded, or they never see it. */
	newPreset?: AgentConfiguration;
}

/**
 * Seeded presets that are behind the current revision AND would genuinely end
 * up on different models, plus tiers this revision added that the user does not
 * have yet.
 *
 * `catalog` must be the one from `catalogForCurrentRevision` — the new models
 * are not in the saved catalog yet, and binding resolves through it.
 *
 * A preset the user re-bound by hand is still listed: its own bindings are what
 * `from` shows, so the modal says out loud what would be replaced instead of
 * quietly deciding for them.
 */
export function pendingPresetUpdates(
	agents: CodingAgent[],
	catalog: ModelCatalogView,
	newId: () => string = () => "",
): PresetUpdate[] {
	const nameById = new Map(catalog.models.map((model) => [model.id, model.name]));
	const updates: PresetUpdate[] = [];
	for (const agent of agents) {
		const seeded = agent.configurations
			.map((config) => ({ config, tierId: tierOfPreset(config) }))
			.filter((entry): entry is { config: AgentConfiguration; tierId: RecommendedTierId } => entry.tierId !== null);
		// Nothing was ever seeded here: this is not the surface that offers a first
		// preset, and inventing one behind an "update" prompt would be a surprise.
		if (seeded.length === 0) continue;
		const behind = seeded.filter((entry) => (entry.config.seededRevision ?? 0) < RECOMMENDED_REVISION);
		if (behind.length === 0) continue;

		for (const { config, tierId } of behind) {
			const tier = RECOMMENDED_TIERS.find((item) => item.id === tierId);
			const modelRoles = tier ? bindingsForTier(agent, catalog, tier) : null;
			if (!tier || !modelRoles) continue;
			const changes = roleChanges(modelRoles, config.modelRoles, nameById);
			if (changes.length === 0) continue;
			updates.push({
				agentId: agent.id,
				agentName: agent.name,
				configId: config.id,
				presetName: config.name,
				tierId,
				changes,
				modelRoles,
			});
		}

		const present = new Set(seeded.map((entry) => entry.tierId));
		for (const tier of RECOMMENDED_TIERS) {
			if (present.has(tier.id)) continue;
			const preset = seedPresetForTier(agent, catalog, tier, newId);
			if (!preset) continue;
			updates.push({
				agentId: agent.id,
				agentName: agent.name,
				configId: preset.id,
				presetName: preset.name,
				tierId: tier.id,
				changes: roleChanges(preset.modelRoles ?? {}, undefined, nameById),
				modelRoles: preset.modelRoles ?? {},
				newPreset: preset,
			});
		}
	}
	return updates;
}

/** Bindings the tier wants versus the bindings the preset has, in the words the
 *  modal shows. An unchanged role is not a change and is never listed. */
function roleChanges(
	wanted: Record<string, string>,
	current: Record<string, string> | undefined,
	nameById: Map<string, string>,
): RoleChange[] {
	const changes: RoleChange[] = [];
	for (const [roleId, catalogId] of Object.entries(wanted)) {
		const bound = current?.[roleId];
		if (bound === catalogId) continue;
		changes.push({
			roleId,
			from: bound ? nameById.get(bound) ?? null : null,
			to: nameById.get(catalogId) ?? catalogId,
		});
	}
	return changes;
}

/** The agents with those presets rebound and stamped with the revision, and any
 *  tier the user did not have yet appended. */
export function applyPresetUpdates(agents: CodingAgent[], updates: PresetUpdate[]): CodingAgent[] {
	const byConfig = new Map(updates.filter((update) => !update.newPreset).map((update) => [update.configId, update]));
	return agents.map((agent) => {
		const added = updates
			.filter((update) => update.agentId === agent.id && update.newPreset)
			.map((update) => update.newPreset as AgentConfiguration);
		return {
			...agent,
			configurations: [
				...agent.configurations.map((config) => {
					const update = byConfig.get(config.id);
					return update
						? {
							...config,
							model: launchModelForUpdate(update) ?? config.model,
							modelRoles: update.modelRoles,
							seededTier: update.tierId,
							seededRevision: RECOMMENDED_REVISION,
						}
						: config;
				}),
				...added,
			],
		};
	});
}

/** The launch model this update should stamp: the tier's, and only for a preset
 *  that has the slot it names. Undefined for a Codex preset (no slot to choose
 *  between) and for an unknown tier — an approved update must not blank out the
 *  model the preset launches with, nor invent a Claude id for a CLI that cannot
 *  serve one. */
function launchModelForUpdate(update: PresetUpdate): string | undefined {
	const tier = RECOMMENDED_TIERS.find((item) => item.id === update.tierId);
	if (!tier || !update.modelRoles[tier.launchSlot]) return undefined;
	return tierLaunchModel(tier);
}

/** Same presets, same models — only the revision moves. What declining writes:
 *  the user has now seen this revision, and the question is answered. */
export function markRevisionSeen(agents: CodingAgent[], updates: PresetUpdate[]): CodingAgent[] {
	// Every seeded preset of every agent the prompt spoke about — not just the
	// config ids in the updates. A tier the user does not have has no preset to
	// stamp, and a preset whose bindings happened not to change has no update of
	// its own; stamping only the listed ids would leave one of them behind the
	// revision, and the same declined question would come back tomorrow.
	const agentIds = new Set(updates.map((update) => update.agentId));
	return agents.map((agent) =>
		agentIds.has(agent.id)
			? {
				...agent,
				configurations: agent.configurations.map((config) =>
					tierOfPreset(config) ? { ...config, seededRevision: RECOMMENDED_REVISION } : config,
				),
			}
			: agent,
	);
}
