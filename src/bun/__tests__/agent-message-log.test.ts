import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, readFileSync, rmSync, writeFileSync, appendFileSync } from "node:fs";

// A real filesystem, redirected: the point of these cases is that appends land as
// bytes and that pruning deletes files, neither of which a mocked fs can prove.
const home = vi.hoisted(() => require("node:fs").mkdtempSync(`${require("node:os").tmpdir()}/dev3-msglog-`) as string);
vi.mock("../paths", () => ({ DEV3_HOME: home, OPS_DIR: `${home}/ops`, SANDBOX_DIR: `${home}/sandbox` }));
vi.mock("../logger", () => ({
	createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import type { Project } from "../../shared/types";
import {
	AGENT_MESSAGE_LOG_MAX_ROW_BYTES,
	AGENT_MESSAGE_LOG_RETENTION_DAYS,
	AGENT_MESSAGE_LOG_TRUNCATION_MARK,
	parseAgentMessageLogRow,
	serializeAgentMessageLogRow,
	type AgentMessageLogInput,
} from "../../shared/agent-message-log";
import {
	appendAgentMessageLog,
	messageLogDir,
	pruneAgentMessageLog,
	readAgentMessageLog,
	resetAgentMessageLogPruneState,
} from "../agent-message-log";

const project = { id: "proj-1", name: "Proj", path: "/Users/x/repo" } as unknown as Project;

function makeRow(overrides: Partial<AgentMessageLogInput> = {}): AgentMessageLogInput {
	return {
		at: "2026-08-23T10:00:00.000Z",
		fromTaskId: "sender-task",
		fromSeq: 1141,
		fromTitle: "Coordinator",
		toTaskId: "recipient-task",
		toSeq: 1650,
		toTitle: "Worker",
		toProjectId: "proj-1",
		kind: "immediate",
		body: "check CI and continue",
		bodyKind: "text",
		status: "delivered",
		...overrides,
	};
}

beforeEach(() => {
	resetAgentMessageLogPruneState();
	rmSync(messageLogDir(project), { recursive: true, force: true });
});

afterEach(() => {
	vi.useRealTimers();
});

describe("row serialisation", () => {
	it("round-trips a row through one line", () => {
		const line = serializeAgentMessageLogRow(makeRow());
		expect(line.endsWith("\n")).toBe(true);
		expect(line.indexOf("\n")).toBe(line.length - 1);
		const parsed = parseAgentMessageLogRow(line);
		expect(parsed).toMatchObject({ v: 1, fromSeq: 1141, toSeq: 1650, body: "check CI and continue" });
	});

	it("clamps an oversized row to the ceiling and keeps the metadata", () => {
		const line = serializeAgentMessageLogRow(makeRow({ body: "x".repeat(AGENT_MESSAGE_LOG_MAX_ROW_BYTES * 3) }));
		expect(new TextEncoder().encode(line).length).toBeLessThanOrEqual(AGENT_MESSAGE_LOG_MAX_ROW_BYTES);
		const parsed = parseAgentMessageLogRow(line);
		// The body shrank; who spoke to whom and how it went survived intact.
		expect(parsed?.body.endsWith(AGENT_MESSAGE_LOG_TRUNCATION_MARK)).toBe(true);
		expect(parsed).toMatchObject({ toSeq: 1650, fromSeq: 1141, status: "delivered" });
	});

	it("never cuts a multi-byte character in half", () => {
		const line = serializeAgentMessageLogRow(makeRow({ body: "ы".repeat(AGENT_MESSAGE_LOG_MAX_ROW_BYTES) }));
		const parsed = parseAgentMessageLogRow(line);
		expect(parsed).not.toBeNull();
		expect(parsed?.body).not.toContain("�");
	});

	it("rejects a torn or junk line instead of throwing", () => {
		expect(parseAgentMessageLogRow('{"v":1,"at":"2026-08-23T10:00:00.000Z","toTaskId":"t","toS')).toBeNull();
		expect(parseAgentMessageLogRow("")).toBeNull();
		expect(parseAgentMessageLogRow("not json at all")).toBeNull();
		// Valid JSON but missing the fields a traffic graph cannot do without.
		expect(parseAgentMessageLogRow('{"v":1,"at":"x","toTaskId":"t","body":"b"}')).toBeNull();
	});
});

describe("append and read", () => {
	it("appends into a day-file beside tasks.json and reads it back newest-first", () => {
		const day = new Date(2026, 7, 23, 12, 0, 0);
		appendAgentMessageLog(project, makeRow({ body: "first" }), day);
		appendAgentMessageLog(project, makeRow({ body: "second" }), day);

		expect(messageLogDir(project)).toBe(`${home}/data/Users-x-repo/messages`);
		const raw = readFileSync(`${messageLogDir(project)}/2026-08-23.jsonl`, "utf8");
		expect(raw.split("\n").filter(Boolean)).toHaveLength(2);

		const page = readAgentMessageLog(project);
		expect(page.rows.map((r) => r.body)).toEqual(["second", "first"]);
		expect(page.oldestDay).toBe("2026-08-23");
		expect(page.retentionDays).toBe(AGENT_MESSAGE_LOG_RETENTION_DAYS);
		expect(page.hasMore).toBe(false);
	});

	it("orders across days, newest day first", () => {
		appendAgentMessageLog(project, makeRow({ body: "older" }), new Date(2026, 7, 21, 9, 0, 0));
		appendAgentMessageLog(project, makeRow({ body: "newer" }), new Date(2026, 7, 22, 9, 0, 0));
		const page = readAgentMessageLog(project);
		expect(page.rows.map((r) => r.body)).toEqual(["newer", "older"]);
		expect(page.oldestDay).toBe("2026-08-21");
	});

	it("honours the limit and says older rows remain", () => {
		const day = new Date(2026, 7, 23, 12, 0, 0);
		for (let i = 0; i < 5; i++) appendAgentMessageLog(project, makeRow({ body: `m${i}` }), day);
		const page = readAgentMessageLog(project, 2);
		expect(page.rows.map((r) => r.body)).toEqual(["m4", "m3"]);
		expect(page.hasMore).toBe(true);
	});

	it("skips a truncated trailing line and keeps every complete row", () => {
		const day = new Date(2026, 7, 23, 12, 0, 0);
		appendAgentMessageLog(project, makeRow({ body: "first" }), day);
		appendAgentMessageLog(project, makeRow({ body: "second" }), day);
		// A file cut short — the last line lost its tail and its newline.
		appendFileSync(`${messageLogDir(project)}/2026-08-23.jsonl`, '{"v":1,"at":"2026-08-2');
		const page = readAgentMessageLog(project);
		expect(page.rows.map((r) => r.body)).toEqual(["second", "first"]);
	});

	it("answers an empty page for a project that has never sent a message", () => {
		const page = readAgentMessageLog(project);
		expect(page).toEqual({ rows: [], oldestDay: null, retentionDays: AGENT_MESSAGE_LOG_RETENTION_DAYS, hasMore: false });
	});

	it("survives an unwritable log directory without throwing", () => {
		const dir = messageLogDir(project);
		mkdirSync(dir.slice(0, dir.lastIndexOf("/")), { recursive: true });
		// A plain file where the directory should be: mkdir and append both fail.
		writeFileSync(dir, "not a directory");
		expect(() => appendAgentMessageLog(project, makeRow(), new Date(2026, 7, 23))).not.toThrow();
		rmSync(dir, { force: true });
	});
});

describe("retention", () => {
	it("deletes day-files past the window and keeps the boundary day", () => {
		const now = new Date(2026, 7, 23, 12, 0, 0);
		const dayMs = 24 * 60 * 60 * 1000;
		const boundary = new Date(now.getTime() - (AGENT_MESSAGE_LOG_RETENTION_DAYS - 1) * dayMs);
		const expired = new Date(now.getTime() - AGENT_MESSAGE_LOG_RETENTION_DAYS * dayMs);
		// Written directly, so the write path's own prune cannot pre-empt the case.
		mkdirSync(messageLogDir(project), { recursive: true });
		for (const [day, body] of [[expired, "expired"], [boundary, "boundary"], [now, "today"]] as const) {
			const stamp = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, "0")}-${String(day.getDate()).padStart(2, "0")}`;
			writeFileSync(`${messageLogDir(project)}/${stamp}.jsonl`, serializeAgentMessageLogRow(makeRow({ body })));
		}

		expect(pruneAgentMessageLog(project, now)).toBe(1);
		const bodies = readAgentMessageLog(project).rows.map((r) => r.body);
		expect(bodies).toEqual(["today", "boundary"]);
	});

	it("prunes from the write path, once per day per project", () => {
		const now = new Date(2026, 7, 23, 12, 0, 0);
		const expired = new Date(now.getTime() - 400 * 24 * 60 * 60 * 1000);
		appendAgentMessageLog(project, makeRow({ body: "ancient" }), expired);
		resetAgentMessageLogPruneState();
		appendAgentMessageLog(project, makeRow({ body: "today" }), now);
		expect(readAgentMessageLog(project).rows.map((r) => r.body)).toEqual(["today"]);
	});

	it("leaves foreign files in the directory alone", () => {
		const now = new Date(2026, 7, 23, 12, 0, 0);
		appendAgentMessageLog(project, makeRow(), now);
		writeFileSync(`${messageLogDir(project)}/README.txt`, "hands off");
		expect(pruneAgentMessageLog(project, new Date(2027, 0, 1))).toBe(1);
		expect(readFileSync(`${messageLogDir(project)}/README.txt`, "utf8")).toBe("hands off");
	});
});
