import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentConfiguration, CodingAgent } from "../../shared/types";
import type { ModelCatalog } from "../../shared/model-catalog";

const h = vi.hoisted(() => ({
	catalog: vi.fn<() => ModelCatalog>(),
	ensure: vi.fn<() => Promise<{ baseUrl: string; sessionKey: string }>>(),
	preflight: vi.fn(),
	writeCodexCatalog: vi.fn<() => Promise<string | undefined>>(),
}));

vi.mock("../model-catalog-store", () => ({ loadModelCatalog: h.catalog }));
vi.mock("../model-sidecar", () => ({
	ensureModelSidecar: h.ensure,
	preflightModelRoles: h.preflight,
	RUNTIME_DIR: "/tmp/dev3-probe-runtime",
}));
vi.mock("../codex-model-catalog", () => ({ writeCodexModelCatalog: h.writeCodexCatalog }));

import { applyModelRoleLaunch, resolveLaunchConfig } from "../agents";

const CATALOG: ModelCatalog = {
	providers: [
		{ id: "p-oai", kind: "openai", label: "OpenAI" },
		{ id: "p-or", kind: "openrouter", label: "OpenRouter" },
	],
	models: [
		{ id: "m-main", providerId: "p-oai", name: "my-main", modelId: "gpt-5.6-sol" },
		{ id: "m-fast", providerId: "p-or", name: "fast", modelId: "deepseek/flash" },
	],
};

function preset(over: Partial<AgentConfiguration> = {}): AgentConfiguration {
	return { id: "c1", name: "Preset", model: "claude-opus-5", ...over };
}

beforeEach(() => {
	vi.clearAllMocks();
	h.catalog.mockReturnValue(CATALOG);
	h.ensure.mockResolvedValue({ baseUrl: "http://127.0.0.1:41234", sessionKey: "sk-bf-x" });
	h.preflight.mockResolvedValue({ ok: true, problems: [] });
	h.writeCodexCatalog.mockResolvedValue("/tmp/dev3-probe-runtime/codex-models.json");
});

describe("a preset without roles", () => {
	it("launches exactly as before, without touching the proxy", async () => {
		const env: Record<string, string> = {};
		const result = await applyModelRoleLaunch("claude", preset(), env, {});
		expect(env).toEqual({});
		expect(result.config?.model).toBe("claude-opus-5");
		expect(h.ensure).not.toHaveBeenCalled();
	});
});

describe("a wrapper binary declared as an agent family", () => {
	const config = preset({ modelRoles: { opus: "m-main" } });

	it("routes through the slots of the CLI it says it is; a wrapper that claims no family stays unrouted", async () => {
		const env: Record<string, string> = {};
		const result = await applyModelRoleLaunch("my-claude-wrapper", config, env, {}, "claude");
		expect(env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe("openai/my-main");
		expect(result.pinnedModel).toBe(true);

		// Rather than guessing from the file name.
		const noFamilyEnv: Record<string, string> = {};
		const noFamily = await applyModelRoleLaunch("my-claude-wrapper", config, noFamilyEnv, {}, "none");
		expect(noFamilyEnv, "no family").toEqual({});
		expect(noFamily.pinnedModel, "no family").toBe(false);
	});
});

describe("a Claude preset with roles", () => {
	const config = preset({ modelRoles: { opus: "m-main", sonnet: "m-fast" } });

	it("routes the session at the proxy with a per-run key, pinning the launch model at a catalog model", async () => {
		// Never at a Claude id the proxy cannot serve.
		const sonnetOnly = await applyModelRoleLaunch("claude", preset({ modelRoles: { sonnet: "m-fast" } }), {}, {});
		expect(sonnetOnly.config?.model, "pinned model").toBe("openrouter/fast");

		const env: Record<string, string> = {};
		await applyModelRoleLaunch("claude", config, env, {});
		expect(env.ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:41234/anthropic");
		expect(env.ANTHROPIC_AUTH_TOKEN).toBe("sk-bf-x");
		expect(env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe("openai/my-main");
		// Claude reads no Codex model catalog.
		expect(h.writeCodexCatalog, "no catalog metadata for Claude").not.toHaveBeenCalled();
	});


	it("lets the preset's own env vars win, as everywhere else", async () => {
		const env: Record<string, string> = {};
		const withOverride = preset({ ...config, envVars: { ANTHROPIC_BASE_URL: "http://elsewhere" } });
		env.ANTHROPIC_BASE_URL = "http://elsewhere";
		await applyModelRoleLaunch("claude", withOverride, env, {});
		expect(env.ANTHROPIC_BASE_URL).toBe("http://elsewhere");
	});

	it("refuses to launch when a role points at a deleted model", async () => {
		await expect(
			applyModelRoleLaunch("claude", preset({ modelRoles: { opus: "m-gone" } }), {}, {}),
		).rejects.toThrow(/no longer exist: opus/);
		expect(h.ensure).not.toHaveBeenCalled();
	});

	it("refuses to launch when the proxy cannot serve a role (naming it) or will not start", async () => {
		h.preflight.mockResolvedValueOnce({
			ok: false,
			problems: [{ roleId: "sonnet", code: "model-unreachable", detail: "openrouter/fast" }],
		});
		await expect(applyModelRoleLaunch("claude", config, {}, {}), "unreachable role").rejects.toThrow(/sonnet: model-unreachable/);
		h.ensure.mockRejectedValue(new Error("The bundled model proxy is missing from this build."));
		await expect(applyModelRoleLaunch("claude", config, {}, {}), "proxy will not start").rejects.toThrow(/missing from this build/);
	});
});

describe("a Codex preset with roles", () => {
	const config = preset({ model: "gpt-5.6-sol", modelRoles: { main: "m-main", subagent: "m-fast" } });

	it("pins the main role, configures Codex only through launch flags, and hands it the session key and model metadata", async () => {
		const env: Record<string, string> = {};
		const result = await applyModelRoleLaunch("codex", config, env, {});
		// The flag beats the config.
		expect(result.config?.model, "main role pinned").toBe("openai/my-main");
		// Leaving ~/.codex alone.
		const args = result.options.modelRoleArgs?.join(" ") ?? "";
		expect(args).toContain('wire_api="responses"');
		expect(args).toContain('agents.default_subagent_model="openrouter/fast"');
		expect(args, "generated metadata").toContain('model_catalog_json="/tmp/dev3-probe-runtime/codex-models.json"');
		expect(env.OPENAI_API_KEY, "session key, not an upstream key").toBe("sk-bf-x");
	});

	it("refuses to launch when the main role is missing, instead of using Codex's own model", async () => {
		await expect(
			applyModelRoleLaunch("codex", preset({ modelRoles: { review: "m-fast" } }), {}, {}),
		).rejects.toThrow(/not the model the agent actually launches with/);
	});


	it("still launches when the metadata could not be generated", async () => {
		h.writeCodexCatalog.mockResolvedValue(undefined);
		const result = await applyModelRoleLaunch("codex", config, {}, {});
		const args = result.options.modelRoleArgs?.join(" ") ?? "";
		expect(args).not.toContain("model_catalog_json");
		expect(args).toContain('model="openai/my-main"');
	});

});

describe("a routed launch is not second-guessed", () => {
	// The alias rewrites downstream match on the model STRING, and a user may name
	// a catalog model anything. "sonnet-cheap" bound to the opus slot used to come
	// out of the pipeline as the SONNET slot's model — a different provider, a
	// different bill, and nothing on screen saying so.
	const AGENT = { id: "a", name: "Claude Code", baseCommand: "claude", configurations: [] } as unknown as CodingAgent;
	const NAMED_LIKE_AN_ALIAS: ModelCatalog = {
		providers: [{ id: "p-or", kind: "openrouter", label: "OpenRouter" }],
		models: [
			{ id: "m-cheap", providerId: "p-or", name: "sonnet-cheap", modelId: "deepseek/flash" },
			{ id: "m-big", providerId: "p-or", name: "big", modelId: "deepseek/pro" },
		],
	};

	async function route() {
		h.catalog.mockReturnValue(NAMED_LIKE_AN_ALIAS);
		const env: Record<string, string> = {};
		const routed = await applyModelRoleLaunch(
			"claude",
			preset({ modelRoles: { opus: "m-cheap", sonnet: "m-big" } }),
			env,
			{},
		);
		return { routed, env };
	}

	it("keeps the pinned catalog model even when its name reads like an alias", async () => {
		const { routed, env } = await route();
		expect(routed.pinnedModel).toBe(true);
		expect(resolveLaunchConfig(routed.config, AGENT, "claude", env, routed.pinnedModel)?.model).toBe("openrouter/sonnet-cheap");
	});

	// The guard is only worth having if the thing it guards really bites.
	it("would otherwise be swapped for another role's model", async () => {
		const { routed, env } = await route();
		expect(resolveLaunchConfig(routed.config, AGENT, "claude", env, false)?.model).toBe("openrouter/big");
	});
});
