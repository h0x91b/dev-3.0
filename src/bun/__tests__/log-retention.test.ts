import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";

const home = vi.hoisted(() => require("node:fs").mkdtempSync(`${require("node:os").tmpdir()}/dev3-logretention-`) as string);
vi.mock("../paths", () => ({ DEV3_HOME: home, OPS_DIR: `${home}/ops`, SANDBOX_DIR: `${home}/sandbox` }));
vi.mock("../logger", () => ({
	createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock("../rpc-handlers/shared-pure", () => ({ getPushMessage: () => undefined }));

import type { Project } from "../../shared/types";
import { collectLogRetentionUsage, pruneAllLogs } from "../log-retention";
import { messageLogDir } from "../agent-message-log";
import { notificationLogDir } from "../notification-log";

const projects = [
	{ id: "a", name: "A", path: "/Users/x/repo-a" },
	{ id: "b", name: "B", path: "/Users/x/repo-b" },
] as unknown as Project[];

function write(dir: string, day: string, bytes: number) {
	mkdirSync(dir, { recursive: true });
	writeFileSync(`${dir}/${day}.jsonl`, "x".repeat(bytes));
}

beforeEach(() => {
	rmSync(notificationLogDir(), { recursive: true, force: true });
	for (const project of projects) rmSync(messageLogDir(project), { recursive: true, force: true });
});

afterEach(() => rmSync(home, { recursive: true, force: true }));

describe("collectLogRetentionUsage", () => {
	it("sums the notification log and every project's message log by day", () => {
		write(notificationLogDir(), "2026-11-01", 10);
		write(notificationLogDir(), "2026-11-02", 5);
		write(messageLogDir(projects[0]), "2026-11-01", 100);
		write(messageLogDir(projects[1]), "2026-11-01", 1000);
		write(messageLogDir(projects[1]), "2026-10-31", 7);
		writeFileSync(`${messageLogDir(projects[1])}/notes.txt`, "not a day file");

		expect(collectLogRetentionUsage(projects)).toEqual({
			days: [
				{ day: "2026-10-31", bytes: 7 },
				{ day: "2026-11-01", bytes: 1110 },
				{ day: "2026-11-02", bytes: 5 },
			],
		});
	});

	it("works out what a shorter retention would delete by the host's clock", () => {
		const now = new Date(2026, 10, 15);
		write(notificationLogDir(), "2026-11-14", 10);
		write(messageLogDir(projects[0]), "2026-11-14", 100);
		write(messageLogDir(projects[0]), "2026-01-01", 1000);
		write(notificationLogDir(), "2026-01-01", 5);
		expect(collectLogRetentionUsage(projects, 30, now).beyond).toEqual({ days: 1, bytes: 1005 });
		expect(collectLogRetentionUsage(projects, 365, now).beyond).toEqual({ days: 0, bytes: 0 });
		expect(collectLogRetentionUsage(projects, undefined, now)).not.toHaveProperty("beyond");
	});

	it("answers no days when nothing was ever logged", () => {
		expect(collectLogRetentionUsage(projects)).toEqual({ days: [] });
	});
});

describe("pruneAllLogs", () => {
	it("applies the retention to the notification log and every project", () => {
		const now = new Date(2026, 10, 15);
		for (const dir of [notificationLogDir(), messageLogDir(projects[0]), messageLogDir(projects[1])]) {
			write(dir, "2026-11-14", 1);
			write(dir, "2026-01-01", 1);
		}
		pruneAllLogs(projects, 30, now);
		for (const dir of [notificationLogDir(), messageLogDir(projects[0]), messageLogDir(projects[1])]) {
			expect(readdirSync(dir)).toEqual(["2026-11-14.jsonl"]);
		}
	});

	it("deletes nothing for forever", () => {
		write(notificationLogDir(), "2001-01-01", 1);
		write(messageLogDir(projects[0]), "2001-01-01", 1);
		pruneAllLogs(projects, null, new Date(2026, 10, 15));
		expect(readdirSync(notificationLogDir())).toHaveLength(1);
		expect(readdirSync(messageLogDir(projects[0]))).toHaveLength(1);
	});
});
