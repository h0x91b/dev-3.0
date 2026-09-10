import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";

// A real filesystem, redirected: what is under test is reading day-files off disk,
// including a torn line and a day the retention prune already deleted.
const home = vi.hoisted(() => require("node:fs").mkdtempSync(`${require("node:os").tmpdir()}/dev3-notifread-`) as string);
vi.mock("../paths", () => ({ DEV3_HOME: home, OPS_DIR: `${home}/ops`, SANDBOX_DIR: `${home}/sandbox` }));
vi.mock("../logger", () => ({
	createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock("../rpc-handlers/shared-pure", () => ({ getPushMessage: () => null }));

import { NOTIFICATION_LOG_RETENTION_DAYS, type NotificationLogInput, serializeNotificationLogRow } from "../../shared/notification-log";
import { notificationLogDir, readNotificationLog } from "../notification-log";

const dir = () => notificationLogDir();

function row(overrides: Partial<NotificationLogInput> = {}): string {
	return serializeNotificationLogRow({
		at: "2026-09-07T10:00:00.000Z",
		mode: "toast",
		level: "info",
		message: "build green",
		taskId: "task-1",
		taskSeq: 11,
		projectId: "proj-1",
		sourceTaskId: "task-1",
		sourceSeq: 11,
		outcome: "delivered",
		...overrides,
	});
}

function writeDay(day: string, lines: string[]): void {
	mkdirSync(dir(), { recursive: true });
	writeFileSync(`${dir()}/${day}.jsonl`, lines.join(""));
}

beforeEach(() => rmSync(dir(), { recursive: true, force: true }));
afterEach(() => rmSync(dir(), { recursive: true, force: true }));

describe("readNotificationLog", () => {
	it("answers an empty page with a null day range when nothing was ever recorded", () => {
		const page = readNotificationLog();
		expect(page).toEqual({
			rows: [],
			oldestDay: null,
			newestDay: null,
			retentionDays: NOTIFICATION_LOG_RETENTION_DAYS,
			hasMore: false,
		});
	});

	it("returns rows newest first across days and reports the real day range", () => {
		writeDay("2026-09-05", [row({ message: "oldest", at: "2026-09-05T09:00:00.000Z" })]);
		writeDay("2026-09-07", [
			row({ message: "middle", at: "2026-09-07T09:00:00.000Z" }),
			row({ message: "newest", at: "2026-09-07T18:00:00.000Z" }),
		]);
		const page = readNotificationLog();
		expect(page.rows.map(item => item.message)).toEqual(["newest", "middle", "oldest"]);
		expect(page.oldestDay).toBe("2026-09-05");
		expect(page.newestDay).toBe("2026-09-07");
		expect(page.hasMore).toBe(false);
	});

	it("reports a gap in the middle as a gap, not as continuous history", () => {
		// 09-06 is missing: either nothing happened, or a prune took it. The reader
		// must not fabricate the day, and the range must still span the real edges.
		writeDay("2026-09-05", [row({ message: "before the gap" })]);
		writeDay("2026-09-08", [row({ message: "after the gap" })]);
		const page = readNotificationLog();
		expect(page.rows).toHaveLength(2);
		expect([page.oldestDay, page.newestDay]).toEqual(["2026-09-05", "2026-09-08"]);
	});

	it("stops at the limit and says older rows are still on disk", () => {
		writeDay("2026-09-07", [row({ message: "a" }), row({ message: "b" }), row({ message: "c" })]);
		const page = readNotificationLog({ limit: 2 });
		expect(page.rows.map(item => item.message)).toEqual(["c", "b"]);
		expect(page.hasMore).toBe(true);
	});

	it("skips a torn line instead of losing the day it lives in", () => {
		writeDay("2026-09-07", [row({ message: "before" }), '{"v":1,"at":"2026-09-0', "\n", row({ message: "after" })]);
		expect(readNotificationLog().rows.map(item => item.message)).toEqual(["after", "before"]);
	});

	it("ignores files that are not day-files", () => {
		writeDay("2026-09-07", [row({ message: "real" })]);
		writeFileSync(`${dir()}/notes.txt`, "not a log\n");
		writeFileSync(`${dir()}/2026-13-40.jsonl`, row({ message: "impossible day" }));
		const page = readNotificationLog();
		expect(page.rows.map(item => item.message)).toEqual(["real"]);
		expect(page.newestDay).toBe("2026-09-07");
	});

	describe("project filtering", () => {
		beforeEach(() => {
			writeDay("2026-09-07", [
				row({ message: "visible project", projectId: "proj-1" }),
				row({ message: "sensitive project", projectId: "proj-secret" }),
				row({ message: "no project at all", projectId: null, taskId: null, taskSeq: null, sourceTaskId: null, sourceSeq: null }),
			]);
		});

		it("keeps allowed projects and always keeps rows with no project", () => {
			const page = readNotificationLog({ projectIds: ["proj-1"] });
			expect(page.rows.map(item => item.message)).toEqual(["no project at all", "visible project"]);
		});

		it("an empty allowlist means only the rows that belong to nobody", () => {
			const page = readNotificationLog({ projectIds: [] });
			expect(page.rows.map(item => item.message)).toEqual(["no project at all"]);
		});

		it("no allowlist means no filtering", () => {
			expect(readNotificationLog().rows).toHaveLength(3);
		});
	});
});
