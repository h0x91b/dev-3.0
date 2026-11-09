import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { archiveLogFile, archiveOldLogs, readArchiveEntry } from "../log-archive";
import { pruneLogFiles } from "../logger";

const NOW = new Date(2026, 10, 9, 18);

let root: string;

function writeDay(day: string, content = `${day} 00:00:00.000 INFO  [1:test] line\n`.repeat(200)): string {
	const dir = join(root, day.slice(0, 4), day.slice(5, 7));
	mkdirSync(dir, { recursive: true });
	const file = join(dir, `${day}.log`);
	writeFileSync(file, content);
	return file;
}

function filesIn(day: string): string[] {
	return readdirSync(join(root, day.slice(0, 4), day.slice(5, 7))).sort();
}

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "dev3-log-archive-"));
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
	vi.restoreAllMocks();
});

describe("archiveOldLogs", () => {
	it("packs files three or more days old and leaves today and the two days before plain", async () => {
		for (const day of ["2026-11-09", "2026-11-08", "2026-11-07", "2026-11-06", "2026-10-31"]) writeDay(day);

		expect(await archiveOldLogs(NOW, root)).toEqual({ archived: 2, failed: 0 });

		expect(filesIn("2026-11-09")).toEqual([
			"2026-11-06.log.tgz",
			"2026-11-07.log",
			"2026-11-08.log",
			"2026-11-09.log",
		]);
		expect(filesIn("2026-10-31")).toEqual(["2026-10-31.log.tgz"]);
	});

	it("is idempotent: a second run changes nothing", async () => {
		writeDay("2026-11-01");
		await archiveOldLogs(NOW, root);
		const archive = join(root, "2026", "11", "2026-11-01.log.tgz");
		const first = readFileSync(archive);

		expect(await archiveOldLogs(NOW, root)).toEqual({ archived: 0, failed: 0 });
		expect(readFileSync(archive).equals(first)).toBe(true);
	});

	it("ignores non-log files and directories that are not YYYY/MM, like freeze/", async () => {
		mkdirSync(join(root, "freeze", "11"), { recursive: true });
		writeFileSync(join(root, "freeze", "11", "2026-11-01.log"), "freeze capture");
		writeDay("2026-11-01");
		writeFileSync(join(root, "2026", "11", "notes.txt"), "keep");

		await archiveOldLogs(NOW, root);

		expect(existsSync(join(root, "freeze", "11", "2026-11-01.log"))).toBe(true);
		expect(filesIn("2026-11-01")).toEqual(["2026-11-01.log.tgz", "notes.txt"]);
	});

	it("never throws on a missing root", async () => {
		await expect(archiveOldLogs(NOW, join(root, "missing"))).resolves.toEqual({ archived: 0, failed: 0 });
	});

	it("removes an abandoned temp archive but not a fresh one", async () => {
		const dir = join(root, "2026", "11");
		mkdirSync(dir, { recursive: true });
		const stale = join(dir, "2026-11-01.log.tgz.123.tmp");
		const fresh = join(dir, "2026-11-02.log.tgz.456.tmp");
		writeFileSync(stale, "x");
		writeFileSync(fresh, "x");
		const twoHoursAgo = (NOW.getTime() - 2 * 60 * 60 * 1000) / 1000;
		utimesSync(stale, twoHoursAgo, twoHoursAgo);
		utimesSync(fresh, NOW.getTime() / 1000, NOW.getTime() / 1000);

		await archiveOldLogs(NOW, root);

		expect(existsSync(stale)).toBe(false);
		expect(existsSync(fresh)).toBe(true);
	});
});

describe("archiveLogFile verify-before-delete", () => {
	it("round-trips the exact bytes", async () => {
		const content = "héllo\n".repeat(5000) + "no trailing newline";
		const file = writeDay("2026-11-01", content);
		const dir = join(root, "2026", "11");

		expect(await archiveLogFile(dir, "2026-11-01.log")).toBe("archived");
		expect(existsSync(file)).toBe(false);

		const tar = gunzipSync(readFileSync(`${file}.tgz`));
		const size = parseInt(tar.toString("ascii", 124, 135), 8);
		expect(tar.subarray(512, 512 + size).toString("utf8")).toBe(content);
		expect((await readArchiveEntry(`${file}.tgz`)).name).toBe("2026-11-01.log");
	});

	it("handles an empty day file", async () => {
		const file = writeDay("2026-11-01", "");
		expect(await archiveLogFile(join(root, "2026", "11"), "2026-11-01.log")).toBe("archived");
		expect((await readArchiveEntry(`${file}.tgz`)).size).toBe(0);
	});

	it("rewrites a corrupt archive instead of trusting it, keeping the log until the new one verifies", async () => {
		const file = writeDay("2026-11-01");
		writeFileSync(`${file}.tgz`, "not a gzip stream");

		expect(await archiveLogFile(join(root, "2026", "11"), "2026-11-01.log")).toBe("archived");
		expect(existsSync(file)).toBe(false);
		expect((await readArchiveEntry(`${file}.tgz`)).name).toBe("2026-11-01.log");
	});

	it("an archive that matches the log already only removes the log", async () => {
		const file = writeDay("2026-11-01");
		const dir = join(root, "2026", "11");
		await archiveLogFile(dir, "2026-11-01.log");
		writeDay("2026-11-01");

		expect(await archiveLogFile(dir, "2026-11-01.log")).toBe("already-archived");
		expect(existsSync(file)).toBe(false);
	});

	it("keeps the log when the archive was written from different content", async () => {
		const file = writeDay("2026-11-01");
		const dir = join(root, "2026", "11");
		await archiveLogFile(dir, "2026-11-01.log");
		// A late writer recreated the day file with new lines after it was packed.
		writeDay("2026-11-01", "late line\n");

		expect(await archiveLogFile(dir, "2026-11-01.log")).toBe("archived");
		expect(existsSync(file)).toBe(false);
		expect((await readArchiveEntry(`${file}.tgz`)).size).toBe("late line\n".length);
	});
});

describe("reader compatibility", () => {
	it.skipIf(process.platform === "win32")("system tar extracts the archive", async () => {
		const content = "2026-11-01 00:00:00.000 INFO  [1:test] hello\n";
		const file = writeDay("2026-11-01", content);
		await archiveLogFile(join(root, "2026", "11"), "2026-11-01.log");

		expect(execFileSync("tar", ["-xOzf", `${file}.tgz`], { encoding: "utf8" })).toBe(content);
	});

	it("retention prunes archives on the same 14-day window as plain logs", () => {
		writeDay("2026-10-20");
		writeDay("2026-10-30");
		const dir = join(root, "2026", "10");
		writeFileSync(join(dir, "2026-10-21.log.tgz"), "x");
		writeFileSync(join(dir, "2026-10-31.log.tgz"), "x");

		expect(pruneLogFiles(NOW, root)).toBe(2);
		expect(readdirSync(dir).sort()).toEqual(["2026-10-30.log", "2026-10-31.log.tgz"]);
	});

	it("the pre-archive retention regex skips .tgz files, so older app versions leave them alone", () => {
		const legacy = /^(\d{4})-(\d{2})-(\d{2})\.log$/;
		expect(legacy.test("2026-11-01.log.tgz")).toBe(false);
	});
});
