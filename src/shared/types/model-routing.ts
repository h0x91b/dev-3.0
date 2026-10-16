/**
 * Live state of the optional local `pxpipe-proxy` (token-saving image proxy),
 * reported by the `pxpipeProxyStatus/Start/Stop` RPCs. The proxy renders bulky
 * LLM context into PNGs to cut input tokens; it is lossy and opt-in. All fields
 * are computed on demand — nothing is cached across calls.
 */
export interface PxpipeProxyStatus {
	/** The feature toggle in Global Settings. */
	enabled: boolean;
	/** `npx` resolvable on PATH (required to launch the proxy). */
	npxAvailable: boolean;
	npxPath?: string;
	/** The fixed proxy port (`PXPIPE_PROXY_PORT`). */
	port: number;
	/** Some process is LISTENing on the port. */
	portInUse: boolean;
	/** The listener is our managed proxy (our pidfile pid or a descendant). */
	running: boolean;
	/** We spawned it and its pid is alive, but it is not listening yet
	 *  (e.g. `npx` is still downloading the package on first run). */
	starting: boolean;
	/** The port is held by a process that is NOT our proxy — a real conflict. */
	foreignConflict: boolean;
	/** Pid + command name of whatever currently holds the port, if any. */
	holderPid?: number;
	holderName?: string;
	/** The proxy dashboard URL (served by the proxy on the same port). */
	dashboardUrl: string;
}

/**
 * Live state of the model-catalog proxy sidecar (AGENTS.md § Model routing
 * glossary). One process per app, on a dev3-chosen loopback port, started on
 * demand. Everything here is computed on demand — nothing is cached.
 */
export interface ModelSidecarStatus {
	/** The sidecar is up and answering its health endpoint. */
	running: boolean;
	/** A start is in flight (another launch is already waiting on it). */
	starting: boolean;
	port?: number;
	baseUrl?: string;
	/** The pinned binary shipped with this build was found on disk. */
	binaryAvailable: boolean;
	/** Pinned proxy version this build targets. */
	version: string;
	providerCount: number;
	modelCount: number;
	/** Why the last start failed, including the process's own last output. */
	lastError?: string;
}

/** Why a preset's role bindings cannot be launched right now. */
export interface ModelCatalogPreflight {
	ok: boolean;
	problems: {
		/** The role that cannot be served; empty when the proxy itself is the problem. */
		roleId: string;
		code: "missing-model" | "model-unreachable" | "proxy-unreachable";
		detail?: string;
	}[];
}

/** The catalog as the renderer sees it: never any credential, only whether one
 *  is stored for each provider. */
export interface ModelCatalogView {
	providers: {
		id: string;
		kind: "openai" | "anthropic" | "openrouter" | "custom";
		label: string;
		baseUrl?: string;
		/** Wire protocol of a `custom` endpoint; absent means OpenAI-shaped. */
		apiFormat?: "openai" | "anthropic";
		hasKey: boolean;
	}[];
	models: { id: string; providerId: string; name: string; modelId: string; extendedContext?: boolean }[];
}

/**
 * Canonical LLM backend ids. Use these consts instead of raw string literals so
 * the set of providers lives in one place. `anthropic` is the default (direct
 * API); every other value is a third-party backend described in the provider
 * registry (`src/shared/llm-provider.ts`). Adding a provider = adding an id here
 * + a registry entry + its i18n labels.
 */
export const LLM_PROVIDER = {
	/** The agent's own native backend (Anthropic API for Claude, OpenAI for
	 *  Codex). The stored value stays the historical `"anthropic"` — it is the
	 *  persisted default sentinel in users' settings, so renaming it would
	 *  silently reset existing setups. */
	Native: "anthropic",
	/** Amazon Bedrock as the backend for the Claude agent. The stored value
	 *  stays the historical `"bedrock"` — it is persisted in users' settings
	 *  (agent.llmProvider + providerConfig keys), so renaming it would silently
	 *  reset existing Bedrock setups. */
	BedrockClaude: "bedrock",
	/** Amazon Bedrock as the backend for the Codex agent. A separate id because
	 *  the registry pairs each id with one agent command. */
	BedrockCodex: "bedrock-codex",
} as const;

export type LlmProvider = (typeof LLM_PROVIDER)[keyof typeof LLM_PROVIDER];

/** Bedrock cross-region inference-profile prefix (the `<geo>.` part of the model id). */
export type BedrockGeo = "global" | "us" | "eu" | "jp";

/**
 * Per-provider connection settings. Generic across providers so a new backend
 * reuses the same shape — not every field applies to every provider (e.g. `geo`
 * is Bedrock-only). dev3 only owns the provider selection and the model-id
 * mapping. Credentials, region, and AWS profile are NOT configured here — the
 * customer sets those in their own global Claude Code setup (shell env or
 * ~/.claude/settings.json).
 */
export interface ProviderSettings {
	/**
	 * Cross-region inference-profile prefix baked into the mapped model ids
	 * (`global.` | `us.` | `eu.` | `jp.`). Bedrock-only. Changing it
	 * re-populates every non-overridden row of the model table. Defaults to
	 * "global". This is the id prefix only — NOT the AWS_REGION env (the
	 * customer's global Claude config owns credentials/region).
	 */
	geo?: BedrockGeo;
	/**
	 * Per-model id overrides, keyed by the dev3 config model alias (e.g.
	 * "claude-opus-4-8[1m]"). The value is the exact provider-native model id /
	 * inference-profile id / ARN to inject as ANTHROPIC_MODEL, replacing the
	 * built-in alias→provider-id mapping for that model. A key present here is a
	 * "manual" override; deleting it reverts the row to the mapped default.
	 */
	modelOverrides?: Record<string, string>;
}

/**
 * Per-provider settings keyed by provider id (e.g. `{ bedrock: { geo, … } }`).
 * Keyed by id so adding a provider needs no shape change here.
 */
export type ProviderConfig = Partial<Record<LlmProvider, ProviderSettings>>;
