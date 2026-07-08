import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../shared", () => ({
	log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("../../rate-limit-monitor", () => ({
	getAgentRateLimitsReport: vi.fn(),
}));

import { getAgentUsage } from "../agent-usage";

let tempRoot: string;

function writeJsonl(path: string, entries: unknown[]): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, entries.map((entry) => JSON.stringify(entry)).join("\n"));
}

beforeEach(() => {
	tempRoot = mkdtempSync(join(tmpdir(), "dev3-agent-usage-"));
	vi.stubEnv("CLAUDE_CONFIG_DIR", join(tempRoot, "claude"));
	vi.stubEnv("CODEX_HOME", join(tempRoot, "codex"));
});

afterEach(() => {
	vi.unstubAllEnvs();
	rmSync(tempRoot, { recursive: true, force: true });
});

describe("getAgentUsage", () => {
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
