import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, appendFileSync } from "node:fs";

// A real filesystem, redirected: the point of these cases is that appends land as
// bytes and that pruning deletes files, neither of which a mocked fs can prove.
const home = vi.hoisted(() => require("node:fs").mkdtempSync(`${require("node:os").tmpdir()}/dev3-msglog-`) as string);
vi.mock("../paths", () => ({ DEV3_HOME: home, OPS_DIR: `${home}/ops`, SANDBOX_DIR: `${home}/sandbox` }));
vi.mock("../logger", () => ({
	createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

const push = vi.hoisted(() => vi.fn());
vi.mock("../rpc-handlers/shared-pure", () => ({ getPushMessage: () => push }));

import type { Project } from "../../shared/types";
import {
	AGENT_MESSAGE_LOG_MAX_ROW_BYTES,
	AGENT_MESSAGE_LOG_TRUNCATION_MARK,
	parseAgentMessageLogRow,
	serializeAgentMessageLogReceipt,
	serializeAgentMessageLogRow,
	type AgentMessageLogInput,
} from "../../shared/agent-message-log";
import { DEFAULT_LOG_RETENTION_DAYS } from "../../shared/log-retention";
import {
	appendAgentMessageLog,
	appendAgentMessageLogReceipt,
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
	push.mockReset();
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

	it("clamps an oversized row to the ceiling, keeps the metadata, and never cuts a multi-byte character", () => {
		const line = serializeAgentMessageLogRow(makeRow({ body: "x".repeat(AGENT_MESSAGE_LOG_MAX_ROW_BYTES * 3) }));
		expect(new TextEncoder().encode(line).length).toBeLessThanOrEqual(AGENT_MESSAGE_LOG_MAX_ROW_BYTES);
		const parsed = parseAgentMessageLogRow(line);
		// The body shrank; who spoke to whom and how it went survived intact.
		expect(parsed?.body.endsWith(AGENT_MESSAGE_LOG_TRUNCATION_MARK)).toBe(true);
		expect(parsed).toMatchObject({ toSeq: 1650, fromSeq: 1141, status: "delivered" });

		const cyrillic = parseAgentMessageLogRow(serializeAgentMessageLogRow(makeRow({ body: "ы".repeat(AGENT_MESSAGE_LOG_MAX_ROW_BYTES) })));
		expect(cyrillic).not.toBeNull();
		expect(cyrillic?.body).not.toContain("\uFFFD");
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
	it("appends into a day-file beside tasks.json and reads it back newest-first, across days", () => {
		expect(readAgentMessageLog(project), "never sent a message").toEqual({ rows: [], oldestDay: null, retentionDays: DEFAULT_LOG_RETENTION_DAYS, hasMore: false });
		const day = new Date(2026, 7, 23, 12, 0, 0);
		appendAgentMessageLog(project, makeRow({ body: "first" }), day);
		appendAgentMessageLog(project, makeRow({ body: "second" }), day);

		expect(messageLogDir(project)).toBe(`${home}/data/Users-x-repo/messages`);
		const raw = readFileSync(`${messageLogDir(project)}/2026-08-23.jsonl`, "utf8");
		expect(raw.split("\n").filter(Boolean)).toHaveLength(2);

		const page = readAgentMessageLog(project);
		expect(page.rows.map((r) => r.body)).toEqual(["second", "first"]);
		expect(page.oldestDay).toBe("2026-08-23");
		expect(page.retentionDays).toBe(DEFAULT_LOG_RETENTION_DAYS);
		expect(page.hasMore).toBe(false);

		appendAgentMessageLog(project, makeRow({ body: "older" }), new Date(2026, 7, 21, 9, 0, 0));
		const acrossDays = readAgentMessageLog(project);
		expect(acrossDays.rows.map((r) => r.body)).toEqual(["second", "first", "older"]);
		expect(acrossDays.oldestDay).toBe("2026-08-21");
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

	it("stores the subject on disk, keeps it when a huge body is clamped, and reads a pre-subject row without one", () => {
		const day = new Date(2026, 7, 23, 12, 0, 0);
		appendAgentMessageLog(project, makeRow({ subject: "PR 1577 merged, main green" }), day);

		// Read the bytes, not the API: a subject that only exists in memory would
		// be worthless to the traffic view, which is the whole reason it is stored.
		const raw = readFileSync(`${messageLogDir(project)}/2026-08-23.jsonl`, "utf8");
		expect(JSON.parse(raw.trim()).subject).toBe("PR 1577 merged, main green");
		expect(readAgentMessageLog(project).rows[0]?.subject).toBe("PR 1577 merged, main green");

		appendAgentMessageLog(
			project,
			makeRow({ subject: "backfill finished", body: "x".repeat(AGENT_MESSAGE_LOG_MAX_ROW_BYTES * 2) }),
			day,
		);
		const clamped = readAgentMessageLog(project).rows[0]!;
		expect(clamped.subject, "clamped body").toBe("backfill finished");
		expect(clamped.body.endsWith(AGENT_MESSAGE_LOG_TRUNCATION_MARK)).toBe(true);

		const { subject: _dropped, ...legacy } = makeRow({ body: "an old message" }) as AgentMessageLogInput & {
			subject?: string;
		};
		appendAgentMessageLog(project, legacy, day);
		const old = readAgentMessageLog(project).rows[0]!;
		expect(old.subject, "legacy row").toBeUndefined();
		expect(old.body).toBe("an old message");
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

describe("hook delivery receipts", () => {
	const receipt = (receiptFor: string, at: string) => ({ at, receiptFor, status: "delivered" as const, deliveredVia: "hook" as const });

	it("is a line the row parser older versions ship rejects, so they list no empty message", () => {
		// parseAgentMessageLogRow is unchanged since receipts were added: it is the old reader.
		expect(parseAgentMessageLogRow(serializeAgentMessageLogReceipt(receipt("m-1", "2026-08-23T12:00:09.000Z")))).toBeNull();
	});

	it("folds a receipt into its message's row, even one written before the row, and leaves an unreceipted message as written", () => {
		const day = new Date(2026, 7, 23, 12, 0, 0);
		appendAgentMessageLog(project, makeRow({ messageId: "m-1", status: "held", body: "report" }), day);
		appendAgentMessageLogReceipt(project, receipt("m-1", "2026-08-23T12:00:09.000Z"), day);
		// The hook can claim while the row is still being logged.
		appendAgentMessageLogReceipt(project, receipt("m-3", "2026-08-23T12:00:10.000Z"), day);
		appendAgentMessageLog(project, makeRow({ messageId: "m-3", status: "held", body: "raced" }), day);
		appendAgentMessageLog(project, makeRow({ messageId: "m-2", status: "held", body: "typed" }), day);
		appendAgentMessageLogReceipt(project, receipt("other", "2026-08-23T12:00:11.000Z"), day);

		const rows = readAgentMessageLog(project).rows;
		expect(rows.map((r) => r.messageId)).toEqual(["m-2", "m-3", "m-1"]);
		expect(rows[2], "receipt after row").toMatchObject({ messageId: "m-1", body: "report", status: "delivered", deliveredVia: "hook", deliveredAt: "2026-08-23T12:00:09.000Z" });
		expect(rows[1], "receipt before row").toMatchObject({ messageId: "m-3", status: "delivered", deliveredVia: "hook" });
		expect(rows[0]?.status, "no receipt").toBe("held");
		expect(rows[0]).not.toHaveProperty("deliveredVia");
	});
});

describe("retention", () => {
	it("deletes day-files past the window and keeps the boundary day", () => {
		const now = new Date(2026, 7, 23, 12, 0, 0);
		const dayMs = 24 * 60 * 60 * 1000;
		const boundary = new Date(now.getTime() - (DEFAULT_LOG_RETENTION_DAYS - 1) * dayMs);
		const expired = new Date(now.getTime() - DEFAULT_LOG_RETENTION_DAYS * dayMs);
		// Written directly, so the write path's own prune cannot pre-empt the case.
		mkdirSync(messageLogDir(project), { recursive: true });
		for (const [day, body] of [[expired, "expired"], [boundary, "boundary"], [now, "today"]] as const) {
			const stamp = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, "0")}-${String(day.getDate()).padStart(2, "0")}`;
			writeFileSync(`${messageLogDir(project)}/${stamp}.jsonl`, serializeAgentMessageLogRow(makeRow({ body })));
		}

		expect(pruneAgentMessageLog(project, DEFAULT_LOG_RETENTION_DAYS, now)).toBe(1);
		const bodies = readAgentMessageLog(project).rows.map((r) => r.body);
		expect(bodies).toEqual(["today", "boundary"]);
	});

	it("keeps a longer window when the retention is raised", () => {
		const now = new Date(2026, 7, 23, 12, 0, 0);
		const dayMs = 24 * 60 * 60 * 1000;
		mkdirSync(messageLogDir(project), { recursive: true });
		const stampOf = (daysAgo: number) => {
			const day = new Date(now.getTime() - daysAgo * dayMs);
			return `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, "0")}-${String(day.getDate()).padStart(2, "0")}`;
		};
		for (const daysAgo of [89, 90]) writeFileSync(`${messageLogDir(project)}/${stampOf(daysAgo)}.jsonl`, serializeAgentMessageLogRow(makeRow()));

		expect(pruneAgentMessageLog(project, 90, now)).toBe(1);
		expect(readdirSync(messageLogDir(project))).toEqual([`${stampOf(89)}.jsonl`]);
	});

	it("deletes nothing for a window beyond the Date range, or when the history is kept forever", () => {
		mkdirSync(messageLogDir(project), { recursive: true });
		writeFileSync(`${messageLogDir(project)}/2001-01-01.jsonl`, serializeAgentMessageLogRow(makeRow()));
		for (const [name, retention] of [["beyond the Date range", 1e9], ["forever", null]] as const) {
			expect(pruneAgentMessageLog(project, retention, new Date(2026, 7, 23)), name).toBe(0);
			expect(readdirSync(messageLogDir(project)), name).toEqual(["2001-01-01.jsonl"]);
		}
	});

	it("reads the configured retention for the daily prune and for the page", () => {
		const now = new Date(2026, 7, 23, 12, 0, 0);
		writeFileSync(`${home}/settings.json`, JSON.stringify({ logRetentionDays: "forever" }));
		try {
			mkdirSync(messageLogDir(project), { recursive: true });
			writeFileSync(`${messageLogDir(project)}/2001-01-01.jsonl`, serializeAgentMessageLogRow(makeRow({ body: "ancient" })));
			appendAgentMessageLog(project, makeRow({ body: "today" }), now);
			const page = readAgentMessageLog(project);
			expect(page.rows.map((r) => r.body)).toEqual(["today", "ancient"]);
			expect(page.retentionDays).toBeNull();
		} finally {
			rmSync(`${home}/settings.json`, { force: true });
		}
	});

	it("skips the whole day's prune while settings.json is unreadable and prunes on the next day once it is fixed", () => {
		const now = new Date(2026, 7, 23, 12, 0, 0);
		mkdirSync(messageLogDir(project), { recursive: true });
		writeFileSync(`${messageLogDir(project)}/2001-01-01.jsonl`, serializeAgentMessageLogRow(makeRow({ body: "ancient" })));
		try {
			for (const broken of ["{ not json", JSON.stringify({ logRetentionDays: "abc" })]) {
				writeFileSync(`${home}/settings.json`, broken);
				appendAgentMessageLog(project, makeRow({ body: "first" }), now);
				expect(readdirSync(messageLogDir(project))).toContain("2001-01-01.jsonl");
			}

			writeFileSync(`${home}/settings.json`, JSON.stringify({}));
			appendAgentMessageLog(project, makeRow({ body: "second" }), now);
			expect(readdirSync(messageLogDir(project))).toContain("2001-01-01.jsonl");
			appendAgentMessageLog(project, makeRow({ body: "third" }), new Date(2026, 7, 24, 12, 0, 0));
			expect(readdirSync(messageLogDir(project))).not.toContain("2001-01-01.jsonl");
		} finally {
			rmSync(`${home}/settings.json`, { force: true });
		}
	});

	it("prunes from the write path, once per day per project", () => {
		const now = new Date(2026, 7, 23, 12, 0, 0);
		const expired = new Date(now.getTime() - 400 * 24 * 60 * 60 * 1000);
		appendAgentMessageLog(project, makeRow({ body: "ancient" }), expired);
		resetAgentMessageLogPruneState();
	push.mockReset();
		appendAgentMessageLog(project, makeRow({ body: "today" }), now);
		expect(readAgentMessageLog(project).rows.map((r) => r.body)).toEqual(["today"]);
	});

	it("leaves foreign files in the directory alone", () => {
		const now = new Date(2026, 7, 23, 12, 0, 0);
		appendAgentMessageLog(project, makeRow(), now);
		writeFileSync(`${messageLogDir(project)}/README.txt`, "hands off");
		expect(pruneAgentMessageLog(project, DEFAULT_LOG_RETENTION_DAYS, new Date(2027, 0, 1))).toBe(1);
		expect(readFileSync(`${messageLogDir(project)}/README.txt`, "utf8")).toBe("hands off");
	});
});


describe("durable append notifications", () => {
	it("announces every status only after its row is readable", () => {
		for (const status of ["delivered", "held", "unconfirmed", "not-delivered"] as const) {
			push.mockReset();
			rmSync(messageLogDir(project), { recursive: true, force: true });
			push.mockImplementation((name, payload) => {
				expect(name).toBe("agentMessageLogChanged");
				expect(payload).toEqual({ projectId: project.id });
				expect(readAgentMessageLog(project).rows[0].status, status).toBe(status);
			});
			appendAgentMessageLog(project, makeRow({ status }));
			expect(push, status).toHaveBeenCalledTimes(1);
		}
	});

	it("does not announce an append that failed", () => {
		mkdirSync(messageLogDir(project), { recursive: true });
		const now = new Date(2026, 7, 23);
		mkdirSync(`${messageLogDir(project)}/2026-08-23.jsonl`);
		appendAgentMessageLog(project, makeRow(), now);
		expect(push).not.toHaveBeenCalled();
	});
});
