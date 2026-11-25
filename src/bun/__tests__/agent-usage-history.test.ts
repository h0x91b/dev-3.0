import { mkdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const historyHome = await vi.hoisted(async () => {
	const { mkdtempSync } = await import("node:fs");
	const { tmpdir } = await import("node:os");
	const { join } = await import("node:path");
	const path = mkdtempSync(join(tmpdir(), "usage-history-"));
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

	function sourceFile(source: AgentUsageSource): string {
		return source === "claude" || source === "codex" ? file : join(historyHome, `agent-usage-history-${source}-v1.json`);
	}

	function markPastWrite(path: string): number {
		const past = new Date("2020-01-01T00:00:00Z");
		utimesSync(path, past, past);
		return statSync(path).mtimeMs;
	}

	const ALL_SOURCES = ["claude", "codex", "gemini", "cursor", "copilot"] as const;
	function resetHistory() {
		rmSync(historyHome, { recursive: true, force: true });
		mkdirSync(historyHome, { recursive: true });
	}

	it("leaves every source's history bytes and mtime unchanged on repeated or missing-log refreshes", async () => {
		for (const source of ALL_SOURCES) {
			resetHistory();
			await retainUsageHistory(additional(source, "one"));
			const path = sourceFile(source);
			const bytes = readFileSync(path, "utf8");
			const modifiedAt = markPastWrite(path);
			await retainUsageHistory(additional(source, "one"));
			await retainUsageHistory(additional(source));
			expect(readFileSync(path, "utf8"), source).toBe(bytes);
			expect(statSync(path).mtimeMs, source).toBe(modifiedAt);
		}
	});

	it("writes changed snapshots and durable tombstones for every source", async () => {
		for (const source of ALL_SOURCES) {
			resetHistory();
			await retainUsageHistory(additional(source, "one"));
			const path = sourceFile(source);
			const initialMtime = markPastWrite(path);
			const changed = additional(source, "one");
			const identity = `${source}:one`;
			changed[source].records.get(identity)!.counts.outputTokens = 30;
			await retainUsageHistory(changed);
			expect(statSync(path).mtimeMs, source).not.toBe(initialMtime);
			const updated = await retainUsageHistory(additional(source));
			expect(updated[source].records.get(identity)!.counts.outputTokens, source).toBe(30);
			const updatedMtime = markPastWrite(path);
			const correction = additional(source);
			correction[source].superseded.add(identity);
			await retainUsageHistory(correction);
			expect(statSync(path).mtimeMs, source).not.toBe(updatedMtime);
			const replay = await retainUsageHistory(additional(source, "one"));
			expect(replay[source].superseded.has(identity), source).toBe(true);
			expect(replay[source].records.has(identity), source).toBe(false);
		}
	});

	it("retains per-source usage when its files disappear and merges concurrent snapshots without losing disjoint responses", async () => {
		for (const source of ["gemini", "cursor", "copilot"] as const) {
			resetHistory();
			await retainUsageHistory(additional(source, "one"));
			const retained = await retainUsageHistory(additional(source));
			expect(finalizeUsage(retained[source], source).days[0].inputTokens, `${source} after files vanish`).toBe(100);

			resetHistory();
			await Promise.all([retainUsageHistory(additional(source, "one")), retainUsageHistory(additional(source, "two"))]);
			const merged = await retainUsageHistory(additional(source));
			expect(finalizeUsage(merged[source], source).days[0].inputTokens, `${source} concurrent`).toBe(200);
		}
	});

	it("keeps billing across refreshes, learns it for an already-retained record, and reads a foreign value as unknown", async () => {
		const path = sourceFile("gemini");
		await retainUsageHistory(additional("gemini", "one"));
		expect((await retainUsageHistory(additional("gemini"))).gemini.records.get("gemini:one")!.billing).toBeUndefined();
		const learned = additional("gemini", "one");
		learned.gemini.records.get("gemini:one")!.billing = "api";
		await retainUsageHistory(learned);
		expect((await retainUsageHistory(additional("gemini"))).gemini.records.get("gemini:one")!.billing).toBe("api");
		// A refresh without evidence must not erase what an earlier read proved.
		await retainUsageHistory(additional("gemini", "one"));
		expect((await retainUsageHistory(additional("gemini"))).gemini.records.get("gemini:one")!.billing).toBe("api");
		writeFileSync(path, readFileSync(path, "utf8").replace('"billing":"api"', '"billing":"credits"'));
		const retained = await retainUsageHistory(additional("gemini"));
		expect(retained.gemini.records.get("gemini:one")).toMatchObject({ model: "gpt-6-sol" });
		expect(retained.gemini.records.get("gemini:one")!.billing).toBeUndefined();
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

	it("leaves unreadable or newer history intact", async () => {
		for (const body of ["{truncated", JSON.stringify({ version: 2, claude: [], codex: [] })]) {
			writeFileSync(file, body);
			const live = await retainUsageHistory(states("one"));
			expect(finalizeUsage(live.claude, "claude").days[0].costUsd, body).toBe(3);
			expect(readFileSync(file, "utf8"), body).toBe(body);
		}
	});
});
