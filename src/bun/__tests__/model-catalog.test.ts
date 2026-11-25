import { describe, expect, it } from "vitest";
import {
	CATALOG_MODEL_CONTEXT_WINDOW,
	CODEX_PROVIDER_KEY,
	buildCodexModelCatalog,
	buildSidecarConfig,
	catalogModelWireName,
	keepProviderRoutingLabels,
	isValidCatalogModelName,
	modelRolesForAgent,
	nativeModelIdForWireName,
	orphanedRoleBindings,
	providerDisplayName,
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
	it("derives each provider's wire key and credential env var", () => {
		expect(sidecarProviderKey({ id: "p-oai", kind: "openai", label: "Whatever" })).toBe("openai");
		expect(sidecarProviderKey({ id: "p-or", kind: "openrouter", label: "OR" })).toBe("openrouter");

		// derives a custom endpoint's key from its label, slugified and prefixed
		expect(sidecarProviderKey({ id: "p1", kind: "custom", label: "My Box 2" })).toBe("custom-my-box-2");

		// lets the view's wire key win over the label
		expect(sidecarProviderKey({ id: "p1", kind: "custom", label: "Kimi code", wireKey: "custom-custom-endpoint" })).toBe(
			"custom-custom-endpoint",
		);

		// gives each provider its own credential env var
		expect(providerKeyEnvName("openrouter")).toBe("DEV3_LLM_KEY_OPENROUTER");
		expect(providerKeyEnvName("custom-my-box")).toBe("DEV3_LLM_KEY_CUSTOM_MY_BOX");
	});
});

describe("wire names", () => {
	it("addresses a catalog model as provider/name, and has none for a deleted model", () => {
		expect(catalogModelWireName(catalog(), "m-fast")).toBe("openrouter/fast-gremlin");
		expect(catalogModelWireName(catalog(), "m-local")).toBe("custom-my-box/local");

		// has no wire name for a model that is gone
		expect(catalogModelWireName(catalog(), "m-deleted")).toBeUndefined();
	});

	it("reads a wire name back to the provider's own model id, and claims no foreign model string", () => {
		expect(nativeModelIdForWireName(catalog(), "openrouter/fast-gremlin")).toBe("deepseek/deepseek-flash");
		expect(nativeModelIdForWireName(catalog(), "custom-my-box/local")).toBe("qwen3");

		// does not claim a model string that is not one of ours
		expect(nativeModelIdForWireName(catalog(), "claude-opus-5")).toBeUndefined();
		expect(nativeModelIdForWireName(catalog(), "openrouter/never-added")).toBeUndefined();
		expect(nativeModelIdForWireName(catalog(), "nosuchprovider/fast-gremlin")).toBeUndefined();
	});
});

describe("uniqueCustomProviderLabel", () => {
	const boxes = (...labels: string[]) => labels.map((label, i) => ({ id: `p${i}`, kind: "custom" as const, label }));

	it("keeps a free label, and names a colliding endpoint after its host, counting up and avoiding frozen keys", () => {
		const cases: Array<[name: string, existing: Parameters<typeof uniqueCustomProviderLabel>[0], label: string, url: string, expected: string]> = [
			["nothing else answers to it", [], "Ollama", "http://localhost:11434/v1", "Ollama"],
			// Only custom endpoints collide.
			["a known-kind provider holds the label", [{ id: "p0", kind: "openrouter", label: "Ollama" }], "Ollama", "http://localhost:11434/v1", "Ollama"],
			["second endpoint is named after its host", boxes("Custom"), "Custom", "https://b.example.com/v1", "Custom (b.example.com)"],
			["two endpoints share one host", boxes("Custom", "Custom (b.example.com)"), "Custom", "https://b.example.com/other", "Custom 2"],
			["a renamed provider froze the key", [{ id: "p0", kind: "custom", label: "Kimi code", wireKey: "custom-custom" }], "Custom", "https://b.example.com/v1", "Custom (b.example.com)"],
		];
		for (const [name, existing, label, url, expected] of cases) {
			expect(uniqueCustomProviderLabel(existing, label, url), name).toBe(expected);
		}
		// So both can exist side by side.
		expect(sidecarProviderKey({ id: "p9", kind: "custom", label: "Custom (b.example.com)" })).not.toBe("custom-custom");
	});
});

describe("keepProviderRoutingLabels", () => {
	const cat = (...providers: ModelCatalog["providers"]): ModelCatalog => ({ providers, models: [] });
	const box = (label: string, extra: object = {}) => ({ id: "c1", kind: "custom" as const, label, ...extra });

	it("stores a new custom provider under its own label, shown when there is no display name", () => {
		const out = keepProviderRoutingLabels(cat(), cat(box("Custom endpoint")));
		expect(out.providers[0]).toEqual(box("Custom endpoint"));

		// shows the label when there is no display name
		expect(providerDisplayName(box("Box"))).toBe("Box");
	});

	it("ignores a wire key or display name supplied by the caller", () => {
		const out = keepProviderRoutingLabels(cat(box("Box")), cat(box("Box", { wireKey: "custom-evil", displayName: "x" })));
		expect(out.providers[0]).toEqual(box("Box"));
		const fresh = keepProviderRoutingLabels(cat(), cat(box("New", { wireKey: "custom-evil" })));
		expect(fresh.providers[0]).toEqual(box("New"));
	});

	it("keeps the stored label of a renamed custom provider and records the new name", () => {
		const out = keepProviderRoutingLabels(cat(box("Custom endpoint")), cat(box("Kimi code")));
		expect(out.providers[0]).toEqual(box("Custom endpoint", { displayName: "Kimi code" }));
		expect(providerDisplayName(out.providers[0])).toBe("Kimi code");
		expect(sidecarProviderKey(out.providers[0])).toBe("custom-custom-endpoint");
	});

	it("keeps routing on the first label through several renames, and clears the name on rename back", () => {
		const renamed = cat(box("Custom endpoint", { displayName: "Kimi code" }));
		const again = keepProviderRoutingLabels(renamed, cat(box("Other")));
		expect(again.providers[0]).toEqual(box("Custom endpoint", { displayName: "Other" }));
		const back = keepProviderRoutingLabels(renamed, cat(box("Custom endpoint")));
		expect(back.providers[0]).not.toHaveProperty("displayName");
	});

	it("treats a kind switch either way as a new provider label", () => {
		const toCustom = keepProviderRoutingLabels(cat({ id: "c1", kind: "openrouter", label: "OpenRouter" }), cat(box("My Box")));
		expect(toCustom.providers[0]).toEqual(box("My Box"));
		expect(sidecarProviderKey(toCustom.providers[0])).toBe("custom-my-box");
		const toKnown = keepProviderRoutingLabels(cat(box("Custom endpoint")), cat({ id: "c1", kind: "openai", label: "OpenAI" }));
		expect(toKnown.providers[0]).toEqual({ id: "c1", kind: "openai", label: "OpenAI" });
	});
});

describe("buildSidecarConfig", () => {
	it("declares one provider block per provider, keys only by reference, models as aliases, none for an empty catalog", () => {
		const config = buildSidecarConfig(catalog());
		expect(Object.keys(config.providers).sort()).toEqual(["custom-my-box", "openai", "openrouter"]);
		expect(config.providers.openrouter.keys[0].value).toBe("env.DEV3_LLM_KEY_OPENROUTER");
		expect(config.providers.openrouter.keys[0].aliases).toEqual({ "fast-gremlin": "deepseek/deepseek-flash" });
		expect(config.providers.openai.keys[0].aliases).toEqual({ "my-main": "gpt-5.6-sol" });
		// A credential value is never written into the document.
		const serialized = JSON.stringify(config);
		expect(serialized).not.toContain("sk-");
		expect(serialized.match(/"value":\s*"(?!env\.)/)).toBeNull();
		expect(buildSidecarConfig({ providers: [], models: [] }).providers).toEqual({});
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

	it("describes a custom endpoint as an OpenAI-compatible provider with its own base URL, allowing Responses", () => {
		// Every custom provider already on disk has no apiFormat. Reading one must
		// not quietly move it onto a protocol its endpoint does not speak.
		const stored = catalog();
		expect(stored.providers.find((p) => p.kind === "custom")?.apiFormat).toBeUndefined();
		const custom = buildSidecarConfig(stored).providers["custom-my-box"];
		expect(custom.custom_provider_config?.base_provider_type).toBe("openai");
		expect(custom.network_config?.base_url).toBe("https://llm.example.com/v1");
		// Codex speaks nothing but the Responses protocol.
		expect(custom.custom_provider_config?.allowed_requests.responses).toBe(true);
		expect(custom.custom_provider_config?.allowed_requests.responses_stream).toBe(true);
		expect(custom.custom_provider_config?.allowed_requests.list_models).toBe(true);
	});

	it("declares an Anthropic-shaped endpoint under the OpenAI operation names, without model listing", () => {
		const base = catalog();
		const anthropic = {
			...base,
			providers: base.providers.map((p) => (p.kind === "custom" ? { ...p, apiFormat: "anthropic" as const } : p)),
		};
		const custom = buildSidecarConfig(anthropic).providers["custom-my-box"];
		// The sidecar maps them to /v1/messages.
		expect(custom.custom_provider_config?.base_provider_type).toBe("anthropic");
		// The operations keep their OpenAI names — renaming them to a Messages-ish
		// key denies every request, because unlisted means denied.
		expect(custom.custom_provider_config?.allowed_requests.chat_completion).toBe(true);
		expect(custom.custom_provider_config?.allowed_requests.responses).toBe(true);
		// That profile declares no listing path.
		expect(custom.custom_provider_config?.allowed_requests.list_models).toBe(false);
	});

	it("gates every provider behind one local session key, with absolute sqlite stores that log token counts, never bodies", () => {
		const config = buildSidecarConfig(catalog(), "/data/dev3");
		expect(config.client.enforce_auth_on_inference).toBe(true);
		expect(config.client.allow_direct_keys).toBe(false);
		const vk = config.governance.virtual_keys[0];
		expect(vk.value).toBe("env.DEV3_BIFROST_VIRTUAL_KEY");
		expect(vk.provider_configs.map((p) => p.provider).sort()).toEqual(["custom-my-box", "openai", "openrouter"]);
		// Absolute, since the sidecar resolves paths against its own CWD.
		expect(config.config_store.config?.path).toBe("/data/dev3/config.db");
		expect(config.logs_store.config?.path).toBe("/data/dev3/logs.db");
		// Without a store type the sidecar refuses to boot.
		expect(config.config_store).toMatchObject({ enabled: true, type: "sqlite" });
		expect(config.logs_store.enabled).toBe(true);
		expect(config.client.enable_logging).toBe(true);
		expect(config.client.disable_content_logging).toBe(true);
	});
});

describe("modelRolesForAgent", () => {
	it("offers Claude and Codex their own roles (by name or path) and nothing to others", () => {
		expect(modelRolesForAgent("claude").map((r) => r.id)).toEqual(["fable", "opus", "sonnet", "haiku"]);

		// offers Codex the roles Codex actually has
		expect(modelRolesForAgent("codex").map((r) => r.id)).toEqual(["main", "subagent", "review"]);

		// resolves an absolute binary path to its agent
		expect(modelRolesForAgent("/opt/homebrew/bin/claude").map((r) => r.id)).toContain("opus");

		// has no roles for an agent dev3 cannot route
		expect(modelRolesForAgent("gemini")).toEqual([]);
	});
});

describe("resolveModelRoleLaunch — Claude Code", () => {
	const bindings = { opus: "m-main", sonnet: "m-fast" };

	it("points Claude at the sidecar by env only, binding slots to wire names, filling unassigned ones, and clearing a stale API key", () => {
		const plan = resolveModelRoleLaunch("claude", bindings, catalog(), RUNTIME);
		expect(plan?.env.ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:41234/anthropic");
		expect(plan?.env.ANTHROPIC_AUTH_TOKEN).toBe("sk-bf-secret");
		expect(plan?.args).toEqual([]);
		expect(plan?.unsetEnv).toContain("ANTHROPIC_API_KEY");
		expect(plan?.env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe("openai/my-main");
		expect(plan?.env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe("openrouter/fast-gremlin");
		// An unassigned slot gets the launch model, never a Claude id the proxy cannot serve.
		expect(plan?.env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe(plan?.modelFlag);
		expect(plan?.env.ANTHROPIC_DEFAULT_FABLE_MODEL).toBe(plan?.modelFlag);
		expect(plan?.env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe("openai/my-main");
	});

	it("names each bound slot in Claude's own picker, and clears the display of a slot it does not name", () => {
		const plan = resolveModelRoleLaunch("claude", bindings, catalog(), RUNTIME);
		expect(plan?.env.ANTHROPIC_DEFAULT_OPUS_MODEL_NAME).toBe("my-main");
		expect(plan?.env.ANTHROPIC_DEFAULT_OPUS_MODEL_DESCRIPTION).toBe("OpenAI · gpt-5.6-sol");
		expect(plan?.env.ANTHROPIC_DEFAULT_SONNET_MODEL_DESCRIPTION).toBe("OpenRouter · deepseek/deepseek-flash");
		// So an unnamed slot cannot inherit another model's label.
		expect(plan?.env.ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME).toBeUndefined();
		expect(plan?.unsetEnv).toContain("ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME");
		expect(plan?.unsetEnv).toContain("ANTHROPIC_DEFAULT_HAIKU_MODEL_DESCRIPTION");
	});

	const wideCatalog = (): ModelCatalog => ({
		providers: [{ id: "p-or", kind: "openrouter", label: "OpenRouter" }],
		models: [
			{ id: "m-1m", providerId: "p-or", name: "glm", modelId: "z-ai/glm-5.2" },
			{ id: "m-1m-off", providerId: "p-or", name: "glm-short", modelId: "z-ai/glm-5.2", extendedContext: false },
			{ id: "m-plain", providerId: "p-or", name: "old", modelId: "some/older-model" },
		],
	});

	it("runs a 1M model on its own window instead of Claude Code's 200k assumption", () => {
		const plan = resolveModelRoleLaunch("claude", { opus: "m-1m", sonnet: "m-1m" }, wideCatalog(), RUNTIME);
		expect(plan?.env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe("openrouter/glm[1m]");
		expect(plan?.env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe("openrouter/glm[1m]");
		// The window is read off the model the session selects, so the flag carries it too.
		expect(plan?.modelFlag).toBe("openrouter/glm[1m]");
	});

	it("keeps the marker off the slots whose alias does not document it", () => {
		const plan = resolveModelRoleLaunch("claude", { opus: "m-1m", fable: "m-1m", haiku: "m-1m" }, wideCatalog(), RUNTIME);
		expect(plan?.env.ANTHROPIC_DEFAULT_FABLE_MODEL).toBe("openrouter/glm");
		expect(plan?.env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe("openrouter/glm");
	});

	it("leaves the 1M marker off a model opted out of it or never claimed as 1M", () => {
		for (const [id, wire] of [["m-1m-off", "openrouter/glm-short"], ["m-plain", "openrouter/old"]]) {
			const plan = resolveModelRoleLaunch("claude", { opus: id }, wideCatalog(), RUNTIME);
			expect(plan?.env.ANTHROPIC_DEFAULT_OPUS_MODEL, id).toBe(wire);
			expect(plan?.modelFlag, id).toBe(wire);
		}
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

	it("rewrites the launch model to the preset's slot or a bound one, never a Claude id the proxy cannot serve", () => {
		const cases: Array<[name: string, slots: Record<string, string>, preset: string, expected: string]> = [
			["the slot the preset already meant", bindings, "claude-sonnet-5", "openrouter/fast-gremlin"],
			["a bound slot when the preset's model matches none", { sonnet: "m-fast" }, "claude-opus-5", "openrouter/fast-gremlin"],
		];
		for (const [name, slots, preset, expected] of cases) {
			expect(resolveModelRoleLaunch("claude", slots, catalog(), RUNTIME, preset)?.modelFlag, name).toBe(expected);
		}
		expect(resolveModelRoleLaunch("claude", bindings, catalog(), RUNTIME, "claude-haiku-4-5")?.modelFlag).not.toContain("claude-");
	});

	it("falls back to the workhorse slot, not to the priciest one bound", () => {
		// A preset with no model of its own must not open on the premium slot: every
		// ordinary turn would then be billed at premium rates, and the premium model
		// is one /model away anyway.
		const plan = resolveModelRoleLaunch("claude", { fable: "m-main", opus: "m-fast" }, catalog(), RUNTIME);
		expect(plan?.modelFlag).toBe("openrouter/fast-gremlin");
		expect(plan?.env.ANTHROPIC_DEFAULT_FABLE_MODEL).toBe("openai/my-main");
	});
});

describe("resolveModelRoleLaunch — Codex CLI", () => {
	const bindings = { main: "m-main", subagent: "m-fast", review: "m-local" };

	it("hands Codex the session key and a Responses provider over HTTP, launching on the main role with each role's own model", () => {
		const plan = resolveModelRoleLaunch("codex", bindings, catalog(), RUNTIME);
		expect(plan?.env.OPENAI_API_KEY).toBe("sk-bf-secret");
		// The flag beats the config, so the launch model is rewritten to the main role.
		expect(plan?.modelFlag).toBe("openai/my-main");
		const args = plan?.args.join(" ") ?? "";
		expect(args).toContain(`model_providers.${CODEX_PROVIDER_KEY}.wire_api="responses"`);
		expect(args).toContain(`model_providers.${CODEX_PROVIDER_KEY}.supports_websockets=false`);
		expect(args).toContain(`model_providers.${CODEX_PROVIDER_KEY}.base_url="http://127.0.0.1:41234/openai/v1"`);
		expect(args).toContain(`model_provider="${CODEX_PROVIDER_KEY}"`);
		expect(args).toContain('model="openai/my-main"');
		expect(args).toContain('agents.default_subagent_model="openrouter/fast-gremlin"');
		expect(args).toContain('review_model="custom-my-box/local"');
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

	it("clones the plainest listed model per catalog model, named by wire name, with one window and no OpenAI-only tools, keeping every built-in", () => {
		expect(routed()[0]?.base_instructions).toBe("plain");
		expect(routed()[0]?.tool_mode).toBeUndefined();

		// names each catalog model by its wire name and its own label
		expect(routed().map((m) => m.slug)).toEqual(["openrouter/fast-gremlin", "openai/my-main", "custom-my-box/local"]);
		expect(routed()[0]?.display_name).toBe("fast-gremlin");
		expect(String(routed()[0]?.description)).toContain("OpenRouter");

		// gives every routed model the same declared window
		for (const model of routed()) {
			expect(model.context_window).toBe(CATALOG_MODEL_CONTEXT_WINDOW);
			expect(model.max_context_window).toBe(CATALOG_MODEL_CONTEXT_WINDOW);
		}

		// drops the tiers and hosted tools that only OpenAI can serve
		expect(routed()[0]?.service_tiers).toEqual([]);
		expect(routed()[0]?.supports_search_tool).toBe(false);

		// Every built-in is carried forward, because the generated catalog replaces Codex's own.
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
	it("changes nothing for a preset without bindings or an agent dev3 cannot route", () => {
		expect(resolveModelRoleLaunch("claude", undefined, catalog(), RUNTIME)).toBeUndefined();
		expect(resolveModelRoleLaunch("claude", {}, catalog(), RUNTIME)).toBeUndefined();

		// changes nothing for an agent dev3 cannot route
		expect(resolveModelRoleLaunch("gemini", { opus: "m-main" }, catalog(), RUNTIME)).toBeUndefined();
	});
});

describe("validation", () => {
	it("accepts a correct catalog and ordinary names, and names roles bound to deleted models", () => {
		expect(validateCatalog(catalog())).toEqual([]);

		// rejects wire-hostile names and accepts ordinary ones
		expect(isValidCatalogModelName("fast-gremlin")).toBe(true);
		expect(isValidCatalogModelName("my.main_2")).toBe(true);
		expect(isValidCatalogModelName("fast gremlin")).toBe(false);
		expect(isValidCatalogModelName("")).toBe(false);

		// names the roles that point at a model the user deleted
		expect(orphanedRoleBindings({ opus: "m-gone", sonnet: "m-fast" }, catalog())).toEqual(["opus"]);
	});

	it("reports duplicate names, orphaned models, unfinished rows, wire-hostile names and missing base URLs", () => {
		const cases: Array<[code: string, mutate: (c: ModelCatalog) => void, expected: object]> = [
			// A role binding must be unambiguous.
			["duplicate-name", (c) => void c.models.push({ id: "m-dup", providerId: "p-oai", name: "fast-gremlin", modelId: "gpt-5-mini" }), { modelId: "m-dup" }],
			["unknown-provider", (c) => void (c.providers = c.providers.filter((p) => p.id !== "p-or")), { modelId: "m-fast" }],
			// A half-typed row is unfinished, not malformed.
			["incomplete", (c) => void c.models.push({ id: "m-new", providerId: "p-oai", name: "", modelId: "" }), { modelId: "m-new" }],
			["invalid-name", (c) => void (c.models[0].name = "fast/gremlin"), {}],
			["missing-base-url", (c) => void (c.providers[2].baseUrl = ""), {}],
		];
		for (const [code, mutate, expected] of cases) {
			const bad = catalog();
			mutate(bad);
			expect(validateCatalog(bad), code).toEqual([expect.objectContaining({ code, ...expected })]);
		}
	});
});
