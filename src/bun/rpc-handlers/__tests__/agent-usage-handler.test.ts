import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../shared", () => ({
	log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("../../rate-limit-monitor", () => ({
	getAgentRateLimitsReport: vi.fn(),
}));

const testHome = await vi.hoisted(async () => {
	const { mkdtempSync } = await import("node:fs");
	const { tmpdir } = await import("node:os");
	const { join } = await import("node:path");
	const home = mkdtempSync(join(tmpdir(), "agent-usage-"));
	vi.stubEnv("DEV3_HOME", `${home}/.dev3.0`);
	return home;
});
vi.mock("node:os", async (importOriginal) => ({
	...await importOriginal<typeof import("node:os")>(),
	homedir: () => testHome,
}));

import { getAgentUsage } from "../agent-usage";
import { defaultAccountPaths } from "../../agent-accounts";
import { recordCursorHookUsage } from "../../usage-collectors/cursor";

let tempRoot: string;

function writeJsonl(path: string, entries: unknown[]): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, entries.map((entry) => JSON.stringify(entry)).join("\n"));
}

function registerAccounts(claude: string[], codex: string[]): void {
	const dir = defaultAccountPaths().accountsDir;
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "accounts.json"), JSON.stringify({
		version: 1,
		claude: { activeId: null, accounts: claude.map((id) => ({ id })) },
		codex: { activeId: null, accounts: codex.map((id) => ({ id })) },
	}));
}

beforeEach(() => {
	vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline fixture")));
	tempRoot = testHome;
	mkdirSync(tempRoot, { recursive: true });
	vi.stubEnv("CLAUDE_CONFIG_DIR", join(tempRoot, "claude"));
	vi.stubEnv("CODEX_HOME", join(tempRoot, "codex"));
	vi.stubEnv("GEMINI_CLI_HOME", tempRoot);
	vi.stubEnv("COPILOT_HOME", join(tempRoot, ".copilot"));
	vi.stubEnv("XDG_DATA_HOME", join(tempRoot, "xdg-data"));
});

afterEach(() => {
	vi.unstubAllEnvs();
	vi.unstubAllGlobals();
	rmSync(tempRoot, { recursive: true, force: true });
});

describe("getAgentUsage", () => {
	it("merges all five runtimes and retains added collectors after their source files disappear", async () => {
		const timestamp = "2026-10-20T12:00:00Z";
		writeJsonl(join(tempRoot, "claude", "projects", "repo", "session.jsonl"), [{
			type: "assistant", requestId: "claude", timestamp,
			message: { id: "claude", model: "claude-sonnet-4-6", usage: { input_tokens: 1_000_000 } },
		}]);
		writeJsonl(join(tempRoot, "codex", "sessions", "rollout-session.jsonl"), [
			{ type: "turn_context", payload: { model: "gpt-6.1-sol" } },
			{ type: "token_usage_record", timestamp, payload: { response_id: "codex", usage: { input_tokens: 1_000_000, output_tokens: 0 } } },
		]);
		const geminiRoot = join(tempRoot, ".gemini");
		const geminiFile = join(geminiRoot, "tmp", "project", "chats", "session.json");
		mkdirSync(dirname(geminiFile), { recursive: true });
		writeFileSync(geminiFile, JSON.stringify({ sessionId: "gemini", messages: [{
			id: "message", type: "gemini", timestamp, model: "gemini-unpriced-fixture",
			tokens: { input: 1_000_000, output: 0 }, content: "private gemini text",
		}] }));
		writeJsonl(join(tempRoot, ".copilot", "session-state", "session", "events.jsonl"), [{
			id: "shutdown", type: "session.shutdown", timestamp, data: {
				sessionStartTime: Date.parse(timestamp) - 60_000,
				modelMetrics: { "gpt-6.1-sol": { usage: { inputTokens: 1_000_000, outputTokens: 0 } } },
			},
		}]);
		expect(recordCursorHookUsage({
			hook_event_name: "afterAgentResponse", conversation_id: "cursor", generation_id: "generation",
			model: "gpt-6.1-sol", input_tokens: 1_000_000, output_tokens: 0, text: "private cursor text",
		}, Date.parse(timestamp), join(tempRoot, ".dev3.0"))).toBe(true);
		const first = await getAgentUsage();
		expect(first.days.map((row) => row.source).sort()).toEqual(["claude", "codex", "copilot", "cursor", "gemini"]);
		expect(first.days.reduce((sum, row) => sum + row.inputTokens, 0)).toBe(5_000_000);
		expect(first.days.reduce((sum, row) => sum + row.costUsd, 0)).toBe(9);
		expect(first.hasUnpricedModels).toBe(true);
		for (const root of [geminiRoot, join(tempRoot, ".copilot"), join(tempRoot, ".dev3.0", "usage")]) rmSync(root, { recursive: true });
		expect((await getAgentUsage()).days).toEqual(first.days);
	});

	it("retains OpenCode, pi and omp usage, including managed agent dirs, after their stores disappear", async () => {
		const timestamp = "2026-10-20T12:00:00Z";
		const accountsDir = defaultAccountPaths().accountsDir;
		mkdirSync(accountsDir, { recursive: true });
		for (const kind of ["pi", "omp"]) {
			writeFileSync(join(accountsDir, `${kind}-accounts.json`), JSON.stringify({ version: 1, activeId: null, accounts: [{ id: "managed" }] }));
		}
		const assistant = (id: string) => ({
			type: "message", id, parentId: null, timestamp,
			message: { role: "assistant", provider: "openai", api: "openai-responses", model: "gpt-6.1-sol", content: "private text",
				usage: { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 1_000_000 }, timestamp: Date.parse(timestamp) },
		});
		writeJsonl(join(tempRoot, ".pi", "agent", "sessions", "--repo--", "a.jsonl"), [assistant("pi-default")]);
		writeJsonl(join(accountsDir, "pi", "managed", "sessions", "--repo--", "a.jsonl"), [assistant("pi-managed")]);
		writeJsonl(join(accountsDir, "omp", "managed", "sessions", "--repo--", "a.jsonl"), [assistant("omp-managed")]);
		const dbDir = join(tempRoot, "xdg-data", "opencode");
		mkdirSync(dbDir, { recursive: true });
		const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite");
		const db = new DatabaseSync(join(dbDir, "opencode.db"));
		db.exec(`CREATE TABLE message (id text, session_id text, time_created integer, time_updated integer, data text);
			CREATE TABLE part (id text, message_id text, session_id text, time_created integer, time_updated integer, data text);`);
		db.prepare("INSERT INTO message VALUES ('m', 's', 0, 0, ?)").run(JSON.stringify({ role: "assistant", modelID: "gpt-6.1-sol" }));
		db.prepare("INSERT INTO part VALUES ('p', 'm', 's', ?, 0, ?)").run(Date.parse(timestamp),
			JSON.stringify({ type: "step-finish", tokens: { input: 1_000_000, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } }));
		db.close();
		const first = await getAgentUsage();
		expect(first.days.map((row) => [row.source, row.inputTokens, row.costUsd]).sort()).toEqual([
			["omp", 1_000_000, 2], ["opencode", 1_000_000, 2], ["pi", 2_000_000, 4],
		]);
		for (const root of [join(tempRoot, ".pi"), join(accountsDir, "pi", "managed"), join(accountsDir, "omp", "managed"), dbDir]) {
			rmSync(root, { recursive: true });
		}
		expect((await getAgentUsage()).days).toEqual(first.days);
	});

	it("preserves catalog pricing identity after a routed model is renamed or replaced", async () => {
		const catalogFile = join(tempRoot, ".dev3.0", "model-catalog.json");
		mkdirSync(dirname(catalogFile), { recursive: true });
		const catalog = (modelId: string) => ({
			providers: [{ id: "router", kind: "openrouter", label: "OpenRouter" }],
			models: [{ id: "route", providerId: "router", name: "my-label", modelId }],
		});
		writeFileSync(catalogFile, JSON.stringify(catalog("openai/gpt-6.1-sol")));
		writeJsonl(join(tempRoot, "claude", "projects", "repo", "route.jsonl"), [{
			type: "assistant", requestId: "routed", timestamp: "2026-10-20T12:00:00Z",
			message: { id: "routed", model: "openrouter/my-label", usage: { input_tokens: 1_000_000 } },
		}]);
		expect((await getAgentUsage()).days[0].costUsd).toBe(2);
		writeFileSync(catalogFile, JSON.stringify(catalog("gpt-6-astra")));
		expect((await getAgentUsage()).days[0].costUsd).toBe(2);
		rmSync(catalogFile);
		expect((await getAgentUsage()).days[0]).toMatchObject({ costUsd: 2, fullyPriced: true });
	});

	it("reconciles a previously retained legacy echo when its native response arrives later", async () => {
		const file = join(tempRoot, "codex", "sessions", "rollout-upgraded.jsonl");
		const usage = { input_tokens: 1_000_000, output_tokens: 0 };
		const prefix = [
			{ type: "session_meta", payload: { id: "session" } },
			{ type: "turn_context", payload: { model: "gpt-6.1-sol" } },
			{ type: "event_msg", timestamp: "2026-10-20T12:00:00Z", payload: { type: "token_count", info: { last_token_usage: usage, total_token_usage: usage } } },
		];
		writeJsonl(file, prefix);
		expect((await getAgentUsage()).days[0].costUsd).toBe(2);
		writeJsonl(file, [...prefix, {
			type: "token_usage_record", timestamp: "2026-10-20T12:00:01Z",
			payload: { response_id: "native", usage, thread_token_usage: usage },
		}]);
		expect((await getAgentUsage()).days[0].costUsd).toBe(2);
		writeJsonl(file, prefix);
		expect((await getAgentUsage()).days[0].costUsd).toBe(2);
	});

	it("keeps accumulated usage when an older log disappears while new usage is added", async () => {
		const entry = (id: string, input: number) => ({
			type: "assistant", requestId: id, timestamp: "2026-10-20T12:00:00Z",
			message: { id, model: "claude-sonnet-4-6", usage: { input_tokens: input } },
		});
		const oldFile = join(tempRoot, "claude", "projects", "repo", "old.jsonl");
		const liveFile = join(tempRoot, "claude", "projects", "repo", "live.jsonl");
		writeJsonl(oldFile, [entry("old", 1_000_000)]);
		writeJsonl(liveFile, [entry("live", 1_000_000)]);
		expect((await getAgentUsage()).days[0].costUsd).toBe(6);
		rmSync(oldFile);
		writeJsonl(liveFile, [entry("live", 1_000_000), entry("new", 500_000)]);
		const next = await getAgentUsage();
		expect(next.days[0]).toMatchObject({ inputTokens: 2_500_000, costUsd: 7.5 });
		expect((await getAgentUsage()).days[0].costUsd).toBe(7.5);
		rmSync(liveFile);
		expect((await getAgentUsage()).days[0].costUsd).toBe(7.5);
	});

	it("retains archived Codex usage from default and managed homes without duplicating copied events", async () => {
		registerAccounts([], ["managed"]);
		const managed = join(defaultAccountPaths().accountsDir, "codex", "managed");
		const context = { type: "turn_context", payload: { model: "gpt-5.1-codex" } };
		const usage = (minute: string) => ({
			type: "event_msg", timestamp: `2026-07-01T12:${minute}:00Z`,
			payload: { type: "token_count", info: {
				last_token_usage: { input_tokens: 1_000_000, output_tokens: 0 },
				total_token_usage: { input_tokens: 1_000_000, output_tokens: 0 },
			} },
		});
		writeJsonl(join(tempRoot, "codex", "sessions", "rollout-copy.jsonl"), [context, usage("01")]);
		writeJsonl(join(tempRoot, "codex", "archived_sessions", "rollout-one.jsonl"), [context, usage("01")]);
		writeJsonl(join(managed, "archived_sessions", "rollout-two.jsonl"), [context, usage("02")]);
		const report = await getAgentUsage();
		expect(report.days).toHaveLength(1);
		expect(report.days[0]).toMatchObject({ inputTokens: 2_000_000, costUsd: 2.5 });
	});

	it("includes managed accounts and counts equal cumulative totals in independent rollouts", async () => {
		registerAccounts(["managed"], ["managed"]);
		const accountsDir = defaultAccountPaths().accountsDir;
		const claudeManaged = join(accountsDir, "claude", "managed");
		const codexManaged = join(accountsDir, "codex", "managed");
		const claude = {
			type: "assistant", requestId: "r", timestamp: "2026-07-01T12:00:00Z",
			message: { id: "m", model: "claude-sonnet-4-6", usage: { input_tokens: 1_000_000 } },
		};
		writeJsonl(join(tempRoot, "claude", "projects", "repo", "session.jsonl"), [claude]);
		writeJsonl(join(claudeManaged, "projects", "repo", "session.jsonl"), [claude, {
			...claude, requestId: "r2", message: { ...claude.message, id: "m2" },
		}]);
		for (const [home, minute] of [[join(tempRoot, "codex"), "01"], [codexManaged, "02"]]) {
			writeJsonl(join(home, "sessions", "rollout-test.jsonl"), [
				{ type: "turn_context", payload: { model: "gpt-5.1-codex" } },
				{
					type: "event_msg", timestamp: `2026-07-01T12:${minute}:00Z`,
					payload: { type: "token_count", info: {
						last_token_usage: { input_tokens: 1_000_000 }, total_token_usage: { input_tokens: 1_000_000, output_tokens: 0 },
					} },
				},
			]);
		}
		const report = await getAgentUsage();
		expect(report.days).toHaveLength(2);
		expect(report.days[0]).toMatchObject({ source: "claude", inputTokens: 2_000_000, costUsd: 6 });
		expect(report.days[1]).toMatchObject({ source: "codex", inputTokens: 2_000_000, costUsd: 2.5 });
	});

	it("merges Claude transcripts and Codex rollouts into one source-tagged feed", async () => {
		writeJsonl(join(tempRoot, "claude", "projects", "repo", "session.jsonl"), [
			{
				type: "assistant",
				requestId: "request-1",
				timestamp: "2026-07-01T12:00:00Z",
				message: { id: "message-1", model: "claude-sonnet-4-6", usage: { input_tokens: 1_000_000 } },
			},
		]);
		writeJsonl(join(tempRoot, "codex", "sessions", "2026", "07", "01", "rollout-test.jsonl"), [
			{ type: "turn_context", timestamp: "2026-07-01T12:00:00Z", payload: { model: "gpt-5.1-codex" } },
			{
				type: "event_msg",
				timestamp: "2026-07-01T12:05:00Z",
				payload: {
					type: "token_count",
					info: {
						last_token_usage: { input_tokens: 1_500_000, cached_input_tokens: 500_000, output_tokens: 1_000_000 },
						total_token_usage: { input_tokens: 20_000_000, cached_input_tokens: 10_000_000, output_tokens: 5_000_000 },
					},
				},
			},
		]);
		writeJsonl(join(tempRoot, "codex", "sessions", "2026", "07", "01", "ignored.jsonl"), [
			{ type: "event_msg", timestamp: "2026-07-01T12:10:00Z", payload: { type: "token_count", info: { last_token_usage: { input_tokens: 99 } } } },
		]);

		const report = await getAgentUsage();

		expect(report.days).toHaveLength(2);
		expect(report.days[0]).toMatchObject({ source: "claude", inputTokens: 1_000_000, costUsd: 3, fullyPriced: true });
		expect(report.days[1]).toMatchObject({
			source: "codex",
			inputTokens: 1_000_000,
			outputTokens: 1_000_000,
			cacheReadInputTokens: 500_000,
			costUsd: 11.3125,
			fullyPriced: true,
		});
		expect(report.hasUnpricedModels).toBe(false);
	});

	it("returns an empty report when both local agent directories are absent", async () => {
		const report = await getAgentUsage();
		expect(report.days).toEqual([]);
		expect(report.hasUnpricedModels).toBe(false);
	});
});
