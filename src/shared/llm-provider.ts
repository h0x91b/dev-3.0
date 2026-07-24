/**
 * LLM provider (backend) registry for the Claude agent.
 *
 * dev3's built-in Claude configs select a model with `--model` using
 * Anthropic-API aliases (e.g. `claude-opus-4-8[1m]`). Third-party backends like
 * Amazon Bedrock reject those — they need provider-native model ids. When an
 * agent is set to a third-party provider, dev3:
 *   1. injects the provider's enable flag (e.g. CLAUDE_CODE_USE_BEDROCK) + the
 *      pinned ANTHROPIC_MODEL, and
 *   2. omits the `--model` flag (handled in agents.ts), so the model comes from
 *      ANTHROPIC_MODEL instead.
 *
 * dev3 does NOT manage credentials, region, AWS profile, or GCP project — the
 * customer configures those in their own global Claude Code setup (shell env or
 * ~/.claude/settings.json).
 *
 * The model id is derived from each provider's built-in alias→provider-id map
 * for known models; unknown/new models are derived from the alias so dev3
 * ALWAYS pins the model (never lets Claude Code pick its own default — that
 * would let the control plane and data plane diverge). The user can override
 * the id per model for region-specific inference-profile prefixes or ARNs.
 *
 * Adding a provider: append a `ProviderDefinition` to PROVIDER_REGISTRY (plus
 * its id in `LLM_PROVIDER` and i18n labels). No call site needs to special-case
 * it — the registry drives env injection, the settings UI, and the model table.
 *
 * This module is pure (no I/O) so it is fully unit-testable.
 */

import { LLM_PROVIDER, type BedrockGeo, type LlmProvider, type ProviderConfig } from "./types";

/** Strip dev3's `[1m]` 1M-context marker and any `@`-dated snapshot suffix to
 *  get the canonical Anthropic model family key (e.g. `claude-opus-4-8`). */
export function normalizeAlias(model: string): string {
	return model
		.trim()
		.replace(/\[1m\]$/i, "")
		.replace(/@.*$/, "")
		.trim();
}

/** Whether the model alias carried dev3's `[1m]` 1M-context marker. */
export function wantsLongContext(model: string): boolean {
	return /\[1m\]$/i.test(model.trim());
}

/** Non-family aliases dev3 uses in its configs → canonical Anthropic family key. */
const ALIAS_FAMILY: Record<string, string> = {
	sonnet: "claude-sonnet-4-6",
	opus: "claude-opus-5",
	haiku: "claude-haiku-4-5",
	"anthropic/claude-opus-4-6": "claude-opus-4-6",
	"anthropic/claude-sonnet-4-6": "claude-sonnet-4-6",
	"anthropic/claude-haiku-4-5": "claude-haiku-4-5",
};

/** Resolve a model alias to its canonical Anthropic family key. */
function resolveFamily(model: string): string {
	const normalized = normalizeAlias(model);
	return ALIAS_FAMILY[normalized] ?? ALIAS_FAMILY[model.trim()] ?? normalized;
}

/** Default cross-region inference-profile prefix when the user hasn't chosen one. */
export const DEFAULT_BEDROCK_GEO: BedrockGeo = "global";

/** The selectable Bedrock geo prefixes, for the settings toggle. */
export const BEDROCK_GEOS: BedrockGeo[] = ["global", "us", "eu", "apac"];

/**
 * Static description of a third-party LLM backend. Everything dev3 needs to
 * inject env, render the settings panel, and map models lives here — call sites
 * read the registry instead of branching on the provider id.
 */
export interface ProviderDefinition {
	/** Canonical provider id (matches an `LLM_PROVIDER` value). */
	id: LlmProvider;
	/**
	 * The agent this backend belongs to, identified by its base command's last
	 * segment (e.g. `"claude"`). The provider toggle only appears on agents whose
	 * `baseCommand` resolves to this, and only that agent's launches use it.
	 */
	agentCommand: string;
	/** i18n key for the human-readable provider name (the toggle button label). */
	labelKey: string;
	/** i18n key for the help text shown under the provider's settings. */
	hintKey: string;
	/** Env var dev3 sets to `"1"` to route the agent at this backend. */
	enableEnv: string;
	/** Whether this provider exposes the Bedrock-style geo (inference-profile) selector. */
	usesGeo: boolean;
	/**
	 * Map a canonical model family key to this provider's native model id.
	 * `geo` is supplied for geo-aware providers; ignore it otherwise.
	 */
	mapFamily(family: string, geo: BedrockGeo): string;
}

const BEDROCK_FAMILY_SUFFIX: Record<string, string> = {
	"claude-opus-5": "anthropic.claude-opus-5",
	"claude-opus-4-8": "anthropic.claude-opus-4-8",
	"claude-opus-4-7": "anthropic.claude-opus-4-7",
	"claude-opus-4-6": "anthropic.claude-opus-4-6",
	"claude-sonnet-4-6": "anthropic.claude-sonnet-4-6",
	"claude-haiku-4-5": "anthropic.claude-haiku-4-5",
};

/**
 * The third-party providers dev3 supports, keyed by id. The default Anthropic
 * API is intentionally absent — it injects nothing and uses `--model` as usual.
 */
export const PROVIDER_REGISTRY: Partial<Record<LlmProvider, ProviderDefinition>> = {
	[LLM_PROVIDER.Bedrock]: {
		id: LLM_PROVIDER.Bedrock,
		agentCommand: "claude",
		labelKey: "settings.providerBedrock",
		hintKey: "settings.providerBedrockHint",
		enableEnv: "CLAUDE_CODE_USE_BEDROCK",
		usesGeo: true,
		// Known families map to `<geo>.anthropic.<family>` inference profiles;
		// unknown/new families are derived from the alias (always pinned).
		mapFamily: (family, geo) => `${geo}.${BEDROCK_FAMILY_SUFFIX[family] ?? `anthropic.${family}`}`,
	},
};

/**
 * The "native" (default) backend each agent-with-backends falls back to when no
 * third-party provider is selected. Keyed by the agent's base-command segment;
 * the value is the i18n label key for the toggle's first button. The native
 * option injects nothing and uses `--model` as usual (provider id `anthropic`,
 * the LlmProvider default).
 */
const NATIVE_PROVIDER_LABEL: Record<string, string> = {
	claude: "settings.providerAnthropic",
};

/** Resolve a base command to its agent key (last path segment, e.g. `claude`). */
function agentKey(baseCommand: string): string {
	return baseCommand.split("/").pop() ?? baseCommand;
}

/** The third-party provider definitions registered for a given agent command. */
export function thirdPartyProvidersForAgent(baseCommand: string): ProviderDefinition[] {
	const key = agentKey(baseCommand);
	return Object.values(PROVIDER_REGISTRY)
		.filter((def): def is ProviderDefinition => def != null && def.agentCommand === key);
}

/**
 * The selectable provider options for an agent: the native (default) backend
 * first, then every registered third-party backend. Empty when the agent has no
 * registered backend — its launches always use the native API and no toggle is
 * shown. The native option's `id` is the `anthropic` default sentinel.
 */
export function providersForAgent(
	baseCommand: string,
): { id: LlmProvider; labelKey: string }[] {
	const third = thirdPartyProvidersForAgent(baseCommand);
	if (third.length === 0) return [];
	const nativeLabel = NATIVE_PROVIDER_LABEL[agentKey(baseCommand)] ?? "settings.providerNative";
	return [
		{ id: LLM_PROVIDER.Anthropic, labelKey: nativeLabel },
		...third.map((def) => ({ id: def.id, labelKey: def.labelKey })),
	];
}

/** Look up the registry entry for a provider id (undefined for the native default / unknown). */
export function getProviderDefinition(provider: LlmProvider | undefined): ProviderDefinition | undefined {
	return provider ? PROVIDER_REGISTRY[provider] : undefined;
}

/** True when the provider is a third-party backend (model comes from env, not --model). */
export function isThirdPartyProvider(provider: LlmProvider | undefined): boolean {
	return getProviderDefinition(provider) !== undefined;
}

/**
 * Resolve the provider-native model id for a dev3 config model alias.
 *
 * dev3 always pins the model on a third-party backend rather than letting Claude
 * Code fall back to its own default — otherwise the control plane (dev3) and the
 * data plane (the launched agent) could run different models. Known families use
 * the exact mapped id; unknown/new families are derived from the normalized
 * alias. Returns undefined for the Anthropic default or when no model is given.
 */
export function mapModelForProvider(
	model: string | undefined,
	provider: LlmProvider | undefined,
	geo: BedrockGeo = DEFAULT_BEDROCK_GEO,
): string | undefined {
	const def = getProviderDefinition(provider);
	if (!def || !model || !model.trim()) return undefined;
	const id = def.mapFamily(resolveFamily(model), geo);
	// Preserve dev3's 1M-context marker where the provider understands it.
	return wantsLongContext(model) ? `${id}[1m]` : id;
}

/**
 * Build the environment variables to inject for a Claude launch under the
 * selected provider. Returns an empty object for the Anthropic API (default) —
 * nothing to inject, and `--model` is passed as usual.
 *
 * `configModel` is the model alias of the config being launched, used to derive
 * the provider model id when the user hasn't set an explicit override.
 */
export function buildProviderEnv(
	provider: LlmProvider | undefined,
	providerConfig: ProviderConfig | undefined,
	configModel: string | undefined,
): Record<string, string> {
	const def = getProviderDefinition(provider);
	if (!def) return {};

	const env: Record<string, string> = {};

	// dev3 injects only the provider flag + the pinned model. Region, AWS profile,
	// and GCP project come from the customer's own global Claude Code config
	// (shell env / ~/.claude/settings.json) — dev3 does not manage credentials.
	env[def.enableEnv] = "1";
	// Always pin the model: a per-model manual override wins, else map/derive
	// from the launching config's alias (with the selected geo prefix). Only a
	// config with no model leaves it unset.
	const settings = providerConfig?.[def.id];
	const geo = settings?.geo ?? DEFAULT_BEDROCK_GEO;
	const model = resolveModelOverride(settings?.modelOverrides, configModel) || mapModelForProvider(configModel, def.id, geo);
	if (model) env.ANTHROPIC_MODEL = model;
	return env;
}

/** Look up a per-model manual override (keyed by the dev3 config model alias),
 *  trimming whitespace. Returns undefined when there's no non-empty override. */
function resolveModelOverride(
	overrides: Record<string, string> | undefined,
	configModel: string | undefined,
): string | undefined {
	if (!overrides || !configModel) return undefined;
	const value = overrides[configModel];
	return value?.trim() || undefined;
}

/**
 * The distinct Claude model aliases dev3 ships in its built-in configs, with the
 * default provider id each maps to. Drives the settings override table. The list
 * is derived from DEFAULT_AGENTS at call time so it never drifts from the configs.
 */
export function defaultModelMap(
	models: string[],
	provider: LlmProvider,
	geo: BedrockGeo = DEFAULT_BEDROCK_GEO,
): { model: string; defaultId: string }[] {
	const seen = new Set<string>();
	const rows: { model: string; defaultId: string }[] = [];
	for (const model of models) {
		if (!model || seen.has(model)) continue;
		seen.add(model);
		const defaultId = mapModelForProvider(model, provider, geo);
		if (defaultId) rows.push({ model, defaultId });
	}
	return rows;
}
