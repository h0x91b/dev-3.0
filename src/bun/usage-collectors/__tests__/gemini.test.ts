import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { newUsageState } from "../../rpc-handlers/agent-usage-parse";
import { collectGeminiUsage } from "../gemini";

let home: string;
const timestamp = "2026-10-25T12:00:00Z";
function message(id = "message", tokens: Record<string, unknown> = { input: 1_000, output: 100, cached: 400, thoughts: 50, tool: 20, total: 1_170 }) {
	return { id, type: "gemini", timestamp, model: "gemini-2.5-pro", tokens, content: "private assistant text", toolCalls: [{ args: "private tool args" }] };
}
function write(path: string, body: unknown, jsonl = false): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, jsonl ? (body as unknown[]).map((row) => JSON.stringify(row)).join("\n") : JSON.stringify(body));
}
function path(name = "session-one.json", project = "project") {
	return join(home, ".gemini", "tmp", project, "chats", name);
}

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "dev3-gemini-usage-"));
	vi.stubEnv("GEMINI_CLI_HOME", "");
});
afterEach(() => {
	vi.unstubAllEnvs();
	rmSync(home, { recursive: true, force: true });
});

describe("collectGeminiUsage", () => {
	it("splits inclusive cached input and counts tool inputs and generated thoughts once", () => {
		write(path(), { sessionId: "session", messages: [message()] });
		const state = newUsageState();
		collectGeminiUsage(state, home);
		expect([...state.records.values()]).toEqual([{
			model: "gemini-2.5-pro", pricingModel: undefined, timestamp: Date.parse(timestamp),
			counts: { inputTokens: 620, outputTokens: 150, cacheReadInputTokens: 400, cacheCreationInputTokens: 0 },
		}]);
	});

	it("deduplicates legacy JSON and migrated JSONL copies by session and message identity", () => {
		write(path(), { sessionId: "session", messages: [message()] });
		write(path("session-one.jsonl"), [{ sessionId: "session" }, message()], true);
		const state = newUsageState();
		collectGeminiUsage(state, home);
		collectGeminiUsage(state, home);
		expect(state.records.size).toBe(1);
	});

	it("replaces resumed response snapshots and keeps new responses from the same day", () => {
		const state = newUsageState();
		write(path(), { sessionId: "session", messages: [message("one", { input: 100, output: 10 })] });
		collectGeminiUsage(state, home);
		write(path(), { sessionId: "session", messages: [message("one", { input: 100, output: 50 }), message("two", { input: 200, output: 60 })] });
		collectGeminiUsage(state, home);
		expect([...state.records.values()].map((record) => record.counts.outputTokens).sort((a, b) => a - b)).toEqual([50, 60]);
	});

	it("counts repeated message ids in distinct sessions independently", () => {
		write(path(), { sessionId: "session-one", messages: [message()] });
		write(path("session-two.json"), { sessionId: "session-two", messages: [message()] });
		const state = newUsageState();
		collectGeminiUsage(state, home);
		expect(state.records.size).toBe(2);
	});

	it("collects nested subagent sessions from the current JSONL store", () => {
		write(path("parent-session/subagent.jsonl"), [{ sessionId: "child", kind: "subagent" }, message()], true);
		const state = newUsageState();
		collectGeminiUsage(state, home);
		expect(state.records.size).toBe(1);
	});

	it("reads token-bearing appended message updates while tolerating truncated final lines", () => {
		const file = path("session-one.jsonl");
		write(file, [{ sessionId: "session" }, { ...message(), tokens: undefined }, message()], true);
		writeFileSync(file, "\n{truncated", { flag: "a" });
		const state = newUsageState();
		collectGeminiUsage(state, home);
		expect([...state.records.values()][0].counts.outputTokens).toBe(150);
	});

	it("includes legacy checkpoint messages without removing costs after conversation rewinds", () => {
		write(path("session-one.jsonl"), [
			{ sessionId: "session" }, message("one"), { $rewindTo: "one" },
			{ $set: { messages: [message("two")] } },
		], true);
		const state = newUsageState();
		collectGeminiUsage(state, home);
		expect(state.records.size).toBe(2);
	});

	it("honors GEMINI_CLI_HOME as the home above .gemini", () => {
		write(path(), { sessionId: "default", messages: [message()] });
		const configuredHome = join(home, "configured-home");
		vi.stubEnv("GEMINI_CLI_HOME", configuredHome);
		write(join(configuredHome, ".gemini", "tmp", "project", "chats", "session.json"), { sessionId: "configured", messages: [message()] });
		const state = newUsageState();
		collectGeminiUsage(state, home);
		expect([...state.records.keys()]).toEqual(['gemini:["configured","message"]']);
	});

	it("collects the official Seatbelt sandbox runtime root", () => {
		write(join(home, ".cache", ".gemini", "tmp", "project", "chats", "session.json"), { sessionId: "sandbox", messages: [message()] });
		const state = newUsageState();
		collectGeminiUsage(state, home);
		expect(state.records.size).toBe(1);
	});

	it("retains unknown model usage without inventing a model id", () => {
		write(path(), { sessionId: "session", messages: [{ ...message(), model: undefined }] });
		const state = newUsageState();
		collectGeminiUsage(state, home);
		expect([...state.records.values()][0].model).toBe("unknown");
	});

	it("ignores malformed records, non-model messages and unusable usage snapshots", () => {
		write(path(), { sessionId: "session", messages: [
			{ ...message("user"), type: "user" }, { ...message("bad-date"), timestamp: "bad" },
			message("negative", { input: -1, output: 10 }), message("string", { input: "100", output: 10 }),
			message("missing", { total: 999 }), { ...message(), id: undefined }, null,
			message("zero", { input: 0, output: 0 }),
		] });
		const state = newUsageState();
		collectGeminiUsage(state, home);
		expect(state.records.size).toBe(0);
	});

	it("skips sessions without stable session identity", () => {
		write(path(), { messages: [message()] });
		const state = newUsageState();
		collectGeminiUsage(state, home);
		expect(state.records.size).toBe(0);
	});

	it("does not retain conversation content or inspect unrelated Gemini JSON stores", () => {
		write(path(), { sessionId: "session", messages: [message()], summary: "private summary" });
		write(join(home, ".gemini", "oauth_creds.json"), { sessionId: "credentials", messages: [message("secret")] });
		write(join(home, ".gemini", "tmp", "project", "other.json"), { sessionId: "unrelated", messages: [message("other")] });
		const state = newUsageState();
		collectGeminiUsage(state, home);
		expect(JSON.stringify([...state.records])).not.toMatch(/private|secret|unrelated|summary|toolCalls|content/);
		expect(state.records.size).toBe(1);
	});

	it("returns safely for absent and malformed stores", () => {
		const state = newUsageState();
		collectGeminiUsage(state, home);
		mkdirSync(dirname(path()), { recursive: true });
		writeFileSync(path(), "{broken");
		collectGeminiUsage(state, home);
		expect(state.records.size).toBe(0);
	});
});
