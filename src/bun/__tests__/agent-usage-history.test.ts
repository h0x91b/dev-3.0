import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const historyHome = vi.hoisted(() => {
	const path = `${process.env.HOME}/usage-history-${process.pid}-${Math.random().toString(36).slice(2)}`;
	vi.stubEnv("DEV3_HOME", path);
	return path;
});
import { retainUsageHistory } from "../agent-usage-history";
import { finalizeUsage, foldClaudeEntry, newUsageState } from "../rpc-handlers/agent-usage-parse";
import type { AgentUsageSource } from "../../shared/types";

const file = join(historyHome, "agent-usage-history-v1.json");
function states(id: string, model = "claude-sonnet-4-6", output = 0) {
	const claude = newUsageState();
	foldClaudeEntry(claude, {
		type: "assistant", timestamp: "2026-10-20T12:00:00Z", requestId: id,
		message: { id, model, content: "private conversation text", usage: { input_tokens: 1_000_000, output_tokens: output } },
	});
	return { claude, codex: newUsageState() };
}

beforeEach(() => mkdirSync(historyHome, { recursive: true }));
afterEach(() => rmSync(historyHome, { recursive: true, force: true }));

describe("retainUsageHistory", () => {
	function additional<S extends AgentUsageSource>(source: S, id?: string) {
		const state = newUsageState();
		if (id) state.records.set(`${source}:${id}`, {
			model: "gpt-6-sol", timestamp: Date.parse("2026-10-20T12:00:00Z"),
			counts: { inputTokens: 100, outputTokens: 10, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
		});
		return { [source]: state } as Record<S, typeof state>;
	}

	it.each(["gemini", "cursor", "copilot"] as const)("retains %s usage when its source files disappear", async (source) => {
		await retainUsageHistory(additional(source, "one"));
		const retained = await retainUsageHistory(additional(source));
		expect(finalizeUsage(retained[source], source).days[0].inputTokens).toBe(100);
	});

	it.each(["gemini", "cursor", "copilot"] as const)("merges concurrent %s snapshots without losing disjoint responses", async (source) => {
		await Promise.all([retainUsageHistory(additional(source, "one")), retainUsageHistory(additional(source, "two"))]);
		const retained = await retainUsageHistory(additional(source));
		expect(finalizeUsage(retained[source], source).days[0].inputTokens).toBe(200);
	});

	it("isolates new sources from older two-source writers and preserves legacy history format", async () => {
		await retainUsageHistory(states("old"));
		const before = readFileSync(file, "utf8");
		await retainUsageHistory(additional("gemini", "one"));
		expect(readFileSync(file, "utf8")).toBe(before);
		await retainUsageHistory(states("older-writer"));
		const retained = await retainUsageHistory(additional("gemini"));
		expect(retained.gemini.records.size).toBe(1);
		expect(JSON.parse(readFileSync(file, "utf8"))).toMatchObject({ version: 1, claude: expect.any(Array), codex: expect.any(Array) });
		expect(readFileSync(file, "utf8")).not.toContain('"gemini"');
	});

	it("retains chronological Copilot checkpoints when later source logs contain only the latest snapshot", async () => {
		const first = additional("copilot", "one");
		const firstRecord = [...first.copilot.records.values()][0];
		firstRecord.timestamp = Date.parse("2026-10-31T12:00:00Z");
		firstRecord.cumulativeScope = "session";
		firstRecord.counts.inputTokens = 20;
		await retainUsageHistory(first);
		const later = additional("copilot", "two");
		const laterRecord = [...later.copilot.records.values()][0];
		laterRecord.timestamp = Date.parse("2026-11-01T12:00:00Z");
		laterRecord.cumulativeScope = "session";
		laterRecord.counts.inputTokens = 30;
		await retainUsageHistory(later);
		const retained = await retainUsageHistory(later);
		expect(finalizeUsage(retained.copilot, "copilot").days).toMatchObject([
			{ date: "2026-10-31", inputTokens: 20 }, { date: "2026-11-01", inputTokens: 10 },
		]);
	});

	it("leaves invalid cumulative scope metadata intact and continues serving live usage", async () => {
		const current = additional("copilot", "one");
		const record = [...current.copilot.records.values()][0];
		const store = join(historyHome, "agent-usage-history-copilot-v1.json");
		const invalid = JSON.stringify({ version: 1, records: [["copilot:bad", { ...record, cumulativeScope: {} }]], superseded: [] });
		writeFileSync(store, invalid);
		const retained = await retainUsageHistory(current);
		expect(retained.copilot.records.size).toBe(1);
		expect(readFileSync(store, "utf8")).toBe(invalid);
	});

	it("keeps the original native pricing identity after a catalog label is reused", async () => {
		const first = states("routed", "openrouter/my-label");
		for (const usage of first.claude.records.values()) usage.pricingModel = "gpt-6.1-sol";
		await retainUsageHistory(first);
		const later = states("routed", "openrouter/my-label");
		for (const usage of later.claude.records.values()) usage.pricingModel = "gpt-6-astra";
		const retained = await retainUsageHistory(later);
		expect(finalizeUsage(retained.claude, "claude", () => "unknown-model").days[0]).toMatchObject({ costUsd: 2, fullyPriced: true });
	});

	it("does not resurrect a retained legacy echo after native reconciliation", async () => {
		const legacy = states("echo");
		const key = [...legacy.claude.records.keys()][0];
		await retainUsageHistory(legacy);
		const correction = states("native");
		correction.claude.superseded.add(key);
		await retainUsageHistory(correction);
		const replay = await retainUsageHistory(legacy);
		expect(finalizeUsage(replay.claude, "claude").days[0].inputTokens).toBe(1_000_000);
	});

	it("merges concurrent reports without losing disjoint responses", async () => {
		await Promise.all([retainUsageHistory(states("one")), retainUsageHistory(states("two"))]);
		const retained = await retainUsageHistory({ claude: newUsageState(), codex: newUsageState() });
		expect(finalizeUsage(retained.claude, "claude").days[0]).toMatchObject({ inputTokens: 2_000_000, costUsd: 6 });
	});

	it("retains raw unpriced counts so a later price update restores accumulated costs", async () => {
		await retainUsageHistory(states("one", "future-model"));
		const retained = await retainUsageHistory({ claude: newUsageState(), codex: newUsageState() });
		expect(finalizeUsage(retained.claude, "claude").hasUnpriced).toBe(true);
		const priced = finalizeUsage(retained.claude, "claude", (id) => id,
			() => ({ input: 4, output: 20, cacheRead: 0.4, cacheWrite5m: 5, cacheWrite1h: 8 }));
		expect(priced).toMatchObject({ hasUnpriced: false, days: [{ costUsd: 4, inputTokens: 1_000_000 }] });
		expect(readFileSync(file, "utf8")).not.toContain("private conversation text");
	});

	it("replaces retained streaming snapshots without charging the response twice", async () => {
		await retainUsageHistory(states("one", "claude-sonnet-4-6", 10));
		const retained = await retainUsageHistory(states("one", "claude-sonnet-4-6", 1_000_000));
		expect(finalizeUsage(retained.claude, "claude").days[0]).toMatchObject({ inputTokens: 1_000_000, outputTokens: 1_000_000, costUsd: 18 });
	});

	it.each(["{truncated", JSON.stringify({ version: 2, claude: [], codex: [] })])("leaves unreadable or newer history intact", async (body) => {
		writeFileSync(file, body);
		const live = await retainUsageHistory(states("one"));
		expect(finalizeUsage(live.claude, "claude").days[0].costUsd).toBe(3);
		expect(readFileSync(file, "utf8")).toBe(body);
	});
});
