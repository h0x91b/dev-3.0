/**
 * Model catalog and model roles — the pure core of dev3's multi-provider agent
 * routing (AGENTS.md § Model routing glossary).
 *
 * Two layers that never learn about each other:
 *   - the CATALOG knows providers, credentials and named models, and nothing
 *     about agents;
 *   - ROLES bind catalog models to the roles an agent CLI actually exposes, and
 *     know nothing about credentials.
 *
 * Everything here is pure: no fs, no network, no process. The sidecar's config
 * document, the launch env/args for each agent, validation and warnings are all
 * derived from plain state, so the whole feature is decidable in unit tests.
 *
 * Credentials NEVER appear in a generated document — the config references them
 * as `env.<NAME>` and the values reach the sidecar only through its child env.
 */

import { ENV_UNSET, claudeModelFamily } from "./agent-accounts";

// ---------------------------------------------------------------- catalog ---

/** The provider families dev3 ships a definition for. `custom` is any other
 *  OpenAI-compatible endpoint the user points at by base URL. */
export type CatalogProviderKind = "openai" | "anthropic" | "openrouter" | "custom";

export const CATALOG_PROVIDER_KINDS: CatalogProviderKind[] = ["openai", "anthropic", "openrouter", "custom"];

export interface CatalogProvider {
	id: string;
	kind: CatalogProviderKind;
	/** User-facing name. For a custom endpoint it also seeds the wire prefix. */
	label: string;
	/** Required for `custom`; ignored for the known kinds. */
	baseUrl?: string;
	/**
	 * Which wire protocol a `custom` endpoint speaks. Ignored for the known
	 * kinds, which speak their own. Defaults to `openai`, because that is what
	 * every custom provider was before this field existed — an absent value must
	 * keep meaning exactly what it meant on disk.
	 */
	apiFormat?: CustomApiFormat;
}

/** The request shapes dev3 can put in front of a custom endpoint. Both are
 *  proxied by the sidecar; the agent still only ever talks to the proxy. */
export type CustomApiFormat = "openai" | "anthropic";

export const CUSTOM_API_FORMATS: CustomApiFormat[] = ["openai", "anthropic"];

/** One named model: the user's own name bound to exactly one provider and one
 *  provider-native model id. The name is what travels on the wire. */
export interface CatalogModel {
	id: string;
	providerId: string;
	name: string;
	modelId: string;
}

export interface ModelCatalog {
	providers: CatalogProvider[];
	models: CatalogModel[];
}

export const EMPTY_MODEL_CATALOG: ModelCatalog = { providers: [], models: [] };

/** Names travel inside `provider/name`, so anything that would split or escape
 *  is rejected at entry rather than producing an unroutable request later. */
export function isValidCatalogModelName(name: string): boolean {
	return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name.trim());
}

function slugify(label: string): string {
	return label
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "") || "endpoint";
}

/**
 * The provider's key inside the sidecar's config, and the prefix of every wire
 * name it serves. A known kind uses its canonical provider name (so at most one
 * provider per kind — enforced by `validateCatalog`); a custom endpoint gets a
 * `custom-<slug>` name declared as an OpenAI-compatible custom provider.
 */
export function sidecarProviderKey(provider: CatalogProvider): string {
	return provider.kind === "custom" ? `custom-${slugify(provider.label)}` : provider.kind;
}

/**
 * A label no existing custom provider already resolves to.
 *
 * The label IS the identity of a custom endpoint — `sidecarProviderKey` slugifies
 * it — so two endpoints offered the same fixed label (both "Custom", both
 * "Ollama") collide and the second one cannot be saved at all. The host of the
 * endpoint is tried first because it says which box this is; a counter is the
 * fallback for two paths on one host.
 */
export function uniqueCustomProviderLabel(existing: CatalogProvider[], desired: string, baseUrl?: string): string {
	const taken = new Set(existing.filter((p) => p.kind === "custom").map((p) => slugify(p.label)));
	if (!taken.has(slugify(desired))) return desired;

	let host = "";
	try {
		host = baseUrl ? new URL(baseUrl).host : "";
	} catch {
		/* not a URL we can read a host out of */
	}
	if (host && !taken.has(slugify(`${desired} ${host}`))) return `${desired} (${host})`;

	for (let n = 2; ; n += 1) {
		const candidate = `${desired} ${n}`;
		if (!taken.has(slugify(candidate))) return candidate;
	}
}

function envSuffix(providerKey: string): string {
	return providerKey.toUpperCase().replace(/[^A-Z0-9]+/g, "_");
}

/** Env var carrying this provider's upstream key into the sidecar's process. */
export function providerKeyEnvName(providerKey: string): string {
	return `DEV3_LLM_KEY_${envSuffix(providerKey)}`;
}

/** Env var carrying a custom endpoint's base URL into the sidecar's process. */
export function providerBaseUrlEnvName(providerKey: string): string {
	return `DEV3_LLM_BASE_URL_${envSuffix(providerKey)}`;
}

/** Env var the sidecar reads its local session key from. */
export const SESSION_KEY_ENV = "DEV3_BIFROST_VIRTUAL_KEY";
/** Env var the sidecar reads its at-rest encryption key from. */
export const ENCRYPTION_KEY_ENV = "DEV3_BIFROST_ENCRYPTION_KEY";

/**
 * True when dev3's own generated config tells the sidecar this model's provider
 * cannot be listed (`allowed_requests.list_models: false` — a custom endpoint
 * speaking the Anthropic protocol, which declares no listing path).
 *
 * Such a model is absent from every listing by construction, so "it is not in
 * the list" says nothing about whether it can be served, and must never block a
 * launch.
 */
export function providerCannotListModels(catalog: ModelCatalog, catalogModelId: string): boolean {
	const model = catalog.models.find((m) => m.id === catalogModelId);
	const provider = catalog.providers.find((p) => p.id === model?.providerId);
	return provider?.kind === "custom" && provider.apiFormat === "anthropic";
}

/**
 * The provider-native id behind a wire name, or undefined when the string is not
 * one of ours.
 *
 * Cost is the reason this exists: a routed transcript records the wire name
 * (`openrouter/glm-5.2`), and the rate table keys off the provider's own slug
 * (`z-ai/glm-5.2`). Pricing the wire name means pricing a
 * user-chosen label — it matches only by luck.
 */
export function nativeModelIdForWireName(catalog: ModelCatalog, wireName: string): string | undefined {
	const slash = wireName.indexOf("/");
	if (slash === -1) return undefined;
	const providerKey = wireName.slice(0, slash);
	const name = wireName.slice(slash + 1);
	const provider = catalog.providers.find((p) => sidecarProviderKey(p) === providerKey);
	if (!provider) return undefined;
	return catalog.models.find((m) => m.providerId === provider.id && m.name === name)?.modelId;
}

/** How a catalog model is addressed on the wire: `<provider>/<name>`. */
export function catalogModelWireName(catalog: ModelCatalog, catalogModelId: string): string | undefined {
	const model = catalog.models.find((m) => m.id === catalogModelId);
	if (!model) return undefined;
	const provider = catalog.providers.find((p) => p.id === model.providerId);
	if (!provider) return undefined;
	return `${sidecarProviderKey(provider)}/${model.name}`;
}

// -------------------------------------------------------- sidecar config ---

interface SidecarProviderKey {
	id: string;
	name: string;
	value: string;
	models: string[];
	weight: number;
	aliases: Record<string, string>;
}

interface SidecarProvider {
	keys: SidecarProviderKey[];
	network_config?: Record<string, unknown> & { base_url?: string };
	custom_provider_config?: {
		base_provider_type: string;
		allowed_requests: Record<string, boolean>;
	};
}

export interface SidecarConfig {
	$schema: string;
	encryption_key: string;
	client: {
		drop_excess_requests: boolean;
		enable_logging: boolean;
		disable_content_logging: boolean;
		enforce_auth_on_inference: boolean;
		allowed_headers: string[];
		allow_direct_keys: boolean;
	};
	providers: Record<string, SidecarProvider>;
	governance: {
		virtual_keys: {
			id: string;
			name: string;
			value: string;
			is_active: boolean;
			provider_configs: { provider: string; allowed_models: string[]; key_ids: string[]; weight: number }[];
		}[];
	};
	config_store: SidecarStore;
	logs_store: SidecarStore;
}

/** The sidecar refuses to boot on `enabled: true` without a type and payload,
 *  and resolves a relative path against its own CWD — always absolute. */
interface SidecarStore {
	enabled: boolean;
	type?: "sqlite";
	config?: { path: string };
}

/** Conservative timeouts: coding agents stream for minutes and retry on their
 *  own, so the sidecar retries at most once. */
const NETWORK_CONFIG = {
	default_request_timeout_in_seconds: 300,
	stream_idle_timeout_in_seconds: 120,
	max_retries: 1,
	retry_backoff_initial: 500,
	retry_backoff_max: 5000,
};

/** The sidecar's whole configuration, from catalog state. A provider is declared
 *  as soon as it exists — naming models is what comes after asking it what it
 *  offers. Every credential stays a symbolic `env.*` reference. */
export function buildSidecarConfig(catalog: ModelCatalog, dataDir = "."): SidecarConfig {
	const providers: Record<string, SidecarProvider> = {};
	const providerConfigs: SidecarConfig["governance"]["virtual_keys"][0]["provider_configs"] = [];

	for (const provider of catalog.providers) {
		const models = catalog.models.filter((m) => m.providerId === provider.id);
		const providerKey = sidecarProviderKey(provider);
		const keyId = `key-dev3-${providerKey}`;
		const aliases: Record<string, string> = {};
		for (const model of models) aliases[model.name] = model.modelId;

		const entry: SidecarProvider = {
			keys: [
				{
					id: keyId,
					name: keyId,
					value: `env.${providerKeyEnvName(providerKey)}`,
					models: ["*"],
					weight: 1.0,
					aliases,
				},
			],
			network_config: { ...NETWORK_CONFIG },
		};

		if (provider.kind === "custom") {
			// The base URL is written literally: an `env.` reference is honoured for
			// key VALUES only, and the sidecar then dials the placeholder itself.
			entry.network_config = { base_url: provider.baseUrl ?? "", ...NETWORK_CONFIG };
			// Absent means the OpenAI shape: that is what every custom provider
			// saved before this field existed, and rereading one must not change
			// which protocol it speaks.
			const format: CustomApiFormat = provider.apiFormat ?? "openai";
			entry.custom_provider_config = {
				base_provider_type: format,
				// Partial `allowed_requests` means "everything not listed is denied",
				// so the Responses pair must be spelled out — Codex speaks nothing else.
				// The operation names do NOT change with the format: the sidecar's own
				// anthropic profile maps all four onto `/v1/messages`. It declares no
				// listing path there, so asking the endpoint what it offers is an
				// OpenAI-only affordance.
				allowed_requests: {
					list_models: format === "openai",
					chat_completion: true,
					chat_completion_stream: true,
					responses: true,
					responses_stream: true,
				},
			};
		}

		providers[providerKey] = entry;
		providerConfigs.push({ provider: providerKey, allowed_models: ["*"], key_ids: [keyId], weight: 1.0 });
	}

	return {
		$schema: "https://www.getbifrost.ai/schema",
		encryption_key: `env.${ENCRYPTION_KEY_ENV}`,
		client: {
			drop_excess_requests: false,
			// Metadata-only: token counts feed per-task cost, bodies are never stored.
			enable_logging: true,
			disable_content_logging: true,
			enforce_auth_on_inference: true,
			allowed_headers: ["*"],
			allow_direct_keys: false,
		},
		providers,
		governance: {
			virtual_keys: [
				{
					id: "vk-dev3-session",
					name: "dev3 local session",
					value: `env.${SESSION_KEY_ENV}`,
					is_active: true,
					provider_configs: providerConfigs,
				},
			],
		},
		// Both stores are on because governance refuses to boot without a config
		// store, and the log store is what makes a task's spend answerable. Content
		// logging stays off, so no prompt or code is ever written to them.
		config_store: { enabled: true, type: "sqlite", config: { path: `${dataDir}/config.db` } },
		logs_store: { enabled: true, type: "sqlite", config: { path: `${dataDir}/logs.db` } },
	};
}

// ------------------------------------------------------------------ roles ---

export interface AgentModelRole {
	id: string;
	labelKey: string;
	hintKey: string;
}

/** Claude Code's own alias slots, most capable first. */
const CLAUDE_ROLES: AgentModelRole[] = [
	{ id: "fable", labelKey: "catalog.roleFable", hintKey: "catalog.roleFableHint" },
	{ id: "opus", labelKey: "catalog.roleOpus", hintKey: "catalog.roleOpusHint" },
	{ id: "sonnet", labelKey: "catalog.roleSonnet", hintKey: "catalog.roleSonnetHint" },
	{ id: "haiku", labelKey: "catalog.roleHaiku", hintKey: "catalog.roleHaikuHint" },
];

/** Codex CLI's own roles. `main` is load-bearing: without it there is nothing
 *  to route, so dev3 leaves the launch untouched. */
const CODEX_ROLES: AgentModelRole[] = [
	{ id: "main", labelKey: "catalog.roleMain", hintKey: "catalog.roleMainHint" },
	{ id: "subagent", labelKey: "catalog.roleSubagent", hintKey: "catalog.roleSubagentHint" },
	{ id: "review", labelKey: "catalog.roleReview", hintKey: "catalog.roleReviewHint" },
];

const AGENT_ROLES: Record<string, AgentModelRole[]> = {
	claude: CLAUDE_ROLES,
	codex: CODEX_ROLES,
};

function agentKey(baseCommand: string): string {
	return baseCommand.split("/").pop() ?? baseCommand;
}

/** The roles the given agent CLI genuinely exposes; empty when dev3 cannot
 *  route that agent through the catalog. */
export function modelRolesForAgent(baseCommand: string): AgentModelRole[] {
	return AGENT_ROLES[agentKey(baseCommand)] ?? [];
}

/** Role id → catalog model id. Bound by id, so renaming a model keeps presets working. */
export type ModelRoleBindings = Record<string, string>;

export interface RoleLaunchPlan {
	/** Env vars to inject into the launch. */
	env: Record<string, string>;
	/** Raw (unescaped) CLI args to append; the agent adapter escapes them. */
	args: string[];
	/** Wire name that must replace the preset's `--model`, when the CLI gives the
	 *  flag precedence over everything else. */
	modelFlag?: string;
	/** Env vars to actively clear, so a leaked credential cannot win. */
	unsetEnv: string[];
}

/** The `model_providers` entry dev3 declares for Codex. */
export const CODEX_PROVIDER_KEY = "dev3";

/**
 * Turn a preset's role bindings into everything a launch needs. Returns
 * undefined — "launch exactly as dev3 does today" — when the agent has no roles
 * or nothing is bound. `presetModel` is the preset's own model, used to decide
 * which bound role the rewritten `--model` should name.
 */
export function resolveModelRoleLaunch(
	baseCommand: string,
	bindings: ModelRoleBindings | undefined,
	catalog: ModelCatalog,
	runtime: { baseUrl: string; sessionKey: string },
	presetModel?: string,
): RoleLaunchPlan | undefined {
	const roles = modelRolesForAgent(baseCommand);
	if (roles.length === 0 || !bindings) return undefined;

	const wire: Record<string, string> = {};
	for (const role of roles) {
		const bound = bindings[role.id];
		if (!bound) continue;
		const name = catalogModelWireName(catalog, bound);
		// A dangling binding is a broken setup, not a partial one: routing half a
		// preset would silently bill the wrong provider.
		if (!name) return undefined;
		wire[role.id] = name;
	}
	if (Object.keys(wire).length === 0) return undefined;

	return agentKey(baseCommand) === "codex"
		? codexPlan(wire, runtime)
		: claudePlan(wire, runtime, presetModel, catalogDisplay(catalog, bindings));
}

/** What a routed slot should be called in the agent's own model picker: the
 *  user's name for the model, and who serves which provider-native id behind it.
 *  Without this the picker lists the raw wire name against `Custom Opus model`,
 *  which says neither what the model is nor where it comes from. */
function catalogDisplay(catalog: ModelCatalog, bindings: ModelRoleBindings): Record<string, { name: string; description: string }> {
	const display: Record<string, { name: string; description: string }> = {};
	for (const [roleId, catalogModelId] of Object.entries(bindings)) {
		const model = catalog.models.find((m) => m.id === catalogModelId);
		const provider = catalog.providers.find((p) => p.id === model?.providerId);
		if (!model || !provider) continue;
		display[roleId] = { name: model.name, description: `${provider.label} · ${model.modelId}` };
	}
	return display;
}

/** Order the launch falls back through when the preset names no model of its
 *  own: the workhorse first, the premium slot only if nothing else is bound.
 *  Deliberately NOT the display order — starting a session on the most expensive
 *  bound slot bills premium rates for an ordinary turn, and the premium slot is
 *  one `/model` away anyway. A preset that wants to start high says so through
 *  its own `model`. */
const CLAUDE_LAUNCH_FALLBACK: string[] = ["opus", "sonnet", "fable", "haiku"];

/** Which bound slot the launch's own `--model` should name: the slot the preset
 *  already meant, else the workhorse. Never a Claude id — that is the silent
 *  wrong-model case. */
function claudeLaunchSlot(wire: Record<string, string>, presetModel: string | undefined): string | undefined {
	const meant = presetModel ? claudeModelFamily(presetModel) : null;
	if (meant && wire[meant]) return wire[meant];
	const fallback = CLAUDE_LAUNCH_FALLBACK.find((role) => wire[role]);
	return fallback ? wire[fallback] : undefined;
}

function claudePlan(
	wire: Record<string, string>,
	runtime: { baseUrl: string; sessionKey: string },
	presetModel: string | undefined,
	display: Record<string, { name: string; description: string }>,
): RoleLaunchPlan {
	const env: Record<string, string> = {
		ANTHROPIC_BASE_URL: `${runtime.baseUrl}/anthropic`,
		ANTHROPIC_AUTH_TOKEN: runtime.sessionKey,
	};
	// Every slot gets a name, not just the bound ones: the base URL is redirected
	// for the whole session, so an unbound slot would keep its Claude id and ask
	// the proxy for a model no provider serves. Claude Code uses the haiku slot
	// for titles and background work, so that failure lands mid-session rather
	// than at launch. The stand-in is the model the launch itself names — same
	// choice codexPlan makes with `main`, and it can cost more than the tier the
	// slot implies.
	const standIn = claudeLaunchSlot(wire, presetModel);
	const staleDisplay: string[] = [];
	for (const role of CLAUDE_ROLES) {
		const name = wire[role.id] ?? standIn;
		if (!name) continue;
		const prefix = `ANTHROPIC_DEFAULT_${role.id.toUpperCase()}_MODEL`;
		env[prefix] = name;
		// Claude Code honours `_NAME`/`_DESCRIPTION` for a pinned slot when the base
		// URL is a gateway — unlike `_SUPPORTED_CAPABILITIES`, which is Bedrock /
		// Vertex / Foundry only.
		const shown = display[role.id];
		if (!shown) {
			// A slot dev3 does not name must not inherit a name from whatever ran
			// before it — that would label this model as a different one.
			staleDisplay.push(`${prefix}_NAME`, `${prefix}_DESCRIPTION`);
			continue;
		}
		env[`${prefix}_NAME`] = shown.name;
		env[`${prefix}_DESCRIPTION`] = shown.description;
	}
	// The flag outranks every one of these vars, so it must name a catalog model
	// too — otherwise the session asks the sidecar for a Claude id it cannot serve.
	return {
		env,
		args: [],
		modelFlag: standIn,
		unsetEnv: ["ANTHROPIC_API_KEY", "ANTHROPIC_MODEL", ...staleDisplay],
	};
}

function codexPlan(wire: Record<string, string>, runtime: { baseUrl: string; sessionKey: string }): RoleLaunchPlan | undefined {
	if (!wire.main) return undefined;
	const p = `model_providers.${CODEX_PROVIDER_KEY}`;
	const args = [
		"-c", `model_provider="${CODEX_PROVIDER_KEY}"`,
		"-c", `${p}.name="dev3 model catalog"`,
		// Codex talks to a custom provider over the Responses protocol only, and
		// its WebSocket mode is not what the sidecar exposes.
		"-c", `${p}.wire_api="responses"`,
		"-c", `${p}.supports_websockets=false`,
		"-c", `${p}.base_url="${runtime.baseUrl}/openai/v1"`,
		"-c", `${p}.env_key="OPENAI_API_KEY"`,
		"-c", `model="${wire.main}"`,
	];
	// An unbound slot would keep Codex's own default slug, and the whole session
	// is already pinned to our provider — that slug reaches a proxy that cannot
	// serve it. Main is the honest stand-in.
	args.push("-c", `agents.default_subagent_model="${wire.subagent ?? wire.main}"`);
	args.push("-c", `review_model="${wire.review ?? wire.main}"`);

	return {
		env: { OPENAI_API_KEY: runtime.sessionKey },
		args,
		modelFlag: wire.main,
		unsetEnv: [],
	};
}

// ----------------------------------------------------- codex model catalog ---

/**
 * Codex knows nothing about a routed model, so it falls back to placeholder
 * metadata: a 272k ceiling, no apply_patch, no parallel tool calls, and a
 * warning on every launch. `model_catalog_json` fixes that — but it REPLACES
 * Codex's built-in catalog rather than extending it, so the generated document
 * has to carry the built-ins forward as well.
 */
export interface CodexModelCatalog {
	models: Record<string, unknown>[];
}

/** What every catalog model claims. dev3 cannot know a third-party model's real
 *  window, and a million is what the current generation advertises; the number
 *  only drives Codex's compaction, never billing. */
export const CATALOG_MODEL_CONTEXT_WINDOW = 1_000_000;

/** The built-in entry a routed model is cloned from — the most capable listed
 *  model that carries no multi-agent or code-mode machinery, which a
 *  third-party model would not be able to serve. */
function codexTemplateEntry(builtin: CodexModelCatalog): Record<string, unknown> | undefined {
	const listed = builtin.models.filter((m) => m.visibility === "list");
	const plain = listed.filter((m) => m.tool_mode === undefined && m.multi_agent_version === undefined);
	const pool = plain.length > 0 ? plain : listed.length > 0 ? listed : builtin.models;
	return [...pool].sort((a, b) => Number(a.priority ?? 0) - Number(b.priority ?? 0))[0];
}

/** Clone that template once per catalog model, then keep every built-in. */
export function buildCodexModelCatalog(builtin: CodexModelCatalog, catalog: ModelCatalog): CodexModelCatalog | undefined {
	const template = codexTemplateEntry(builtin);
	if (!template) return undefined;

	const routed = catalog.models.flatMap((model) => {
		const slug = catalogModelWireName(catalog, model.id);
		const provider = catalog.providers.find((p) => p.id === model.providerId);
		if (!slug || !provider) return [];
		return [
			{
				...template,
				slug,
				display_name: model.name,
				description: `Served by ${provider.label} through the dev3 model catalog.`,
				// Ours first: in a routed session every built-in is unreachable.
				priority: 0,
				visibility: "list",
				context_window: CATALOG_MODEL_CONTEXT_WINDOW,
				max_context_window: CATALOG_MODEL_CONTEXT_WINDOW,
				// OpenAI's own billing tiers and hosted search tool mean nothing to
				// another provider, and asking for either is a rejected request.
				additional_speed_tiers: [],
				service_tiers: [],
				supports_search_tool: false,
			},
		];
	});
	if (routed.length === 0) return undefined;

	return { models: [...routed, ...builtin.models] };
}

/** The launch arg that hands Codex a generated catalog. */
export function codexModelCatalogArgs(path: string): string[] {
	return ["-c", `model_catalog_json="${path}"`];
}

/** Env record form of `unsetEnv`, for the launch env pipeline that speaks in
 *  `ENV_UNSET` sentinels rather than a separate list. */
export function roleUnsetEnv(plan: RoleLaunchPlan): Record<string, string> {
	const env: Record<string, string> = {};
	for (const key of plan.unsetEnv) env[key] = ENV_UNSET;
	return env;
}

// ------------------------------------------------------------ validation ---

export type CatalogIssueCode =
	| "incomplete"
	| "duplicate-name"
	| "invalid-name"
	| "unknown-provider"
	| "missing-model-id"
	| "missing-base-url"
	| "duplicate-provider";

export interface CatalogIssue {
	code: CatalogIssueCode;
	/** The catalog model the issue is about, when it is about one. */
	modelId?: string;
	/** The provider the issue is about, when it is about one. */
	providerId?: string;
}

/** Every reason this catalog cannot be turned into a working sidecar config. */
export function validateCatalog(catalog: ModelCatalog): CatalogIssue[] {
	const issues: CatalogIssue[] = [];

	const seenKinds = new Set<string>();
	for (const provider of catalog.providers) {
		if (provider.kind === "custom") {
			if (!provider.baseUrl?.trim()) issues.push({ code: "missing-base-url", providerId: provider.id });
		}
		const key = sidecarProviderKey(provider);
		if (seenKinds.has(key)) issues.push({ code: "duplicate-provider", providerId: provider.id });
		seenKinds.add(key);
	}

	const seenNames = new Set<string>();
	for (const model of catalog.models) {
		const name = model.name.trim().toLowerCase();
		// A row the user has just added and not filled in yet is unfinished, not
		// malformed — saying "invalid characters" about an empty field is a lie.
		if (!model.name.trim()) issues.push({ code: "incomplete", modelId: model.id });
		else if (!isValidCatalogModelName(model.name)) issues.push({ code: "invalid-name", modelId: model.id });
		else if (seenNames.has(name)) issues.push({ code: "duplicate-name", modelId: model.id });
		if (name) seenNames.add(name);
		if (!model.modelId.trim() && model.name.trim()) issues.push({ code: "missing-model-id", modelId: model.id });
		if (!catalog.providers.some((p) => p.id === model.providerId)) {
			issues.push({ code: "unknown-provider", modelId: model.id });
		}
	}

	return issues;
}

/** Role ids whose catalog model no longer exists. */
export function orphanedRoleBindings(bindings: ModelRoleBindings | undefined, catalog: ModelCatalog): string[] {
	if (!bindings) return [];
	return Object.entries(bindings)
		.filter(([, modelId]) => modelId && !catalog.models.some((m) => m.id === modelId))
		.map(([role]) => role);
}

