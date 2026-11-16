import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appendFileSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";

// A real filesystem, redirected: the point of these cases is that appends land as
// bytes and that pruning deletes files, neither of which a mocked fs can prove.
const home = vi.hoisted(() => require("node:fs").mkdtempSync(`${require("node:os").tmpdir()}/dev3-notiflog-`) as string);
vi.mock("../paths", () => ({ DEV3_HOME: home, OPS_DIR: `${home}/ops`, SANDBOX_DIR: `${home}/sandbox` }));
vi.mock("../logger", () => ({
	createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import {
	NOTIFICATION_LOG_MAX_ROW_BYTES,
	NOTIFICATION_LOG_TRUNCATION_MARK,
	NOTIFICATION_LOG_VERSION,
	parseNotificationLogRow,
	serializeNotificationLogRow,
	type NotificationLogInput,
} from "../../shared/notification-log";
import { DEFAULT_LOG_RETENTION_DAYS } from "../../shared/log-retention";
import {
	appendNotificationLog,
	notificationLogDir,
	pruneNotificationLog,
	readNotificationLog,
	resetNotificationLogPruneState,
} from "../notification-log";

function makeRow(overrides: Partial<NotificationLogInput> = {}): NotificationLogInput {
	return {
		at: "2026-09-07T10:00:00.000Z",
		mode: "toast",
		level: "info",
		message: "build green",
		taskId: "task-1",
		taskSeq: 1813,
		taskTitle: "Record notification history",
		projectId: "proj-1",
		projectName: "dev-3.0",
		sourceTaskId: "task-1",
		sourceSeq: 1813,
		outcome: "delivered",
		...overrides,
	};
}

function readDay(day: string): string[] {
	return readFileSync(`${notificationLogDir()}/${day}.jsonl`, "utf8").split("\n").filter(Boolean);
}

beforeEach(() => {
	resetNotificationLogPruneState();
	rmSync(notificationLogDir(), { recursive: true, force: true });
});

afterEach(() => {
	vi.useRealTimers();
});

describe("notification log rows", () => {
	it("round-trips a row through serialize and parse", () => {
		const input = makeRow();
		const parsed = parseNotificationLogRow(serializeNotificationLogRow(input));
		expect(parsed).toEqual({ v: NOTIFICATION_LOG_VERSION, ...input });
	});

	it("serialises to exactly one line", () => {
		const line = serializeNotificationLogRow(makeRow({ message: "two\nlines" }));
		expect(line.endsWith("\n")).toBe(true);
		expect(line.slice(0, -1)).not.toContain("\n");
	});

	it("keeps a queued row's suppression sources", () => {
		const parsed = parseNotificationLogRow(
			serializeNotificationLogRow(makeRow({ outcome: "queued", suppressedBy: ["focusMode", "terminalImmersive"] })),
		);
		expect(parsed?.suppressedBy).toEqual(["focusMode", "terminalImmersive"]);
	});

	it("clips an oversized message but keeps every other field", () => {
		const line = serializeNotificationLogRow(makeRow({ message: "x".repeat(NOTIFICATION_LOG_MAX_ROW_BYTES * 2) }));
		expect(new TextEncoder().encode(line).length).toBeLessThanOrEqual(NOTIFICATION_LOG_MAX_ROW_BYTES);
		const parsed = parseNotificationLogRow(line);
		expect(parsed?.message.endsWith(NOTIFICATION_LOG_TRUNCATION_MARK)).toBe(true);
		expect(parsed?.outcome).toBe("delivered");
		expect(parsed?.taskSeq).toBe(1813);
	});

	it("never cuts a multi-byte character in half", () => {
		const line = serializeNotificationLogRow(makeRow({ message: "ё".repeat(NOTIFICATION_LOG_MAX_ROW_BYTES) }));
		const parsed = parseNotificationLogRow(line);
		expect(parsed?.message).not.toContain("�");
		expect(JSON.parse(line.trim()).message).toBe(parsed?.message);
	});

	it("rejects a torn line instead of throwing", () => {
		const line = serializeNotificationLogRow(makeRow());
		expect(parseNotificationLogRow(line.slice(0, 30))).toBeNull();
		expect(parseNotificationLogRow("")).toBeNull();
		expect(parseNotificationLogRow("null")).toBeNull();
	});

	it("rejects a row missing the facts that make it a notification", () => {
		expect(parseNotificationLogRow(JSON.stringify({ at: "now", message: "hi", mode: "toast", level: "info" }))).toBeNull();
		expect(parseNotificationLogRow(JSON.stringify({ message: "hi", mode: "toast", level: "info", outcome: "delivered" }))).toBeNull();
	});
});

describe("notification log on disk", () => {
	it("appends into a day-file named for the local day", () => {
		appendNotificationLog(makeRow(), new Date(2026, 8, 7, 23, 30));
		expect(readdirSync(notificationLogDir())).toEqual(["2026-09-07.jsonl"]);
		expect(JSON.parse(readDay("2026-09-07")[0]).message).toBe("build green");
	});

	it("appends rather than overwriting", () => {
		const day = new Date(2026, 8, 7, 9, 0);
		appendNotificationLog(makeRow({ message: "first" }), day);
		appendNotificationLog(makeRow({ message: "second" }), day);
		expect(readDay("2026-09-07").map((line) => JSON.parse(line).message)).toEqual(["first", "second"]);
	});

	it("writes the file 0600", () => {
		appendNotificationLog(makeRow(), new Date(2026, 8, 7));
		const { statSync } = require("node:fs");
		expect(statSync(`${notificationLogDir()}/2026-09-07.jsonl`).mode & 0o777).toBe(0o600);
	});

	it("does not throw when the directory cannot be written", () => {
		mkdirSync(home, { recursive: true });
		writeFileSync(notificationLogDir(), "not a directory");
		expect(() => appendNotificationLog(makeRow(), new Date(2026, 8, 7))).not.toThrow();
		rmSync(notificationLogDir(), { force: true });
	});

	it("deletes day-files outside the retention window and keeps the edge", () => {
		const now = new Date(2026, 8, 7);
		mkdirSync(notificationLogDir(), { recursive: true });
		const dayMs = 24 * 60 * 60 * 1000;
		const oldest = new Date(now.getTime() - (DEFAULT_LOG_RETENTION_DAYS - 1) * dayMs);
		const expired = new Date(now.getTime() - DEFAULT_LOG_RETENTION_DAYS * dayMs);
		const stamp = (date: Date) =>
			`${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
		for (const date of [oldest, expired]) {
			appendFileSync(`${notificationLogDir()}/${stamp(date)}.jsonl`, "{}\n");
		}
		appendFileSync(`${notificationLogDir()}/notes.txt`, "not a day file\n");

		expect(pruneNotificationLog(DEFAULT_LOG_RETENTION_DAYS, now)).toBe(1);
		const left = readdirSync(notificationLogDir());
		expect(left).toContain(`${stamp(oldest)}.jsonl`);
		expect(left).not.toContain(`${stamp(expired)}.jsonl`);
		expect(left).toContain("notes.txt");
	});

	it("deletes nothing for a window beyond the Date range", () => {
		mkdirSync(notificationLogDir(), { recursive: true });
		appendFileSync(`${notificationLogDir()}/2001-01-01.jsonl`, "{}\n");
		expect(pruneNotificationLog(1e9, new Date(2026, 8, 7))).toBe(0);
		expect(readdirSync(notificationLogDir())).toEqual(["2001-01-01.jsonl"]);
	});

	it("keeps a longer window when the retention is raised, and everything when it is forever", () => {
		const now = new Date(2026, 8, 7);
		mkdirSync(notificationLogDir(), { recursive: true });
		const dayMs = 24 * 60 * 60 * 1000;
		const stamp = (date: Date) =>
			`${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
		const at = (daysAgo: number) => `${notificationLogDir()}/${stamp(new Date(now.getTime() - daysAgo * dayMs))}.jsonl`;
		for (const daysAgo of [89, 90, 400]) appendFileSync(at(daysAgo), "{}\n");

		expect(pruneNotificationLog(null, now)).toBe(0);
		expect(readdirSync(notificationLogDir())).toHaveLength(3);
		expect(pruneNotificationLog(90, now)).toBe(2);
		expect(readdirSync(notificationLogDir())).toEqual([at(89).split("/").pop()]);
	});

	it("reads the configured retention for the daily prune and for the page", () => {
		mkdirSync(notificationLogDir(), { recursive: true });
		writeFileSync(`${home}/settings.json`, JSON.stringify({ logRetentionDays: "forever" }));
		try {
			appendFileSync(`${notificationLogDir()}/2001-01-01.jsonl`, "{}\n");
			appendNotificationLog(makeRow(), new Date(2026, 8, 7));
			expect(readdirSync(notificationLogDir())).toContain("2001-01-01.jsonl");
			expect(readNotificationLog().retentionDays).toBeNull();
		} finally {
			rmSync(`${home}/settings.json`, { force: true });
		}
	});

	it("skips the daily prune while settings.json is unreadable and prunes once it is fixed", () => {
		mkdirSync(notificationLogDir(), { recursive: true });
		appendFileSync(`${notificationLogDir()}/2001-01-01.jsonl`, "{}\n");
		try {
			for (const broken of ["{ not json", JSON.stringify({ logRetentionDays: "abc" })]) {
				writeFileSync(`${home}/settings.json`, broken);
				appendNotificationLog(makeRow(), new Date(2026, 8, 7, 8, 0));
				expect(readdirSync(notificationLogDir())).toContain("2001-01-01.jsonl");
			}

			writeFileSync(`${home}/settings.json`, JSON.stringify({}));
			appendNotificationLog(makeRow(), new Date(2026, 8, 7, 9, 0));
			expect(readdirSync(notificationLogDir())).not.toContain("2001-01-01.jsonl");
		} finally {
			rmSync(`${home}/settings.json`, { force: true });
		}
	});

	it("prunes once per day, not on every append", () => {
		const day = new Date(2026, 8, 7, 8, 0);
		mkdirSync(notificationLogDir(), { recursive: true });
		appendFileSync(`${notificationLogDir()}/2020-01-01.jsonl`, "{}\n");
		appendNotificationLog(makeRow(), day);
		expect(readdirSync(notificationLogDir())).not.toContain("2020-01-01.jsonl");

		appendFileSync(`${notificationLogDir()}/2020-01-02.jsonl`, "{}\n");
		appendNotificationLog(makeRow(), new Date(2026, 8, 7, 9, 0));
		expect(readdirSync(notificationLogDir())).toContain("2020-01-02.jsonl");
	});
});
