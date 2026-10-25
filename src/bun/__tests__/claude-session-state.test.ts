import { describe, expect, test } from "vitest";
import { parseClaudeSessionState, claudeSessionBecameIdle } from "../../shared/claude-session-state";

const record = {
	pid: 59796,
	sessionId: "fixture-session",
	cwd: "/fixture/work",
	startedAt: 1792952640962,
	kind: "interactive",
	entrypoint: "cli",
	status: "busy",
	statusUpdatedAt: 1792952642781,
};

function state(overrides: Record<string, unknown> = {}) {
	const parsed = parseClaudeSessionState({ ...record, ...overrides });
	if (!parsed) throw new Error("Invalid fixture");
	return parsed;
}

describe("Claude session state", () => {
	test("parses only lifecycle fields from an interactive CLI record", () => {
		expect(parseClaudeSessionState({ ...record, name: "private name", version: "2.1.310" })).toEqual({
			pid: record.pid, sessionId: record.sessionId, cwd: record.cwd,
			startedAt: record.startedAt, status: "busy", statusUpdatedAt: record.statusUpdatedAt,
		});
	});

	test("rejects malformed, noninteractive, SDK and unknown records", () => {
		for (const raw of [null, [], "{}", {},
			...[
				{ kind: "sdk" }, { entrypoint: "sdk" }, { kind: undefined },
				{ status: "working" }, { status: "exited" }, { status: undefined },
				{ pid: 0 }, { pid: 1.5 }, { pid: "123" },
				{ startedAt: NaN }, { startedAt: -1 }, { statusUpdatedAt: Infinity },
				{ statusUpdatedAt: undefined }, { sessionId: "" }, { cwd: "" },
			].map((override) => ({ ...record, ...override })),
		]) expect(parseClaudeSessionState(raw)).toBeNull();
	});

	test("detects a confirmed busy to idle edge", () => {
		expect(claudeSessionBecameIdle(state(), state({ status: "idle", statusUpdatedAt: record.statusUpdatedAt + 1 }))).toBe(true);
	});

	test("detects coalesced activity between two idle snapshots", () => {
		expect(claudeSessionBecameIdle(state({ status: "idle" }), state({ status: "idle", statusUpdatedAt: record.statusUpdatedAt + 1 }))).toBe(true);
	});

	test("rejects unchanged idle, stale edges and continued work", () => {
		for (const status of ["busy", "idle"]) {
			for (const delta of [-1, 0]) {
				expect(claudeSessionBecameIdle(state({ status }), state({ status: "idle", statusUpdatedAt: record.statusUpdatedAt + delta }))).toBe(false);
			}
		}
		expect(claudeSessionBecameIdle(state({ status: "idle" }), state({ statusUpdatedAt: record.statusUpdatedAt + 1 }))).toBe(false);
	});

	test("rejects process or session replacement and changed workspace", () => {
		for (const replacement of [{ pid: 2 }, { sessionId: "other" }, { startedAt: record.startedAt + 1 }, { cwd: "/other" }]) {
			expect(claudeSessionBecameIdle(state(), state({ ...replacement, status: "idle", statusUpdatedAt: record.statusUpdatedAt + 2 }))).toBe(false);
		}
	});
});
