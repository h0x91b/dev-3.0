import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newUsageState } from "../../rpc-handlers/agent-usage-parse";
import { collectCursorUsage, foldCursorHookUsage, parseCursorHookUsage, recordCursorHookUsage } from "../cursor";

const TIMESTAMP = Date.parse("2026-10-25T12:00:00Z");
const PAYLOAD = {
	hook_event_name: "afterAgentResponse", conversation_id: "conversation-1", generation_id: "generation-1",
	model: "claude-4.5-sonnet", input_tokens: 120, output_tokens: 30,
	cache_read_tokens: 800, cache_write_tokens: 400,
};

describe("Cursor usage collection", () => {
	let root: string;
	beforeEach(() => { root = mkdtempSync(join(tmpdir(), "dev3-cursor-usage-")); });
	afterEach(() => { rmSync(root, { recursive: true, force: true }); });

	it("preserves uncached input and separate cache counts reported by interactive hooks", () => {
		expect(parseCursorHookUsage(PAYLOAD, TIMESTAMP)?.usage.counts).toEqual({
			inputTokens: 120, outputTokens: 30, cacheReadInputTokens: 800, cacheCreationInputTokens: 400,
		});
	});

	it("does not fabricate usage from transcript text or hooks without token counts", () => {
		expect(parseCursorHookUsage({
			...PAYLOAD, input_tokens: undefined, output_tokens: undefined, text: "a very long assistant response",
		}, TIMESTAMP)).toBeNull();
	});

	it.each([NaN, Infinity, -1, "120", 1.5])("rejects malformed token counts (%s)", input_tokens => {
		expect(parseCursorHookUsage({ ...PAYLOAD, input_tokens }, TIMESTAMP)).toBeNull();
	});

	it.each(["conversation_id", "generation_id", "model"])("requires a real %s", key => {
		expect(parseCursorHookUsage({ ...PAYLOAD, [key]: "" }, TIMESTAMP)).toBeNull();
	});

	it("retains aborted generation usage available only from the stop hook", () => {
		recordCursorHookUsage({ ...PAYLOAD, hook_event_name: "stop", status: "aborted" }, TIMESTAMP, root);
		const state = newUsageState();
		collectCursorUsage(state, root);
		expect([...state.records.values()]).toEqual([parseCursorHookUsage(PAYLOAD, TIMESTAMP)!.usage]);
	});

	it("counts the successful generation once when both response and stop hooks report it", () => {
		recordCursorHookUsage(PAYLOAD, TIMESTAMP, root);
		recordCursorHookUsage({ ...PAYLOAD, hook_event_name: "stop", status: "completed" }, TIMESTAMP + 100, root);
		const state = newUsageState();
		collectCursorUsage(state, root);
		expect([...state.records.values()]).toEqual([parseCursorHookUsage(PAYLOAD, TIMESTAMP)!.usage]);
	});

	it("ignores lifecycle hooks unrelated to completed generations", () => {
		expect(recordCursorHookUsage({ ...PAYLOAD, hook_event_name: "afterAgentThought" }, TIMESTAMP, root)).toBe(false);
	});

	it("captures only model, counts, identity and timestamp, excluding hook content and credentials", () => {
		recordCursorHookUsage({
			...PAYLOAD, text: "private response", cwd: "/private/workspace", prompt: "private prompt",
			user_email: "private@example.com", env: { CURSOR_API_KEY: "secret-token" },
		}, TIMESTAMP, root);
		const stored = readFileSync(join(root, "usage", "cursor.jsonl"), "utf8");
		expect(JSON.parse(stored)).toEqual({
			key: 'cursor:["conversation-1","generation-1"]',
			record: { model: PAYLOAD.model, timestamp: TIMESTAMP, counts: {
				inputTokens: 120, outputTokens: 30, cacheReadInputTokens: 800, cacheCreationInputTokens: 400,
			} },
		});
	});

	it("replays duplicate hook delivery and repeated refreshes exactly once", () => {
		recordCursorHookUsage(PAYLOAD, TIMESTAMP, root);
		recordCursorHookUsage(PAYLOAD, TIMESTAMP + 100, root);
		const state = newUsageState();
		collectCursorUsage(state, root);
		collectCursorUsage(state, root);
		expect([...state.records.values()]).toEqual([parseCursorHookUsage(PAYLOAD, TIMESTAMP)!.usage]);
	});

	it("keeps generations separate even when models and token counts match", () => {
		recordCursorHookUsage(PAYLOAD, TIMESTAMP, root);
		recordCursorHookUsage({ ...PAYLOAD, generation_id: "generation-2" }, TIMESTAMP, root);
		const state = newUsageState();
		collectCursorUsage(state, root);
		expect([...state.records.values()].reduce((sum, record) => sum + record.counts.inputTokens, 0)).toBe(240);
	});

	it("retains the original billing day when an equal snapshot is redelivered after midnight", () => {
		const state = newUsageState();
		foldCursorHookUsage(state, PAYLOAD, TIMESTAMP);
		foldCursorHookUsage(state, PAYLOAD, TIMESTAMP + 86_400_000);
		expect([...state.records.values()][0].timestamp).toBe(TIMESTAMP);
	});

	it("retains the earliest day when hook delivery order is reversed", () => {
		const state = newUsageState();
		foldCursorHookUsage(state, PAYLOAD, TIMESTAMP + 86_400_000);
		foldCursorHookUsage(state, PAYLOAD, TIMESTAMP);
		expect([...state.records.values()][0].timestamp).toBe(TIMESTAMP);
	});

	it("accepts a fuller generation snapshot without summing repeated counts", () => {
		const state = newUsageState();
		foldCursorHookUsage(state, PAYLOAD, TIMESTAMP);
		foldCursorHookUsage(state, { ...PAYLOAD, output_tokens: 60 }, TIMESTAMP + 100);
		expect([...state.records.values()].map(record => record.counts.outputTokens)).toEqual([60]);
	});

	it("continues past malformed records and a truncated last write", () => {
		recordCursorHookUsage(PAYLOAD, TIMESTAMP, root);
		const path = join(root, "usage", "cursor.jsonl");
		appendFileSync(path, '\n{"key":"cursor:bad"}\n{"key":');
		const state = newUsageState();
		collectCursorUsage(state, root);
		expect(state.records.size).toBe(1);
	});

	it("treats an absent ledger as unavailable usage rather than a failure", () => {
		const state = newUsageState();
		collectCursorUsage(state, root);
		expect(state.records.size).toBe(0);
	});

	it("never fails an agent response if the local ledger cannot be written", () => {
		const file = join(root, "not-a-directory");
		writeFileSync(file, "occupied");
		expect(recordCursorHookUsage(PAYLOAD, TIMESTAMP, file)).toBe(false);
	});
});
