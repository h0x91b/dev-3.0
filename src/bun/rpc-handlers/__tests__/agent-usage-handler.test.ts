import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../shared", () => ({
	log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("../../rate-limit-monitor", () => ({
	getAgentRateLimitsReport: vi.fn(),
}));

const testHome = vi.hoisted(() => {
	const home = `${process.env.HOME}/agent-usage-${process.pid}-${Math.random().toString(36).slice(2)}`;
	vi.stubEnv("DEV3_HOME", `${home}/.dev3.0`);
	return home;
});
vi.mock("node:os", async (importOriginal) => ({
	...await importOriginal<typeof import("node:os")>(),
	homedir: () => testHome,
}));

import { getAgentUsage } from "../agent-usage";
import { defaultAccountPaths } from "../../agent-accounts";

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
	tempRoot = testHome;
	mkdirSync(tempRoot, { recursive: true });
	vi.stubEnv("CLAUDE_CONFIG_DIR", join(tempRoot, "claude"));
	vi.stubEnv("CODEX_HOME", join(tempRoot, "codex"));
});

afterEach(() => {
	vi.unstubAllEnvs();
	rmSync(tempRoot, { recursive: true, force: true });
});

describe("getAgentUsage", () => {
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
