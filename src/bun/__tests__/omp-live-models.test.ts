import { describe, expect, it, vi } from "vitest";
import { getOmpLiveModels, parseOmpModels, type OmpLiveModelDeps } from "../omp-live-models";

const codex = [{ provider: "openai-codex", identityKey: null, orgName: null }];
const listing = {
	models: [
		{ provider: "cerebras", kind: "chat", id: "zai-glm-4.7", selector: "cerebras/zai-glm-4.7", name: "GLM 4.7" },
		{ provider: "openai-codex", kind: "chat", id: "gpt-5.6-luna", selector: "openai-codex/gpt-5.6-luna", name: "GPT-5.6 Luna" },
		{ provider: "openai-codex", kind: "chat", id: "gpt-6.1-sol", selector: "openai-codex/gpt-6.1-sol", name: "GPT-6.1 Sol" },
		{ provider: "openai-codex", kind: "image", id: "img", selector: "openai-codex/img", name: "Image" },
	],
};

function deps(overrides: Partial<OmpLiveModelDeps> = {}): OmpLiveModelDeps {
	return {
		resolveAgentDir: vi.fn(async () => `/acct/${Math.random()}`),
		listLogins: vi.fn(async () => codex),
		listModels: vi.fn(async () => listing),
		readDefaultModel: vi.fn(async () => null),
		now: () => 0,
		...overrides,
	};
}

describe("omp live models", () => {
	it("keeps only chat models of the providers the account signed in to, newest first", () => {
		expect(parseOmpModels(listing, codex).map((m) => m.selector)).toEqual(["openai-codex/gpt-6.1-sol", "openai-codex/gpt-5.6-luna"]);
	});

	it("puts the model omp is set to start on first, and ignores one the account cannot reach", () => {
		expect(parseOmpModels(listing, codex, "openai-codex/gpt-5.6-luna").map((m) => m.selector)).toEqual(["openai-codex/gpt-5.6-luna", "openai-codex/gpt-6.1-sol"]);
		expect(parseOmpModels(listing, codex, "anthropic/claude-opus-5-5").map((m) => m.selector)).toEqual(["openai-codex/gpt-6.1-sol", "openai-codex/gpt-5.6-luna"]);
	});

	it("reads omp's default model from the requested account's dir", async () => {
		const d = deps({ resolveAgentDir: vi.fn(async () => "/acct/d1"), readDefaultModel: vi.fn(async () => "openai-codex/gpt-5.6-luna") });
		const result = await getOmpLiveModels("d1", {}, d);
		expect(d.readDefaultModel).toHaveBeenCalledWith("/acct/d1");
		expect(result.status === "resolved" && result.models[0].selector).toBe("openai-codex/gpt-5.6-luna");
	});

	it("rejects a listing without a models array", () => {
		expect(() => parseOmpModels({}, codex)).toThrow();
	});

	it("answers an empty list, without asking for models, when nothing is signed in", async () => {
		const d = deps({ listLogins: vi.fn(async () => []) });
		expect(await getOmpLiveModels("a1", {}, d)).toEqual({ status: "resolved", models: [] });
		expect(d.listModels).not.toHaveBeenCalled();
	});

	it("reads the agent dir of the requested account", async () => {
		const d = deps({ resolveAgentDir: vi.fn(async () => "/acct/a2") });
		await getOmpLiveModels("a2", {}, d);
		expect(d.resolveAgentDir).toHaveBeenCalledWith("a2");
		expect(d.listModels).toHaveBeenCalledWith("/acct/a2");
	});

	it("answers unknown when omp fails, and serves the cache until refresh", async () => {
		expect(await getOmpLiveModels("a1", {}, deps({ listModels: vi.fn(async () => { throw new Error("boom"); }) }))).toEqual({ status: "unknown" });
		const d = deps({ resolveAgentDir: vi.fn(async () => "/acct/cached") });
		await getOmpLiveModels("a1", {}, d);
		await getOmpLiveModels("a1", {}, d);
		expect(d.listModels).toHaveBeenCalledTimes(1);
		await getOmpLiveModels("a1", { refresh: true }, d);
		expect(d.listModels).toHaveBeenCalledTimes(2);
	});
});
