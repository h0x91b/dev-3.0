import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { newUsageState } from "../../rpc-handlers/agent-usage-parse";
import { collectCopilotUsage } from "../copilot";

const START = Date.parse("2026-09-30T20:00:00Z");
const TIME = "2026-09-30T21:00:00Z";
const usage = (input = 100, output = 30) => ({ inputTokens: input, outputTokens: output, cacheReadTokens: 40, cacheWriteTokens: 10 });
const shutdown = (id = "shutdown-1", input = 100, output = 30, timestamp = TIME, start = START) => ({
	type: "session.shutdown", id, timestamp,
	data: { sessionStartTime: start, totalPremiumRequests: 3, totalNanoAiu: 9e9,
		modelMetrics: { "claude-sonnet-4.6": { usage: usage(input, output), requests: { count: 3, cost: 2 }, totalNanoAiu: 9e9 } } },
});

describe("Copilot CLI durable usage", () => {
	let home: string;
	beforeEach(() => { home = mkdtempSync(join(tmpdir(), "dev3-copilot-usage-")); });
	afterEach(() => { rmSync(home, { recursive: true, force: true }); });

	function write(events: unknown[], directory = "session-1", tail = ""): void {
		const root = join(home, "session-state", directory);
		mkdirSync(root, { recursive: true });
		writeFileSync(join(root, "events.jsonl"), events.map((event) => JSON.stringify(event)).join("\n") + tail);
	}

	it("collects all token categories without treating premium credits as USD", () => {
		write([shutdown()]);
		const state = newUsageState();
		collectCopilotUsage(state, home);
		expect([...state.records.values()]).toEqual([{
			model: "claude-sonnet-4.6", timestamp: Date.parse(TIME), cumulativeScope: JSON.stringify(["session-1", START, "claude-sonnet-4.6"]), counts: {
				inputTokens: 50, outputTokens: 30, cacheReadInputTokens: 40, cacheCreationInputTokens: 10,
			},
		}]);
	});

	it("prefers the explicit billed token breakdown when available", () => {
		const event = shutdown();
		Object.assign(event.data.modelMetrics["claude-sonnet-4.6"], {
			tokenDetails: { input: { tokenCount: 4 }, output: { tokenCount: 7 }, cache_read: { tokenCount: 8 }, cache_write: { tokenCount: 9 } },
		});
		write([event]);
		const state = newUsageState();
		collectCopilotUsage(state, home);
		expect([...state.records.values()][0].counts).toEqual({
			inputTokens: 4, outputTokens: 7, cacheReadInputTokens: 8, cacheCreationInputTokens: 9,
		});
	});

	it("counts each model once rather than adding duplicated agent subtotals", () => {
		const event = shutdown();
		Object.assign(event.data.modelMetrics, { "gpt-5.4": { usage: usage(200, 60) } });
		Object.assign(event.data, { agentMetrics: { main: { modelMetrics: event.data.modelMetrics } } });
		write([event]);
		const state = newUsageState();
		collectCopilotUsage(state, home);
		expect([...state.records.values()].map((record) => [record.model, record.counts.outputTokens])).toEqual([
			["claude-sonnet-4.6", 30], ["gpt-5.4", 60],
		]);
	});

	it("preserves cumulative snapshots with their own timestamps for retained-history deltas", () => {
		write([shutdown(), shutdown("shutdown-2", 140, 50, "2026-10-01T01:00:00Z")]);
		const state = newUsageState();
		collectCopilotUsage(state, home);
		expect([...state.records.values()].map((record) => [record.timestamp, record.counts.inputTokens, record.counts.outputTokens])).toEqual([
			[Date.parse(TIME), 50, 30], [Date.parse("2026-10-01T01:00:00Z"), 90, 50],
		]);
	});

	it("counts a resumed older-runtime segment separately when its accounting start resets", () => {
		write([shutdown(), shutdown("shutdown-2", 100, 30, "2026-10-01T01:00:00Z", START + 100_000)]);
		const state = newUsageState();
		collectCopilotUsage(state, home);
		expect([...state.records.values()].reduce((sum, record) => sum + record.counts.outputTokens, 0)).toBe(60);
	});

	it("reads modern durable accounting checkpoints in the same cumulative scope as shutdown", () => {
		const checkpoint = {
			type: "session.usage_checkpoint", id: "checkpoint-1", timestamp: TIME,
			data: { totalNanoAiu: 9e9, accountingSnapshot: { sessionStartTime: new Date(START).toISOString(), modelMetrics: shutdown().data.modelMetrics } },
		};
		write([checkpoint, shutdown("shutdown-2", 100, 30, "2026-10-01T01:00:00Z")]);
		const state = newUsageState();
		collectCopilotUsage(state, home);
		expect([...state.records.values()].map((record) => [record.counts.outputTokens, record.cumulativeScope])).toEqual([
			[30, JSON.stringify(["session-1", START, "claude-sonnet-4.6"])],
			[30, JSON.stringify(["session-1", START, "claude-sonnet-4.6"])],
		]);
	});

	it("deduplicates repeated scans and copied session logs by native session and event IDs", () => {
		const events = [{ type: "session.start", data: { sessionId: "native-session" } }, shutdown(), shutdown()];
		write(events);
		write(events, "copied-session");
		const state = newUsageState();
		collectCopilotUsage(state, home);
		collectCopilotUsage(state, home);
		expect(state.records.size).toBe(1);
	});

	it("ignores context occupancy, message output, and ephemeral per-call usage", () => {
		write([
			{ type: "session.usage_info", timestamp: TIME, data: { currentTokens: 10_000, tokenLimit: 100_000 } },
			{ type: "assistant.message", timestamp: TIME, data: { outputTokens: 300 } },
			{ type: "assistant.usage", timestamp: TIME, data: { model: "gpt-5.4", ...usage() } },
		]);
		const state = newUsageState();
		collectCopilotUsage(state, home);
		expect(state.records.size).toBe(0);
	});

	it("tolerates malformed lines, missing sessions, and incomplete usage checkpoints", () => {
		write([{ type: "session.shutdown", timestamp: "invalid", data: shutdown().data },
			{ type: "session.usage_checkpoint", timestamp: TIME, data: { totalNanoAiu: 9e9 } }, shutdown()], "valid", "\n{\"type\":");
		mkdirSync(join(home, "session-state", "missing-log"));
		const state = newUsageState();
		collectCopilotUsage(state, home);
		collectCopilotUsage(state, join(home, "missing-home"));
		expect(state.records.size).toBe(1);
	});

	it("does not add reasoning tokens already included in model output", () => {
		const event = shutdown();
		Object.assign(event.data.modelMetrics["claude-sonnet-4.6"].usage, { reasoningTokens: 20 });
		write([event]);
		const state = newUsageState();
		collectCopilotUsage(state, home);
		expect([...state.records.values()][0].counts.outputTokens).toBe(30);
	});
});
