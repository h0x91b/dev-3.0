import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { finalizeUsage, newUsageState } from "../../rpc-handlers/agent-usage-parse";
import { collectPiUsage, piSessionRoots } from "../pi";

let home: string;
const at = Date.parse("2026-10-25T12:00:00Z");
const usage = (input: number, output: number, extra: Record<string, unknown> = {}) => ({
	input, output, cacheRead: 0, cacheWrite: 0, totalTokens: input + output,
	cost: { input: 9, output: 9, cacheRead: 0, cacheWrite: 0, total: 18 }, ...extra,
});
const assistant = (id: string, model: string, u: unknown, extra: Record<string, unknown> = {}) => ({
	type: "message", id, parentId: null, timestamp: new Date(at).toISOString(),
	message: { role: "assistant", content: [{ type: "text", text: "private answer" }], provider: "anthropic", api: "anthropic-messages", model, usage: u, timestamp: at, ...extra },
});
const header = (id: string) => ({ type: "session", version: 3, id, timestamp: new Date(at).toISOString(), cwd: "/private/repo" });

function write(path: string, rows: unknown[], tail = ""): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, rows.map((row) => JSON.stringify(row)).join("\n") + "\n" + tail);
}
const sessions = (root = join(home, ".pi", "agent")) => join(root, "sessions", "--private-repo--");

beforeEach(() => { home = mkdtempSync(join(tmpdir(), "dev3-pi-usage-")); });
afterEach(() => rmSync(home, { recursive: true, force: true }));

describe("collectPiUsage (pi)", () => {
	it("maps normalized usage, keeps the 1h cache split and counts output once", () => {
		write(join(sessions(), "a.jsonl"), [header("s1"), assistant("e1", "claude-sonnet-4-6",
			usage(100, 50, { cacheRead: 1_000, cacheWrite: 300, cacheWrite1h: 200, reasoning: 20 }))]);
		const state = newUsageState();
		collectPiUsage(state, "pi", piSessionRoots("pi", home, []));
		expect([...state.records.values()]).toEqual([{
			model: "claude-sonnet-4-6", pricingModel: undefined, cumulativeScope: undefined, timestamp: at,
			counts: {
				inputTokens: 100, outputTokens: 50, cacheReadInputTokens: 1_000, cacheCreationInputTokens: 300,
				cacheCreation1hInputTokens: 200, cacheCreation5mInputTokens: 100,
			},
		}]);
	});

	it("prices the physical model that answered a virtual model", () => {
		write(join(sessions(), "a.jsonl"), [assistant("e1", "router", usage(10, 1), { responseModel: "claude-opus-4-8" })]);
		const state = newUsageState();
		collectPiUsage(state, "pi", piSessionRoots("pi", home, []));
		expect([...state.records.values()][0].model).toBe("claude-opus-4-8");
	});

	it("counts a forked or branch-extracted copy of a response once", () => {
		const shared = assistant("e1", "claude-sonnet-4-6", usage(100, 10));
		write(join(sessions(), "original.jsonl"), [header("s1"), shared]);
		write(join(sessions(), "fork.jsonl"), [{ ...header("s2"), parentSession: "original.jsonl" }, { ...shared, parentId: "x" },
			assistant("e2", "claude-sonnet-4-6", usage(5, 5))]);
		const state = newUsageState();
		collectPiUsage(state, "pi", piSessionRoots("pi", home, []));
		expect(state.records.size).toBe(2);
	});

	it("counts usage entries, tool work and summaries like pi's own session totals, leaving unknown models unpriced", () => {
		write(join(sessions(), "a.jsonl"), [
			{ type: "usage", id: "u1", parentId: null, timestamp: new Date(at).toISOString(), kind: "cache_warm", provider: "anthropic", model: "claude-sonnet-4-6", usage: usage(0, 0, { cacheRead: 5_000 }) },
			{ type: "message", id: "t1", parentId: "u1", timestamp: new Date(at).toISOString(), message: { role: "toolResult", toolCallId: "c", content: [{ type: "text", text: "private tool output" }], usage: usage(7, 3), timestamp: at } },
			{ type: "compaction", id: "c1", parentId: "t1", timestamp: new Date(at).toISOString(), summary: "private summary", firstKeptEntryId: "t1", usage: usage(11, 2) },
			{ type: "branch_summary", id: "b1", parentId: "c1", timestamp: new Date(at).toISOString(), fromId: "c1", summary: "private", usage: usage(13, 4) },
			{ type: "message", id: "m1", parentId: "b1", timestamp: new Date(at).toISOString(), message: { role: "user", content: "private prompt", timestamp: at } },
		]);
		const state = newUsageState();
		collectPiUsage(state, "pi", piSessionRoots("pi", home, []));
		expect([...state.records.values()].map((r) => [r.model, r.counts.inputTokens + r.counts.cacheReadInputTokens])).toEqual([
			["claude-sonnet-4-6", 5_000], ["unknown", 7], ["unknown", 11], ["unknown", 13],
		]);
		expect(finalizeUsage(state, "pi").hasUnpriced).toBe(true);
	});

	it("reads managed account session stores and tolerates malformed lines, bad counts and missing dirs", () => {
		const account = join(home, "accounts", "pi", "one");
		write(join(sessions(account), "a.jsonl"), [
			assistant("bad", "claude-sonnet-4-6", usage(-1, 5)),
			assistant("zero", "claude-sonnet-4-6", usage(0, 0)),
			assistant("ok", "claude-sonnet-4-6", usage(1, 1)),
		], "{\"type\":\"message\",\"id\":\"partial");
		const state = newUsageState();
		collectPiUsage(state, "pi", piSessionRoots("pi", join(home, "missing"), [account]));
		expect(state.records.size).toBe(1);
	});
});

describe("collectPiUsage (omp)", () => {
	const ompSessions = (root = join(home, ".omp", "agent")) => join(root, "sessions", "--private-repo--");

	it("counts assistant and model_usage entries, adds orchestration tokens and walks subagent sessions", () => {
		write(join(ompSessions(), "main.jsonl"), [header("s1"),
			assistant("e1", "gpt-5.4", usage(100, 10, { orchestration: { input: 5, cacheRead: 7, output: 3 } }), { provider: "openai", api: "openai-responses" })]);
		write(join(ompSessions(), "main", "subagent.jsonl"), [
			{ type: "model_usage", id: "mu1", parentId: null, timestamp: new Date(at).toISOString(), provider: "openai", api: "openai-responses", model: "gpt-5.4", usage: usage(20, 2) },
			{ type: "compaction", id: "c1", parentId: null, timestamp: new Date(at).toISOString(), usage: usage(99, 99) },
		]);
		const state = newUsageState();
		collectPiUsage(state, "omp", piSessionRoots("omp", home, [], {}));
		expect([...state.records.values()].map((r) => r.counts).sort((a, b) => a.inputTokens - b.inputTokens)).toEqual([
			{ inputTokens: 20, outputTokens: 2, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
			{ inputTokens: 105, outputTokens: 13, cacheReadInputTokens: 7, cacheCreationInputTokens: 0 },
		]);
	});

	it("deduplicates a copied response across the default, XDG and account stores", () => {
		const xdg = join(home, "xdg");
		const account = join(home, "accounts", "omp", "one");
		const row = assistant("e1", "gpt-5.4", usage(1, 1));
		write(join(ompSessions(), "a.jsonl"), [row]);
		write(join(xdg, "omp", "sessions", "--private-repo--", "a.jsonl"), [row]);
		write(join(ompSessions(account), "b.jsonl"), [row, assistant("e2", "gpt-5.4", usage(2, 2))]);
		const state = newUsageState();
		collectPiUsage(state, "omp", piSessionRoots("omp", home, [account], { XDG_DATA_HOME: xdg }));
		expect(state.records.size).toBe(2);
	});

	it("skips assistant messages that name no model", () => {
		write(join(ompSessions(), "a.jsonl"), [assistant("e1", "", usage(1, 1))]);
		const state = newUsageState();
		collectPiUsage(state, "omp", piSessionRoots("omp", home, [], {}));
		expect(state.records.size).toBe(0);
	});
});
