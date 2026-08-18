import { describe, expect, it } from "vitest";
import {
	CATALOG_MODEL_CONTEXT_WINDOW,
	CODEX_PROVIDER_KEY,
	buildCodexModelCatalog,
	buildSidecarConfig,
	catalogModelWireName,
	isValidCatalogModelName,
	modelRolesForAgent,
	nativeModelIdForWireName,
	orphanedRoleBindings,
	providerKeyEnvName,
	resolveModelRoleLaunch,
	sidecarProviderKey,
	uniqueCustomProviderLabel,
	validateCatalog,
	type ModelCatalog,
} from "../../shared/model-catalog";

/** A catalog with one key per provider kind the UI can offer. */
function catalog(): ModelCatalog {
	return {
		providers: [
			{ id: "p-oai", kind: "openai", label: "OpenAI" },
			{ id: "p-or", kind: "openrouter", label: "OpenRouter" },
			{ id: "p-custom", kind: "custom", label: "My Box", baseUrl: "https://llm.example.com/v1" },
		],
		models: [
			{ id: "m-fast", providerId: "p-or", name: "fast-gremlin", modelId: "deepseek/deepseek-flash" },
			{ id: "m-main", providerId: "p-oai", name: "my-main", modelId: "gpt-5.6-sol" },
			{ id: "m-local", providerId: "p-custom", name: "local", modelId: "qwen3" },
		],
	};
}

const RUNTIME = { baseUrl: "http://127.0.0.1:41234", sessionKey: "sk-bf-secret" };

describe("provider keys", () => {
	it("names a known provider after its kind so the wire name is predictable", () => {
		expect(sidecarProviderKey({ id: "p-oai", kind: "openai", label: "Whatever" })).toBe("openai");
		expect(sidecarProviderKey({ id: "p-or", kind: "openrouter", label: "OR" })).toBe("openrouter");
	});

	it("derives a custom endpoint's key from its label, slugified and prefixed", () => {
		expect(sidecarProviderKey({ id: "p1", kind: "custom", label: "My Box 2" })).toBe("custom-my-box-2");
	});

	it("gives each provider its own credential env var", () => {
		expect(providerKeyEnvName("openrouter")).toBe("DEV3_LLM_KEY_OPENROUTER");
		expect(providerKeyEnvName("custom-my-box")).toBe("DEV3_LLM_KEY_CUSTOM_MY_BOX");
	});
});

describe("wire names", () => {
	it("addresses a catalog model as provider/name", () => {
		expect(catalogModelWireName(catalog(), "m-fast")).toBe("openrouter/fast-gremlin");
		expect(catalogModelWireName(catalog(), "m-local")).toBe("custom-my-box/local");
	});

	it("has no wire name for a model that is gone", () => {
		expect(catalogModelWireName(catalog(), "m-deleted")).toBeUndefined();
	});

	it("reads a wire name back to the provider's own model id, so cost can be priced", () => {
		expect(nativeModelIdForWireName(catalog(), "openrouter/fast-gremlin")).toBe("deepseek/deepseek-flash");
		expect(nativeModelIdForWireName(catalog(), "custom-my-box/local")).toBe("qwen3");
	});

	it("does not claim a model string that is not one of ours", () => {
		expect(nativeModelIdForWireName(catalog(), "claude-opus-5")).toBeUndefined();
		expect(nativeModelIdForWireName(catalog(), "openrouter/never-added")).toBeUndefined();
		expect(nativeModelIdForWireName(catalog(), "nosuchprovider/fast-gremlin")).toBeUndefined();
	});
});

describe("uniqueCustomProviderLabel", () => {
	const boxes = (...labels: string[]) => labels.map((label, i) => ({ id: `p${i}`, kind: "custom" as const, label }));

	it("keeps the label when nothing else answers to it", () => {
		expect(uniqueCustomProviderLabel([], "Ollama", "http://localhost:11434/v1")).toBe("Ollama");
	});

	it("names the second endpoint after its host, so both can exist", () => {
		const label = uniqueCustomProviderLabel(boxes("Custom"), "Custom", "https://b.example.com/v1");
		expect(label).toBe("Custom (b.example.com)");
		expect(sidecarProviderKey({ id: "p9", kind: "custom", label })).not.toBe("custom-custom");
	});

	it("counts up when two endpoints share one host", () => {
		const existing = boxes("Custom", "Custom (b.example.com)");
		expect(uniqueCustomProviderLabel(existing, "Custom", "https://b.example.com/other")).toBe("Custom 2");
	});

	it("ignores a known-kind provider's label — only custom endpoints collide", () => {
		const existing = [{ id: "p0", kind: "openrouter" as const, label: "Ollama" }];
		expect(uniqueCustomProviderLabel(existing, "Ollama", "http://localhost:11434/v1")).toBe("Ollama");
	});
});

describe("buildSidecarConfig", () => {
	it("declares one provider block per configured provider, with the key referenced symbolically", () => {
		const config = buildSidecarConfig(catalog());
		expect(Object.keys(config.providers).sort()).toEqual(["custom-my-box", "openai", "openrouter"]);
		expect(config.providers.openrouter.keys[0].value).toBe("env.DEV3_LLM_KEY_OPENROUTER");
	});

	it("never writes a credential value into the document", () => {
		const serialized = JSON.stringify(buildSidecarConfig(catalog()));
		expect(serialized).not.toContain("sk-");
		expect(serialized.match(/"value":\s*"(?!env\.)/)).toBeNull();
	});

	it("turns each catalog model into an alias on its provider's key", () => {
		const config = buildSidecarConfig(catalog());
		expect(config.providers.openrouter.keys[0].aliases).toEqual({ "fast-gremlin": "deepseek/deepseek-flash" });
		expect(config.providers.openai.keys[0].aliases).toEqual({ "my-main": "gpt-5.6-sol" });
	});

	// Verified against the live bifrost-http 1.6.10: a provider with no aliases
	// starts fine and still answers /v1/models. Declaring it is what makes
	// "add a provider, then ask it what it offers" possible at all.
	it("declares a provider that has no models yet, so its ids can be listed", () => {
		const only = catalog();
		only.models = only.models.filter((m) => m.providerId === "p-oai");
		expect(Object.keys(buildSidecarConfig(only).providers).sort()).toEqual(["custom-my-box", "openai", "openrouter"]);
		expect(buildSidecarConfig(only).providers.openrouter.keys[0].aliases).toEqual({});
	});

	it("produces no providers at all for an empty catalog", () => {
		expect(buildSidecarConfig({ providers: [], models: [] }).providers).toEqual({});
	});

	it("describes a custom endpoint as an OpenAI-compatible provider with its own base URL", () => {
		const config = buildSidecarConfig(catalog());
		const custom = config.providers["custom-my-box"];
		expect(custom.custom_provider_config?.base_provider_type).toBe("openai");
		expect(custom.network_config?.base_url).toBe("https://llm.example.com/v1");
	});

	it("still reads a provider saved before the format field existed as OpenAI-shaped", () => {
		// Every custom provider already on disk has no apiFormat. Reading one must
		// not quietly move it onto a protocol its endpoint does not speak.
		const stored = catalog();
		expect(stored.providers.find((p) => p.kind === "custom")?.apiFormat).toBeUndefined();
		expect(
			buildSidecarConfig(stored).providers["custom-my-box"].custom_provider_config?.base_provider_type,
		).toBe("openai");
	});

	it("declares an Anthropic-shaped endpoint under the same operation names, which the sidecar maps to /v1/messages", () => {
		const base = catalog();
		const anthropic = {
			...base,
			providers: base.providers.map((p) => (p.kind === "custom" ? { ...p, apiFormat: "anthropic" as const } : p)),
		};
		const custom = buildSidecarConfig(anthropic).providers["custom-my-box"];
		expect(custom.custom_provider_config?.base_provider_type).toBe("anthropic");
		// The operations keep their OpenAI names — renaming them to a Messages-ish
		// key denies every request, because unlisted means denied.
		expect(custom.custom_provider_config?.allowed_requests.chat_completion).toBe(true);
		expect(custom.custom_provider_config?.allowed_requests.responses).toBe(true);
	});

	it("does not claim an Anthropic endpoint can list its models, because that profile declares no listing path", () => {
		const base = catalog();
		const anthropic = {
			...base,
			providers: base.providers.map((p) => (p.kind === "custom" ? { ...p, apiFormat: "anthropic" as const } : p)),
		};
		expect(
			buildSidecarConfig(anthropic).providers["custom-my-box"].custom_provider_config?.allowed_requests.list_models,
		).toBe(false);
		expect(
			buildSidecarConfig(base).providers["custom-my-box"].custom_provider_config?.allowed_requests.list_models,
		).toBe(true);
	});

	it("allows the Responses protocol on a custom endpoint, because Codex speaks nothing else", () => {
		const allowed = buildSidecarConfig(catalog()).providers["custom-my-box"].custom_provider_config?.allowed_requests;
		expect(allowed?.responses).toBe(true);
		expect(allowed?.responses_stream).toBe(true);
	});

	it("gates every provider behind one local session key", () => {
		const config = buildSidecarConfig(catalog());
		expect(config.client.enforce_auth_on_inference).toBe(true);
		expect(config.client.allow_direct_keys).toBe(false);
		const vk = config.governance.virtual_keys[0];
		expect(vk.value).toBe("env.DEV3_BIFROST_VIRTUAL_KEY");
		expect(vk.provider_configs.map((p) => p.provider).sort()).toEqual(["custom-my-box", "openai", "openrouter"]);
	});

	it("gives both stores an absolute home, since the sidecar resolves paths against its own CWD", () => {
		const config = buildSidecarConfig(catalog(), "/data/dev3");
		expect(config.config_store.config?.path).toBe("/data/dev3/config.db");
		expect(config.logs_store.config?.path).toBe("/data/dev3/logs.db");
	});

	it("declares a store type, without which the sidecar refuses to boot", () => {
		const config = buildSidecarConfig(catalog());
		expect(config.config_store).toMatchObject({ enabled: true, type: "sqlite" });
	});

	it("records token counts but never request bodies", () => {
		const config = buildSidecarConfig(catalog());
		expect(config.logs_store.enabled).toBe(true);
		expect(config.client.enable_logging).toBe(true);
		expect(config.client.disable_content_logging).toBe(true);
	});
});

describe("modelRolesForAgent", () => {
	it("offers Claude Code its own alias slots", () => {
		expect(modelRolesForAgent("claude").map((r) => r.id)).toEqual(["fable", "opus", "sonnet", "haiku"]);
	});

	it("offers Codex the roles Codex actually has", () => {
		expect(modelRolesForAgent("codex").map((r) => r.id)).toEqual(["main", "subagent", "review"]);
	});

	it("resolves an absolute binary path to its agent", () => {
		expect(modelRolesForAgent("/opt/homebrew/bin/claude").map((r) => r.id)).toContain("opus");
	});

	it("has no roles for an agent dev3 cannot route", () => {
		expect(modelRolesForAgent("gemini")).toEqual([]);
	});
});

describe("resolveModelRoleLaunch — Claude Code", () => {
	const bindings = { opus: "m-main", sonnet: "m-fast" };

	it("points Claude at the sidecar's Anthropic surface with the session key", () => {
		const plan = resolveModelRoleLaunch("claude", bindings, catalog(), RUNTIME);
		expect(plan?.env.ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:41234/anthropic");
		expect(plan?.env.ANTHROPIC_AUTH_TOKEN).toBe("sk-bf-secret");
	});

	it("denies Claude Code the 1M-context window no routed model promises", () => {
		const plan = resolveModelRoleLaunch("claude", bindings, catalog(), RUNTIME);
		expect(plan?.env.CLAUDE_CODE_DISABLE_1M_CONTEXT).toBe("1");
	});

	it("clears an inherited Anthropic API key so a stale credential cannot win", () => {
		const plan = resolveModelRoleLaunch("claude", bindings, catalog(), RUNTIME);
		expect(plan?.unsetEnv).toContain("ANTHROPIC_API_KEY");
	});

	it("binds each assigned slot to its catalog model's wire name", () => {
		const plan = resolveModelRoleLaunch("claude", bindings, catalog(), RUNTIME);
		expect(plan?.env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe("openai/my-main");
		expect(plan?.env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe("openrouter/fast-gremlin");
	});

	it("fills an unassigned slot with the launch model, never a Claude id the proxy cannot serve", () => {
		const plan = resolveModelRoleLaunch("claude", bindings, catalog(), RUNTIME);
		expect(plan?.env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe(plan?.modelFlag);
		expect(plan?.env.ANTHROPIC_DEFAULT_FABLE_MODEL).toBe(plan?.modelFlag);
		expect(plan?.env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe("openai/my-main");
	});

	it("prefers the slot's own binding over the stand-in", () => {
		const plan = resolveModelRoleLaunch("claude", { opus: "m-main", haiku: "m-fast" }, catalog(), RUNTIME);
		expect(plan?.env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe("openrouter/fast-gremlin");
		expect(plan?.env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe("openai/my-main");
	});

	it("ignores a binding whose catalog model was deleted", () => {
		const plan = resolveModelRoleLaunch("claude", { opus: "m-gone" }, catalog(), RUNTIME);
		expect(plan).toBeUndefined();
	});

	it("rewrites the launch model to the slot the preset already meant", () => {
		const plan = resolveModelRoleLaunch("claude", bindings, catalog(), RUNTIME, "claude-sonnet-5");
		expect(plan?.modelFlag).toBe("openrouter/fast-gremlin");
	});

	it("falls back to a bound slot when the preset's model matches none", () => {
		const plan = resolveModelRoleLaunch("claude", { sonnet: "m-fast" }, catalog(), RUNTIME, "claude-opus-5");
		expect(plan?.modelFlag).toBe("openrouter/fast-gremlin");
	});

	it("falls back to the workhorse slot, not to the priciest one bound", () => {
		// A preset with no model of its own must not open on the premium slot: every
		// ordinary turn would then be billed at premium rates, and the premium model
		// is one /model away anyway.
		const plan = resolveModelRoleLaunch("claude", { fable: "m-main", opus: "m-fast" }, catalog(), RUNTIME);
		expect(plan?.modelFlag).toBe("openrouter/fast-gremlin");
		expect(plan?.env.ANTHROPIC_DEFAULT_FABLE_MODEL).toBe("openai/my-main");
	});

	it("never leaves the launch naming a model the proxy cannot serve", () => {
		const plan = resolveModelRoleLaunch("claude", bindings, catalog(), RUNTIME, "claude-haiku-4-5");
		expect(plan?.modelFlag).not.toContain("claude-");
	});

	it("passes no CLI arguments — Claude is configured entirely by environment", () => {
		expect(resolveModelRoleLaunch("claude", bindings, catalog(), RUNTIME)?.args).toEqual([]);
	});
});

describe("resolveModelRoleLaunch — Codex CLI", () => {
	const bindings = { main: "m-main", subagent: "m-fast", review: "m-local" };

	it("hands Codex the session key as its OpenAI key", () => {
		const plan = resolveModelRoleLaunch("codex", bindings, catalog(), RUNTIME);
		expect(plan?.env.OPENAI_API_KEY).toBe("sk-bf-secret");
	});

	it("declares the sidecar as a Responses-speaking provider over plain HTTP", () => {
		const args = resolveModelRoleLaunch("codex", bindings, catalog(), RUNTIME)?.args.join(" ") ?? "";
		expect(args).toContain(`model_providers.${CODEX_PROVIDER_KEY}.wire_api="responses"`);
		expect(args).toContain(`model_providers.${CODEX_PROVIDER_KEY}.supports_websockets=false`);
		expect(args).toContain(`model_providers.${CODEX_PROVIDER_KEY}.base_url="http://127.0.0.1:41234/openai/v1"`);
		expect(args).toContain(`model_provider="${CODEX_PROVIDER_KEY}"`);
	});

	it("assigns each Codex role its own catalog model", () => {
		const args = resolveModelRoleLaunch("codex", bindings, catalog(), RUNTIME)?.args.join(" ") ?? "";
		expect(args).toContain('model="openai/my-main"');
		expect(args).toContain('agents.default_subagent_model="openrouter/fast-gremlin"');
		expect(args).toContain('review_model="custom-my-box/local"');
	});

	it("rewrites the launch model to the main role, since the flag beats the config", () => {
		expect(resolveModelRoleLaunch("codex", bindings, catalog(), RUNTIME)?.modelFlag).toBe("openai/my-main");
	});

	it("falls an unassigned role back to main, never to Codex's own default slug", () => {
		const args = resolveModelRoleLaunch("codex", { main: "m-main" }, catalog(), RUNTIME)?.args.join(" ") ?? "";
		expect(args).toContain('agents.default_subagent_model="openai/my-main"');
		expect(args).toContain('review_model="openai/my-main"');
	});

	it("routes nothing when the preset has no main model, so Codex keeps its own default", () => {
		expect(resolveModelRoleLaunch("codex", { review: "m-fast" }, catalog(), RUNTIME)).toBeUndefined();
	});
});

describe("buildCodexModelCatalog", () => {
	/** Shaped like a real `codex debug models` dump, trimmed to what the builder reads. */
	function builtin() {
		return {
			models: [
				{ slug: "gpt-5.6-sol", visibility: "list", priority: 1, tool_mode: "code_mode_only", multi_agent_version: "v2", base_instructions: "sol" },
				{ slug: "gpt-5.5", visibility: "list", priority: 7, base_instructions: "plain", supports_search_tool: true, service_tiers: [{ id: "priority" }] },
				{ slug: "gpt-5.4", visibility: "list", priority: 16, base_instructions: "older" },
				{ slug: "codex-auto-review", visibility: "hide", priority: 43, base_instructions: "review" },
			],
		};
	}
	const models = () => buildCodexModelCatalog(builtin(), catalog())?.models ?? [];
	const routed = () => models().filter((m) => String(m.slug).includes("/"));

	it("clones the plainest listed model, not the flagship with its multi-agent machinery", () => {
		expect(routed()[0]?.base_instructions).toBe("plain");
		expect(routed()[0]?.tool_mode).toBeUndefined();
	});

	it("names each catalog model by its wire name and its own label", () => {
		expect(routed().map((m) => m.slug)).toEqual(["openrouter/fast-gremlin", "openai/my-main", "custom-my-box/local"]);
		expect(routed()[0]?.display_name).toBe("fast-gremlin");
		expect(String(routed()[0]?.description)).toContain("OpenRouter");
	});

	it("gives every routed model the same declared window", () => {
		for (const model of routed()) {
			expect(model.context_window).toBe(CATALOG_MODEL_CONTEXT_WINDOW);
			expect(model.max_context_window).toBe(CATALOG_MODEL_CONTEXT_WINDOW);
		}
	});

	it("drops the tiers and hosted tools that only OpenAI can serve", () => {
		expect(routed()[0]?.service_tiers).toEqual([]);
		expect(routed()[0]?.supports_search_tool).toBe(false);
	});

	it("carries every built-in forward, because the generated catalog replaces Codex's own", () => {
		expect(models().map((m) => m.slug)).toEqual([
			"openrouter/fast-gremlin",
			"openai/my-main",
			"custom-my-box/local",
			"gpt-5.6-sol",
			"gpt-5.5",
			"gpt-5.4",
			"codex-auto-review",
		]);
	});

	it("generates nothing when there is nothing to route or nothing to clone", () => {
		expect(buildCodexModelCatalog(builtin(), { providers: [], models: [] })).toBeUndefined();
		expect(buildCodexModelCatalog({ models: [] }, catalog())).toBeUndefined();
	});
});

describe("resolveModelRoleLaunch — no roles", () => {
	it("changes nothing for a preset without bindings", () => {
		expect(resolveModelRoleLaunch("claude", undefined, catalog(), RUNTIME)).toBeUndefined();
		expect(resolveModelRoleLaunch("claude", {}, catalog(), RUNTIME)).toBeUndefined();
	});

	it("changes nothing for an agent dev3 cannot route", () => {
		expect(resolveModelRoleLaunch("gemini", { opus: "m-main" }, catalog(), RUNTIME)).toBeUndefined();
	});
});

describe("validation", () => {
	it("accepts a catalog the user built correctly", () => {
		expect(validateCatalog(catalog())).toEqual([]);
	});

	it("reports two models sharing a name, because a role binding must be unambiguous", () => {
		const dup = catalog();
		dup.models.push({ id: "m-dup", providerId: "p-oai", name: "fast-gremlin", modelId: "gpt-5-mini" });
		expect(validateCatalog(dup)).toEqual([
			expect.objectContaining({ code: "duplicate-name", modelId: "m-dup" }),
		]);
	});

	it("reports a model whose provider was removed", () => {
		const orphan = catalog();
		orphan.providers = orphan.providers.filter((p) => p.id !== "p-or");
		expect(validateCatalog(orphan)).toEqual([
			expect.objectContaining({ code: "unknown-provider", modelId: "m-fast" }),
		]);
	});

	it("calls a half-typed row unfinished rather than malformed", () => {
		const fresh = catalog();
		fresh.models.push({ id: "m-new", providerId: "p-oai", name: "", modelId: "" });
		expect(validateCatalog(fresh)).toEqual([expect.objectContaining({ code: "incomplete", modelId: "m-new" })]);
	});

	it("reports a name that cannot travel on the wire", () => {
		const bad = catalog();
		bad.models[0].name = "fast/gremlin";
		expect(validateCatalog(bad)).toEqual([expect.objectContaining({ code: "invalid-name" })]);
	});

	it("reports a custom endpoint with no base URL", () => {
		const bad = catalog();
		bad.providers[2].baseUrl = "";
		expect(validateCatalog(bad)).toEqual([expect.objectContaining({ code: "missing-base-url" })]);
	});

	it("rejects wire-hostile names and accepts ordinary ones", () => {
		expect(isValidCatalogModelName("fast-gremlin")).toBe(true);
		expect(isValidCatalogModelName("my.main_2")).toBe(true);
		expect(isValidCatalogModelName("fast gremlin")).toBe(false);
		expect(isValidCatalogModelName("")).toBe(false);
	});

	it("names the roles that point at a model the user deleted", () => {
		expect(orphanedRoleBindings({ opus: "m-gone", sonnet: "m-fast" }, catalog())).toEqual(["opus"]);
	});
});

