import { describe, expect, it, vi } from "vitest";
import { getAgentDirLiveModels, parseOmpModels, parsePiModelList, rankLiveModels, type AgentDirLiveModelDeps } from "../agent-dir-live-models";

const codex = [{ provider: "openai-codex", identityKey: null, orgName: null }];
const listing = {
	models: [
		{ provider: "cerebras", kind: "chat", id: "zai-glm-4.7", selector: "cerebras/zai-glm-4.7", name: "GLM 4.7" },
		{ provider: "openai-codex", kind: "chat", id: "gpt-5.6-luna", selector: "openai-codex/gpt-5.6-luna", name: "GPT-5.6 Luna" },
		{ provider: "openai-codex", kind: "chat", id: "gpt-6.1-sol", selector: "openai-codex/gpt-6.1-sol", name: "GPT-6.1 Sol" },
		{ provider: "openai-codex", kind: "image", id: "img", selector: "openai-codex/img", name: "Image" },
	],
};

function deps(overrides: Partial<AgentDirLiveModelDeps> = {}): AgentDirLiveModelDeps {
	return {
		resolveAgentDir: vi.fn(async () => `/acct/${Math.random()}`),
		listLogins: vi.fn(async () => codex),
		listModels: vi.fn(async () => parseOmpModels(listing)),
		readDefaultModel: vi.fn(async () => null),
		now: () => 0,
		...overrides,
	};
}

describe("agent-dir live models (omp)", () => {
	it("keeps only chat models of the providers the account signed in to, newest first", () => {
		expect(rankLiveModels(parseOmpModels(listing), codex).map((m) => m.selector)).toEqual(["openai-codex/gpt-6.1-sol", "openai-codex/gpt-5.6-luna"]);
	});

	it("puts the model omp is set to start on first, and ignores one the account cannot reach", () => {
		expect(rankLiveModels(parseOmpModels(listing), codex, "openai-codex/gpt-5.6-luna").map((m) => m.selector)).toEqual(["openai-codex/gpt-5.6-luna", "openai-codex/gpt-6.1-sol"]);
		expect(rankLiveModels(parseOmpModels(listing), codex, "anthropic/claude-opus-5-5").map((m) => m.selector)).toEqual(["openai-codex/gpt-6.1-sol", "openai-codex/gpt-5.6-luna"]);
	});

	it("reads omp's default model from the requested account's dir", async () => {
		const d = deps({ resolveAgentDir: vi.fn(async () => "/acct/d1"), readDefaultModel: vi.fn(async () => "openai-codex/gpt-5.6-luna") });
		const result = await getAgentDirLiveModels("omp", "d1", {}, d);
		expect(d.readDefaultModel).toHaveBeenCalledWith("/acct/d1");
		expect(result.status === "resolved" && result.models[0].selector).toBe("openai-codex/gpt-5.6-luna");
	});

	it("rejects a listing without a models array", () => {
		expect(() => parseOmpModels({})).toThrow();
	});

	it("answers an empty list, without asking for models, when nothing is signed in", async () => {
		const d = deps({ listLogins: vi.fn(async () => []) });
		expect(await getAgentDirLiveModels("omp", "a1", {}, d)).toEqual({ status: "resolved", models: [] });
		expect(d.listModels).not.toHaveBeenCalled();
	});

	it("reads the agent dir of the requested account", async () => {
		const d = deps({ resolveAgentDir: vi.fn(async () => "/acct/a2") });
		await getAgentDirLiveModels("omp", "a2", {}, d);
		expect(d.resolveAgentDir).toHaveBeenCalledWith("a2");
		expect(d.listModels).toHaveBeenCalledWith("/acct/a2");
	});

	it("answers unknown when omp fails, and serves the cache until refresh", async () => {
		expect(await getAgentDirLiveModels("omp", "a1", {}, deps({ listModels: vi.fn(async () => { throw new Error("boom"); }) }))).toEqual({ status: "unknown" });
		const d = deps({ resolveAgentDir: vi.fn(async () => "/acct/cached") });
		await getAgentDirLiveModels("omp", "a1", {}, d);
		await getAgentDirLiveModels("omp", "a1", {}, d);
		expect(d.listModels).toHaveBeenCalledTimes(1);
		await getAgentDirLiveModels("omp", "a1", { refresh: true }, d);
		expect(d.listModels).toHaveBeenCalledTimes(2);
	});
});

describe("agent-dir live models (pi)", () => {
	const table = [
		"provider    model                              context  max-out  thinking  images",
		"openrouter  ~anthropic/claude-opus-latest      1M       128K     yes       yes",
		"groq        openai/gpt-oss-120b                131K     65.5K    yes       no",
		"",
	].join("\n");
	const openrouter = [{ provider: "openrouter", identityKey: null, orgName: null, authType: "api_key" as const }];

	it("reads pi's model table into provider/id selectors", () => {
		expect(parsePiModelList(table).map((m) => m.selector)).toEqual(["openrouter/~anthropic/claude-opus-latest", "groq/openai/gpt-oss-120b"]);
	});

	it("reads pi's no-models notice as an empty list, and an unknown shape as an error", () => {
		expect(parsePiModelList("No models available. Use /login to log into a provider via OAuth or API key. See:\n  docs")).toEqual([]);
		expect(() => parsePiModelList("something else entirely")).toThrow();
	});

	it("keeps only the account's own providers, never one an env key adds", async () => {
		const d = deps({ listLogins: vi.fn(async () => openrouter), listModels: vi.fn(async () => parsePiModelList(table)) });
		const result = await getAgentDirLiveModels("pi", "p1", {}, d);
		expect(result.status === "resolved" && result.models.map((m) => m.provider)).toEqual(["openrouter"]);
	});
});
