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

export interface RecommendedModel {
	/** Provider that serves it. Only providers dev3 can configure unattended. */
	providerKind: CatalogProviderKind;
	/** The provider-native id, exactly as it travels on the wire. */
	modelId: string;
	/** The catalog name dev3 gives it — also what the user sees in role pickers. */
	name: string;
	/** Human label for the Model list. */
	label: string;
	/** Which Claude Code slot it stands in for, and therefore which built-in
	 *  model it is priced against in the UI. */
	claudeRole: "fable" | "opus" | "sonnet" | "haiku";
	/** Which Codex slot it stands in for. Codex has three roles, Claude four, so
	 *  the two mappings are declared separately rather than derived. */
	codexRole?: "main" | "subagent" | "review";
	/** One short line on why this one. Shown under the model name. */
	blurbKey: string;
}

/**
 * The curated set. Order is the order they appear in the launcher.
 *
 * Chosen so that a user who connects and changes nothing gets a session that is
 * cheap AND competent: the model holding the plan is the one that matters, so
 * it gets a real model rather than the cheapest one available.
 */
/**
 * Bump this — in the same commit — whenever the list below changes in a way an
 * existing user should hear about: a model added, removed, or moved to another
 * role. A seeded preset remembers the revision it was built from, and a preset
 * behind the current one is what the "new models are out" prompt is looking for.
 *
 * Do NOT bump for a label, blurb, or price correction: nothing the user runs
 * changes, and the prompt is a promise that something did.
 */
export const RECOMMENDED_REVISION = 1;

export const RECOMMENDED_MODELS: RecommendedModel[] = [
	{
		providerKind: "openrouter",
		modelId: "qwen/qwen3.8-2.4t-a95b",
		name: "qwen3.8",
		label: "Qwen3.8 2.4T",
		claudeRole: "fable",
		blurbKey: "recommended.qwen38",
	},
	{
		providerKind: "openrouter",
		modelId: "deepseek/deepseek-v4-pro-0813",
		name: "ds-pro",
		label: "DeepSeek V4 Pro",
		claudeRole: "opus",
		codexRole: "main",
		blurbKey: "recommended.dsPro",
	},
	{
		providerKind: "openrouter",
		modelId: "deepseek/deepseek-v4-flash-0731",
		name: "ds-flash",
		label: "DeepSeek V4 Flash",
		claudeRole: "sonnet",
		codexRole: "subagent",
		blurbKey: "recommended.dsFlash",
	},
];

/** The built-in model each recommendation stands next to in the launcher, so
 *  the price comparison is against something the user already recognises. */
export const CLAUDE_ROLE_BUILTIN_MODEL: Record<RecommendedModel["claudeRole"], string> = {
	fable: "claude-fable-5",
	opus: "claude-opus-5",
	sonnet: "claude-sonnet-5",
	haiku: "claude-haiku-4-5",
};

/** Role bindings a freshly seeded Claude Code preset gets, keyed by role id.
 *  Haiku follows Sonnet: both are the "fast, does not have to be clever" slots,
 *  and leaving one unbound would send it to a model the proxy cannot serve. */
export function recommendedClaudeRoleModelIds(): Record<string, string> {
	const byRole: Record<string, string> = {};
	for (const model of RECOMMENDED_MODELS) byRole[model.claudeRole] = model.name;
	if (byRole.sonnet && !byRole.haiku) byRole.haiku = byRole.sonnet;
	return byRole;
}

/** Same for Codex. `review` follows `main`: review is the slot where being
 *  wrong is most expensive, so it never falls to the cheapest model. */
export function recommendedCodexRoleModelIds(): Record<string, string> {
	const byRole: Record<string, string> = {};
	for (const model of RECOMMENDED_MODELS) {
		if (model.codexRole) byRole[model.codexRole] = model.name;
	}
	if (byRole.main && !byRole.review) byRole.review = byRole.main;
	return byRole;
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

/** Group label the seeded presets carry, and the marker that says an agent has
 *  already been seeded. One constant so the picker, the seeder and the
 *  idempotency check cannot drift apart.
 *
 *  Not named after the licence: "open source" describes where the weights came
 *  from, which is not why anyone picks this. What it promises is the same job
 *  for a fraction of the money. */
export const SEEDED_GROUP_LABEL = "Best value";

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

/** Role id → catalog model **id** for one agent, resolved through the catalog.
 *  Roles bind by id, so this is where the curated names stop travelling. */
function bindingsForAgent(agent: CodingAgent, catalog: ModelCatalogView): Record<string, string> | null {
	const roles = modelRolesForAgent(agent.baseCommand);
	if (roles.length === 0) return null;
	const byName = new Map(catalog.models.map((m) => [m.name, m.id]));
	// Claude's role ids and Codex's are disjoint, so one merged map answers for
	// both and nothing here has to know which CLI it is looking at.
	const wanted = { ...recommendedClaudeRoleModelIds(), ...recommendedCodexRoleModelIds() };
	const bindings: Record<string, string> = {};
	for (const role of roles) {
		const catalogId = byName.get(wanted[role.id] ?? "");
		if (catalogId) bindings[role.id] = catalogId;
	}
	// A partial binding sends the unbound roles to a proxy that cannot serve
	// them, which fails mid-session rather than at launch. All or nothing.
	return Object.keys(bindings).length === roles.length ? bindings : null;
}

/**
 * The ready-to-run preset a freshly connected provider gives an agent.
 *
 * Cloned from the agent's own default preset rather than written from scratch:
 * whatever args and permissions that CLI needs are already right there, and a
 * hand-built preset is how a launch ends up missing one of them. Only the model
 * is replaced — that is the entire point.
 *
 * Null when the agent cannot be routed, is already seeded, or the catalog does
 * not carry every model its roles need.
 */
export function seedPresetForAgent(
	agent: CodingAgent,
	catalog: ModelCatalogView,
	newId: () => string,
): AgentConfiguration | null {
	if (agent.configurations.some((c) => c.groupLabel === SEEDED_GROUP_LABEL)) return null;
	const modelRoles = bindingsForAgent(agent, catalog);
	if (!modelRoles) return null;
	const base = agent.configurations.find((c) => c.id === agent.defaultConfigId) ?? agent.configurations[0];
	if (!base) return null;
	const { model: _model, requiresPxpipeProxy: _gated, ...rest } = base;
	// Named after the group, not after the preset it was cloned from: that name
	// carries the old model ("Auto (Opus 5, Medium)"), which is exactly what this
	// preset no longer uses. The mode label is derived from the fields anyway.
	return {
		...rest,
		id: newId(),
		name: SEEDED_GROUP_LABEL,
		groupLabel: SEEDED_GROUP_LABEL,
		modelRoles,
		seededRevision: RECOMMENDED_REVISION,
	};
}

/** Every agent with its seeded preset appended, agents that cannot be routed
 *  returned untouched. The caller saves the whole list back. */
export function seedAgentPresets(agents: CodingAgent[], catalog: ModelCatalogView, newId: () => string): CodingAgent[] {
	return agents.map((agent) => {
		const preset = seedPresetForAgent(agent, catalog, newId);
		return preset ? { ...agent, configurations: [...agent.configurations, preset] } : agent;
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
	/** Roles whose binding would actually change — never the unchanged ones. */
	changes: RoleChange[];
	/** The full binding to write on approval, changed roles and all. */
	modelRoles: Record<string, string>;
}

/**
 * Seeded presets that are behind the current revision AND would genuinely end
 * up on different models.
 *
 * `catalog` must be the one from `catalogForCurrentRevision` — the new models
 * are not in the saved catalog yet, and binding resolves through it.
 *
 * A preset the user re-bound by hand is still listed: its own bindings are what
 * `from` shows, so the modal says out loud what would be replaced instead of
 * quietly deciding for them.
 */
export function pendingPresetUpdates(agents: CodingAgent[], catalog: ModelCatalogView): PresetUpdate[] {
	const nameById = new Map(catalog.models.map((model) => [model.id, model.name]));
	const updates: PresetUpdate[] = [];
	for (const agent of agents) {
		for (const config of agent.configurations) {
			if (config.groupLabel !== SEEDED_GROUP_LABEL) continue;
			if ((config.seededRevision ?? 0) >= RECOMMENDED_REVISION) continue;
			const modelRoles = bindingsForAgent(agent, catalog);
			if (!modelRoles) continue;
			const changes: RoleChange[] = [];
			for (const [roleId, catalogId] of Object.entries(modelRoles)) {
				const current = config.modelRoles?.[roleId];
				if (current === catalogId) continue;
				changes.push({
					roleId,
					from: current ? nameById.get(current) ?? null : null,
					to: nameById.get(catalogId) ?? catalogId,
				});
			}
			if (changes.length === 0) continue;
			updates.push({
				agentId: agent.id,
				agentName: agent.name,
				configId: config.id,
				presetName: config.name,
				changes,
				modelRoles,
			});
		}
	}
	return updates;
}

/** The agents with those presets rebound and stamped with the revision. */
export function applyPresetUpdates(agents: CodingAgent[], updates: PresetUpdate[]): CodingAgent[] {
	const byConfig = new Map(updates.map((update) => [update.configId, update]));
	return agents.map((agent) => ({
		...agent,
		configurations: agent.configurations.map((config) => {
			const update = byConfig.get(config.id);
			return update
				? { ...config, modelRoles: update.modelRoles, seededRevision: RECOMMENDED_REVISION }
				: config;
		}),
	}));
}

/** Same presets, same models — only the revision moves. What declining writes:
 *  the user has now seen this revision, and the question is answered. */
export function markRevisionSeen(agents: CodingAgent[], updates: PresetUpdate[]): CodingAgent[] {
	const configIds = new Set(updates.map((update) => update.configId));
	return agents.map((agent) => ({
		...agent,
		configurations: agent.configurations.map((config) =>
			configIds.has(config.id) ? { ...config, seededRevision: RECOMMENDED_REVISION } : config,
		),
	}));
}
