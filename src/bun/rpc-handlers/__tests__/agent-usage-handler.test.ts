import { chmodSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../shared", () => ({
	log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("../../atomic-write", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../atomic-write")>();
	return { ...actual, atomicWriteFile: vi.fn(actual.atomicWriteFile) };
});

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

import { getAgentUsage, getTaskAgentUsage, isSubagentTranscript, taskStartedAt } from "../agent-usage";
import { taskDir } from "../../git";
import { log } from "../shared";
import { atomicWriteFile } from "../../atomic-write";
import type { Project, Task } from "../../../shared/types";
import { defaultAccountPaths } from "../../agent-accounts";
import { recordCursorHookUsage } from "../../usage-collectors/cursor";
import { buildClaudeUsageDays, buildCodexUsageDays } from "../agent-usage-parse";

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

describe("getAgentUsage incremental scan", () => {
	const DAY = 86_400_000;
	const claudeEntry = (id: string, timestamp: string, input = 1_000_000) => ({
		type: "assistant", requestId: id, timestamp,
		message: { id, model: "claude-sonnet-4-6", usage: { input_tokens: input } },
	});
	const totalInput = (days: { inputTokens: number }[]) => days.reduce((sum, d) => sum + d.inputTokens, 0);
	const claudeFile = (name: string) => join(tempRoot, "claude", "projects", "repo", name);
	/** Second-granular, so restoring it after a same-size rewrite reproduces the exact stat. */
	const setMtime = (path: string, ms: number) => utimesSync(path, Math.floor(ms / 1000), Math.floor(ms / 1000));
	const historyFile = () => join(tempRoot, ".dev3.0", "agent-usage-history-v1.json");

	it("does not read a transcript last written before the since day, and a full scan still does", async () => {
		const now = Date.now();
		// The stale file's record claims today, which only an unread file can keep out of the report.
		writeJsonl(claudeFile("stale.jsonl"), [claudeEntry("stale", new Date(now).toISOString())]);
		setMtime(claudeFile("stale.jsonl"), now - 10 * DAY);
		writeJsonl(claudeFile("live.jsonl"), [claudeEntry("live", new Date(now).toISOString())]);
		expect(totalInput((await getAgentUsage({ since: new Date(now - 2 * DAY).toISOString() })).days)).toBe(1_000_000);
		expect(totalInput((await getAgentUsage()).days)).toBe(2_000_000);
	});

	it("reads a file written on the since day before the since time, with every day it holds", async () => {
		const today = new Date();
		const midnight = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
		const old = new Date(midnight - 30 * DAY + 3_600_000).toISOString();
		const early = new Date(midnight + 60_000).toISOString();
		writeJsonl(claudeFile("early.jsonl"), [claudeEntry("old", old), claudeEntry("early", early)]);
		setMtime(claudeFile("early.jsonl"), midnight + 120_000);
		const report = await getAgentUsage({ since: new Date(midnight + 12 * 3_600_000).toISOString() });
		expect(report.days.map((d) => d.startMs)).toEqual([new Date(Date.parse(old)).setHours(0, 0, 0, 0), midnight]);
	});

	it("ignores an unparseable since and scans everything", async () => {
		writeJsonl(claudeFile("a.jsonl"), [claudeEntry("a", "2026-10-20T12:00:00Z")]);
		setMtime(claudeFile("a.jsonl"), Date.parse("2026-10-20T12:00:00Z"));
		expect(totalInput((await getAgentUsage({ since: "not a date" })).days)).toBe(1_000_000);
	});

	it("skips an unchanged transcript on a repeat scan and re-reads one that grew", async () => {
		const at = Date.parse("2026-10-20T12:00:00Z");
		writeJsonl(claudeFile("done.jsonl"), [claudeEntry("done", "2026-10-20T12:00:00Z", 1_000_000)]);
		setMtime(claudeFile("done.jsonl"), at);
		writeJsonl(claudeFile("live.jsonl"), [claudeEntry("live", "2026-10-20T12:00:00Z")]);
		expect(totalInput((await getAgentUsage()).days)).toBe(2_000_000);

		// Same size and mtime: a cache hit never sees the new count.
		writeJsonl(claudeFile("done.jsonl"), [claudeEntry("done", "2026-10-20T12:00:00Z", 9_000_000)]);
		setMtime(claudeFile("done.jsonl"), at);
		writeFileSync(claudeFile("live.jsonl"), `\n${JSON.stringify(claudeEntry("more", "2026-10-20T13:00:00Z"))}`, { flag: "a" });
		expect(totalInput((await getAgentUsage()).days)).toBe(3_000_000);
	});

	it("rescans everything once the history file is removed", async () => {
		const at = Date.parse("2026-10-20T12:00:00Z");
		writeJsonl(claudeFile("done.jsonl"), [claudeEntry("done", "2026-10-20T12:00:00Z", 1_000_000)]);
		setMtime(claudeFile("done.jsonl"), at);
		expect(totalInput((await getAgentUsage()).days)).toBe(1_000_000);
		rmSync(historyFile());
		writeJsonl(claudeFile("done.jsonl"), [claudeEntry("done", "2026-10-20T12:00:00Z", 9_000_000)]);
		setMtime(claudeFile("done.jsonl"), at);
		expect(totalInput((await getAgentUsage()).days)).toBe(9_000_000);
	});

	it("does not cache when the history cannot be kept", async () => {
		const at = Date.parse("2026-10-20T12:00:00Z");
		mkdirSync(dirname(historyFile()), { recursive: true });
		writeFileSync(historyFile(), JSON.stringify({ version: 99 }));
		writeJsonl(claudeFile("done.jsonl"), [claudeEntry("done", "2026-10-20T12:00:00Z", 1_000_000)]);
		setMtime(claudeFile("done.jsonl"), at);
		expect(totalInput((await getAgentUsage()).days)).toBe(1_000_000);
		writeJsonl(claudeFile("done.jsonl"), [claudeEntry("done", "2026-10-20T12:00:00Z", 9_000_000)]);
		setMtime(claudeFile("done.jsonl"), at);
		expect(totalInput((await getAgentUsage()).days)).toBe(9_000_000);
	});

	it("reports the same days cold, warm, and after a full rescan, matching a plain fold of every file", async () => {
		const snapshot = (output: number) => ({
			type: "assistant", requestId: "dup", timestamp: "2026-10-21T09:00:00Z",
			message: { id: "dup", model: "claude-sonnet-4-6", usage: { input_tokens: 10, output_tokens: output } },
		});
		const claude = {
			"a.jsonl": [claudeEntry("a1", "2026-10-20T12:00:00Z"), snapshot(5), "{truncated"],
			"b.jsonl": [snapshot(50), claudeEntry("b1", "2026-10-21T12:00:00Z", 300)],
			"b/subagents/agent-1.jsonl": [claudeEntry("sub", "2026-10-22T08:00:00Z", 70)],
		};
		for (const [name, entries] of Object.entries(claude)) writeJsonl(claudeFile(name), entries);
		const usage = (input: number, output: number) => ({ input_tokens: input, output_tokens: output });
		const codex = [
			{ type: "session_meta", payload: { id: "s" } },
			{ type: "turn_context", payload: { model: "gpt-5.1-codex" } },
			{ type: "event_msg", timestamp: "2026-10-21T10:00:00Z", payload: { type: "token_count", info: { last_token_usage: usage(100, 10), total_token_usage: usage(100, 10) } } },
			{ type: "event_msg", timestamp: "2026-10-21T10:00:01Z", payload: { type: "token_count", info: { last_token_usage: usage(100, 10), total_token_usage: usage(100, 10) } } },
			{ type: "event_msg", timestamp: "2026-10-22T10:00:00Z", payload: { type: "token_count", info: { last_token_usage: usage(40, 4), total_token_usage: usage(140, 14) } } },
		];
		writeJsonl(join(tempRoot, "codex", "sessions", "2026", "rollout-s.jsonl"), codex);

		const tokens = (days: { date: string; source: string; inputTokens: number; outputTokens: number }[]) =>
			days.map(({ date, source, inputTokens, outputTokens }) => ({ date, source, inputTokens, outputTokens }));
		const plain = [
			...buildClaudeUsageDays(Object.values(claude).flat()).days,
			...buildCodexUsageDays(codex).days,
		].sort((a, b) => a.startMs - b.startMs || a.source.localeCompare(b.source));

		const cold = (await getAgentUsage()).days;
		expect(tokens(cold)).toEqual(tokens(plain));
		expect((await getAgentUsage()).days).toEqual(cold);
		rmSync(historyFile());
		expect((await getAgentUsage()).days).toEqual(cold);
	});

	it("still counts skipped transcripts when a warm scan cannot keep the history", async () => {
		const at = Date.parse("2026-10-20T12:00:00Z");
		writeJsonl(claudeFile("old.jsonl"), [claudeEntry("old", "2026-10-20T12:00:00Z")]);
		setMtime(claudeFile("old.jsonl"), at);
		writeJsonl(claudeFile("live.jsonl"), [claudeEntry("live", "2026-10-20T12:00:00Z")]);
		expect(totalInput((await getAgentUsage()).days)).toBe(2_000_000);
		writeFileSync(claudeFile("live.jsonl"), `\n${JSON.stringify(claudeEntry("more", "2026-10-20T13:00:00Z"))}`, { flag: "a" });
		// The lock is held and the history read, but the write fails (ENOSPC, EROFS…).
		vi.mocked(atomicWriteFile).mockRejectedValueOnce(new Error("ENOSPC"));
		expect(totalInput((await getAgentUsage()).days)).toBe(3_000_000);
	});

	it("still counts skipped transcripts when the history cannot even be locked", async () => {
		const at = Date.parse("2026-10-20T12:00:00Z");
		writeJsonl(claudeFile("old.jsonl"), [claudeEntry("old", "2026-10-20T12:00:00Z")]);
		setMtime(claudeFile("old.jsonl"), at);
		writeJsonl(claudeFile("live.jsonl"), [claudeEntry("live", "2026-10-20T12:00:00Z")]);
		expect(totalInput((await getAgentUsage()).days)).toBe(2_000_000);
		writeFileSync(claudeFile("live.jsonl"), `\n${JSON.stringify(claudeEntry("more", "2026-10-20T13:00:00Z"))}`, { flag: "a" });
		const dev3Home = dirname(historyFile());
		chmodSync(dev3Home, 0o555);
		try {
			expect(totalInput((await getAgentUsage()).days)).toBe(3_000_000);
		} finally {
			chmodSync(dev3Home, 0o755);
		}
	});

	it("re-reads a transcript whose read failed once it becomes readable", async () => {
		const at = Date.parse("2026-10-20T12:00:00Z");
		writeJsonl(claudeFile("a.jsonl"), [claudeEntry("a", "2026-10-20T12:00:00Z")]);
		writeJsonl(claudeFile("b.jsonl"), [claudeEntry("b", "2026-10-20T12:00:00Z")]);
		setMtime(claudeFile("b.jsonl"), at);
		chmodSync(claudeFile("b.jsonl"), 0o000);
		try {
			expect(totalInput((await getAgentUsage()).days)).toBe(1_000_000);
		} finally {
			chmodSync(claudeFile("b.jsonl"), 0o644);
		}
		expect(totalInput((await getAgentUsage()).days)).toBe(2_000_000);
	});

	it("rescans in full when the history is removed while a warm scan runs", async () => {
		const at = Date.parse("2026-10-20T12:00:00Z");
		writeJsonl(claudeFile("old.jsonl"), [claudeEntry("old", "2026-10-20T12:00:00Z")]);
		setMtime(claudeFile("old.jsonl"), at);
		writeJsonl(claudeFile("live.jsonl"), [claudeEntry("live", "2026-10-20T12:00:00Z")]);
		expect(totalInput((await getAgentUsage()).days)).toBe(2_000_000);
		writeFileSync(claudeFile("live.jsonl"), `\n${JSON.stringify(claudeEntry("more", "2026-10-20T13:00:00Z"))}`, { flag: "a" });
		const scan = getAgentUsage();
		rmSync(historyFile());
		expect(totalInput((await scan).days)).toBe(3_000_000);
		expect(totalInput((await getAgentUsage()).days)).toBe(3_000_000);
		const history = JSON.parse(readFileSync(historyFile(), "utf8"));
		expect(history.claude).toHaveLength(3);
	});

	it("reads a managed account store that links onto the home store once", async () => {
		registerAccounts(["linked"], ["linked"]);
		const accountsDir = defaultAccountPaths().accountsDir;
		writeJsonl(claudeFile("a.jsonl"), [claudeEntry("a", "2026-10-20T12:00:00Z")]);
		writeJsonl(join(tempRoot, "codex", "sessions", "rollout-a.jsonl"), [
			{ type: "token_usage_record", timestamp: "2026-10-20T12:00:00Z", payload: { response_id: "c", usage: { input_tokens: 5, output_tokens: 0 } } },
		]);
		mkdirSync(join(accountsDir, "claude", "linked"), { recursive: true });
		symlinkSync(join(tempRoot, "claude", "projects"), join(accountsDir, "claude", "linked", "projects"));
		mkdirSync(join(accountsDir, "codex", "linked"), { recursive: true });
		symlinkSync(join(tempRoot, "codex", "sessions"), join(accountsDir, "codex", "linked", "sessions"));
		vi.mocked(log.info).mockClear();
		await getAgentUsage();
		expect(log.info).toHaveBeenCalledWith("getAgentUsage computed", expect.objectContaining({ claudeFiles: 1, codexFiles: 1 }));
	});

	it("lets a caller join a scan of the same window that is still running", async () => {
		const since = new Date().toISOString();
		const scans = [getAgentUsage({ since }), getAgentUsage({ since: new Date().toISOString() }), getAgentUsage(), getAgentUsage()];
		expect(scans[0]).toBe(scans[1]);
		expect(scans[2]).toBe(scans[3]);
		expect(scans[0]).not.toBe(scans[2]);
		await Promise.all(scans);
		expect(getAgentUsage()).not.toBe(scans[2]);
		await getAgentUsage();
	});
});

describe("getTaskAgentUsage", () => {
	// An underscore and a space: Claude Code turns both into "-" in the store name.
	const project = { id: "p1", path: "/repo/my_app v2", kind: "git" } as Project;
	const task = { id: "abcdef12-0000-0000-0000-000000000000", seq: 7, title: "Fix it", status: "completed" } as Task;
	const SESSION = "11111111-2222-3333-4444-555555555555";
	const claudeLine = (id: string, usage: Record<string, unknown>, model = "claude-opus-4-8", timestamp = "2026-10-20T12:00:00Z") => ({
		type: "assistant", requestId: id, timestamp, message: { id, model, usage },
	});
	const codexRollout = (cwd: string, id: string) => [
		{ type: "session_meta", payload: { id: "c", cwd } },
		{ type: "turn_context", payload: { model: "mystery-codex" } },
		{ type: "token_usage_record", timestamp: "2026-10-21T12:00:00Z", payload: { response_id: id, usage: { input_tokens: 40, output_tokens: 2, cache_write_input_tokens: 4 } } },
	];
	const dumpDir = () => join(taskDir(project, task), "conversations");
	const writeDump = (name: string) => {
		mkdirSync(dumpDir(), { recursive: true });
		writeFileSync(join(dumpDir(), name), JSON.stringify({ stats: { usage: { input: 1, output: 99, cacheRead: 0, cacheWrite: 0 } } }));
	};

	it("reads the Stats page's stores (CLAUDE_CONFIG_DIR, CODEX_HOME incl. archived_sessions), subagents included, splitting only TTL-tagged cache writes", async () => {
		const workingDir = `${taskDir(project, task)}/worktree`;
		const store = join(tempRoot, "claude", "projects", workingDir.replace(/[^a-zA-Z0-9]/g, "-"));
		writeJsonl(join(store, `${SESSION}.jsonl`), [
			claudeLine("m1", { input_tokens: 1_000_000, output_tokens: 10 }),
			claudeLine("m1", { input_tokens: 1_000_000, output_tokens: 1_000_000 }),
			claudeLine("m2", { cache_creation_input_tokens: 300, cache_creation: { ephemeral_5m_input_tokens: 100, ephemeral_1h_input_tokens: 200 }, cache_read_input_tokens: 50 }),
		]);
		writeJsonl(join(store, SESSION, "subagents", "agent-a.jsonl"), [claudeLine("s1", { output_tokens: 1_000_000 })]);
		writeJsonl(join(tempRoot, "claude", "projects", "-elsewhere", "other.jsonl"), [claudeLine("x", { input_tokens: 9 })]);
		writeJsonl(join(tempRoot, "codex", "sessions", "2026", "rollout-a.jsonl"), codexRollout(workingDir, "c1"));
		writeJsonl(join(tempRoot, "codex", "archived_sessions", "rollout-b.jsonl"), codexRollout(workingDir, "c2"));
		writeJsonl(join(tempRoot, "codex", "sessions", "rollout-other.jsonl"), codexRollout("/elsewhere", "c3"));

		const report = await getTaskAgentUsage(project, task);

		expect(report).toMatchObject({ taskId: task.id, seq: 7, workingDir, worktreeExists: false });
		expect(report.totals).toMatchObject({
			messages: 5, inputTokens: 1_000_072, outputTokens: 2_000_004,
			cacheWriteTokens: 308, cacheWrite5mTokens: 100, cacheWrite1hTokens: 200, cacheReadTokens: 50, fullyPriced: false,
		});
		expect(report.models.map((m) => m.model)).toEqual(["claude-opus-4-8", "mystery-codex"]);
		expect(report.models[1]).toMatchObject({ messages: 2, cacheWriteTokens: 8, cacheWrite5mTokens: 0, costUsd: 0, fullyPriced: false });
		expect(report.coverage).toMatchObject({
			transcriptFiles: 4, subagentTranscriptFiles: 1, uncoveredArchivedSessions: 0, sharedWorkingDir: false,
			sources: ["claude", "codex"], firstAt: "2026-10-20T12:00:00.000Z", lastAt: "2026-10-21T12:00:00.000Z",
		});
	});

	it("reports Claude/Codex archived sessions whose transcript is gone, and other agents' apart, pricing neither", async () => {
		writeDump(`claude-${SESSION}.json`);
		writeDump("codex-no-session.json");
		writeDump("cursor-99999999-2222-3333-4444-555555555555.json");

		const report = await getTaskAgentUsage(project, task);

		expect(report.models).toEqual([]);
		expect(report.totals).toMatchObject({ messages: 0, costUsd: 0, fullyPriced: true });
		expect(report.coverage).toMatchObject({ transcriptFiles: 0, uncoveredArchivedSessions: 2, unsupportedArchivedSessions: 1, sources: [] });
	});

	it("charges an Operations task on a user-chosen folder only for usage between its launch and its end", async () => {
		const ops = { id: "ops", path: "/ops", kind: "virtual" } as Project;
		const opsTask = {
			...task, opsWorkDir: "/Users/me/Downloads", createdAt: "2026-10-18T00:00:00Z",
			statusEnteredAt: "2026-10-21T00:00:00Z", status: "completed",
			movements: [
				{ id: "m0", at: "2026-10-18T00:00:00Z", kind: "created", to: "todo" },
				{ id: "m1", at: "2026-10-20T00:00:00Z", kind: "status", from: "todo", to: "in-progress" },
			],
		} as Task;
		const store = join(tempRoot, "claude", "projects", "-Users-me-Downloads");
		writeJsonl(join(store, "earlier.jsonl"), [claudeLine("before", { input_tokens: 5 }, "claude-opus-4-8", "2026-10-19T12:00:00Z")]);
		writeJsonl(join(store, `${SESSION}.jsonl`), [claudeLine("during", { input_tokens: 7 }, "claude-opus-4-8", "2026-10-20T12:00:00Z")]);
		writeJsonl(join(store, "later.jsonl"), [claudeLine("after", { input_tokens: 11 }, "claude-opus-4-8", "2026-10-22T12:00:00Z")]);

		const report = await getTaskAgentUsage(ops, opsTask);

		expect(report.workingDir).toBe("/Users/me/Downloads");
		expect(report.totals).toMatchObject({ messages: 1, inputTokens: 7 });
		expect(report.coverage.sharedWorkingDir).toBe(true);
	});

	it("matches stores and rollouts recorded under the physical path of a symlinked folder", async () => {
		const real = join(tempRoot, "real-folder");
		const link = join(tempRoot, "linked-folder");
		mkdirSync(real, { recursive: true });
		symlinkSync(real, link);
		const physical = realpathSync(real);
		const ops = { id: "ops", path: "/ops", kind: "virtual" } as Project;
		const opsTask = { ...task, opsWorkDir: link, createdAt: "2026-10-01T00:00:00Z", status: "in-progress" } as Task;
		writeJsonl(join(tempRoot, "claude", "projects", physical.replace(/[^a-zA-Z0-9]/g, "-"), `${SESSION}.jsonl`), [claudeLine("m1", { input_tokens: 5 })]);
		writeJsonl(join(tempRoot, "codex", "sessions", "rollout-p.jsonl"), codexRollout(physical, "c1"));

		const report = await getTaskAgentUsage(ops, opsTask);

		expect(report.coverage.sources).toEqual(["claude", "codex"]);
		expect(report.totals.messages).toBe(2);
	});

	it("counts conversations the task's panes resumed from another folder, from the task's launch only", async () => {
		const CODEX_SESSION = "66666666-7777-8888-9999-000000000000";
		const resumedTask = {
			...task, status: "in-progress", createdAt: "2026-10-20T00:00:00Z",
			sessionState: { panes: [
				{ agentCmd: "claude", sessionId: SESSION, agentId: null, configId: null, sessionOriginCwd: "/elsewhere" },
				{ agentCmd: "codex", sessionId: CODEX_SESSION, agentId: null, configId: null },
				{ agentCmd: "claude", sessionId: "../escape", agentId: null, configId: null },
			] },
		} as Task;
		const elsewhere = join(tempRoot, "claude", "projects", "-elsewhere");
		writeJsonl(join(elsewhere, `${SESSION}.jsonl`), [
			claudeLine("old", { input_tokens: 1000 }, "claude-opus-4-8", "2026-10-19T12:00:00Z"),
			claudeLine("new", { input_tokens: 7 }, "claude-opus-4-8", "2026-10-21T12:00:00Z"),
		]);
		writeJsonl(join(elsewhere, SESSION, "subagents", "agent-a.jsonl"), [claudeLine("sub", { input_tokens: 3 }, "claude-opus-4-8", "2026-10-21T13:00:00Z")]);
		writeJsonl(join(elsewhere, "unrelated.jsonl"), [claudeLine("other", { input_tokens: 500 }, "claude-opus-4-8", "2026-10-21T12:00:00Z")]);
		const rollout = codexRollout("/elsewhere", "c-new");
		rollout.push({ type: "token_usage_record", timestamp: "2026-10-19T12:00:00Z", payload: { response_id: "c-old", usage: { input_tokens: 900, output_tokens: 0 } } } as never);
		writeJsonl(join(tempRoot, "codex", "sessions", `rollout-2026-10-21T00-00-00-${CODEX_SESSION}.jsonl`), rollout);

		const report = await getTaskAgentUsage(project, resumedTask);

		expect(report.totals).toMatchObject({ messages: 3, inputTokens: 7 + 3 + 36 });
		expect(report.coverage).toMatchObject({ transcriptFiles: 3, subagentTranscriptFiles: 1, resumedTranscriptFiles: 3, sources: ["claude", "codex"] });
	});

	it("starts the lifetime window at the first launch, falling back to creation", () => {
		const base = { ...task, createdAt: "2026-10-18T00:00:00Z" } as Task;
		const launched = { ...base, movements: [
			{ id: "a", at: "2026-10-18T00:00:00Z", kind: "created", to: "todo" },
			{ id: "b", at: "2026-10-20T00:00:00Z", kind: "status", from: "todo", to: "in-progress" },
		] } as Task;
		expect(taskStartedAt(launched)).toBe(Date.parse("2026-10-20T00:00:00Z"));
		expect(taskStartedAt({ ...launched, movementsDropped: 3 } as Task)).toBe(Date.parse(base.createdAt));
		expect(taskStartedAt(base)).toBe(Date.parse(base.createdAt));
		const scratch = { ...base, movements: [{ id: "a", at: base.createdAt, kind: "created", to: "user-questions" }] } as Task;
		expect(taskStartedAt(scratch)).toBe(Date.parse(base.createdAt));
	});

	it("recognises a subagent transcript on either separator", () => {
		expect(isSubagentTranscript("C:\\Users\\a\\.claude\\projects\\x\\s\\subagents\\agent-a.jsonl")).toBe(true);
		expect(isSubagentTranscript("/h/.claude/projects/x/s/subagents/agent-a.jsonl")).toBe(true);
		expect(isSubagentTranscript("/h/.claude/projects/subagents-repo/s.jsonl")).toBe(false);
	});
});
