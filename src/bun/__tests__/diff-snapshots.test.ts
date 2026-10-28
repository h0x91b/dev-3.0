import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import {
	compressAllDiffSnapshots,
	compressDiffSnapshots,
	listDiffSnapshots,
	measurePlainDiffSnapshots,
	readDiffSnapshot,
	writeDiffSnapshot,
} from "../diff-snapshots";

const DIFF = "diff --git a/ünïcode.ts b/ünïcode.ts\n+export const x = \"✓\";\n".repeat(200);
const OLD = new Date("2026-01-01T00:00:00Z");

let dir: string;

function writePlain(name: string, content: string, mtime: Date = OLD): void {
	writeFileSync(join(dir, name), content);
	utimesSync(join(dir, name), mtime, mtime);
}

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "dev3-diff-snapshots-"));
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe("diff snapshot files", () => {
	it("round-trips a diff through the gzip format", () => {
		const name = writeDiffSnapshot(dir, "2026-10-28T10-00-00", DIFF);
		expect(name).toBe("2026-10-28T10-00-00.patch.gz");
		const raw = readFileSync(join(dir, name));
		expect(raw[0]).toBe(0x1f);
		expect(raw[1]).toBe(0x8b);
		expect(raw.length).toBeLessThan(Buffer.byteLength(DIFF) / 10);
		expect(readDiffSnapshot(join(dir, name))).toBe(DIFF);
	});

	it("reads an old uncompressed .patch as-is", () => {
		writePlain("2026-03-10T19-23-18.patch", DIFF);
		expect(readDiffSnapshot(join(dir, "2026-03-10T19-23-18.patch"))).toBe(DIFF);
	});

	it("reads a new compressed .patch.gz", () => {
		writeFileSync(join(dir, "2026-10-28T10-00-00.patch.gz"), gzipSync(DIFF));
		expect(readDiffSnapshot(join(dir, "2026-10-28T10-00-00.patch.gz"))).toBe(DIFF);
	});

	it("lists both formats in timestamp order, ignoring everything else", () => {
		writePlain("2026-03-10T19-23-18.patch", "a");
		writeDiffSnapshot(dir, "2026-03-09T00-00-00", "b");
		writeDiffSnapshot(dir, "2026-03-11T00-00-00", "c");
		writeFileSync(join(dir, ".DS_Store"), "");
		writeFileSync(join(dir, "notes.txt"), "");
		expect(listDiffSnapshots(dir)).toEqual([
			"2026-03-09T00-00-00.patch.gz",
			"2026-03-10T19-23-18.patch",
			"2026-03-11T00-00-00.patch.gz",
		]);
	});

	it("lists nothing for a missing directory", () => {
		expect(listDiffSnapshots(join(dir, "nope"))).toEqual([]);
	});
});

describe("compressDiffSnapshots", () => {
	it("replaces each plain .patch with an identical .patch.gz keeping its mtime", () => {
		writePlain("2026-03-10T19-23-18.patch", DIFF);
		writePlain("2026-03-10T19-32-52.patch", `${DIFF}more\n`);

		const result = compressDiffSnapshots(dir, Date.now());

		expect(result.compressed).toBe(2);
		expect(result.skipped).toBe(0);
		expect(result.bytesAfter).toBeLessThan(result.bytesBefore);
		expect(readdirSync(dir).sort()).toEqual(["2026-03-10T19-23-18.patch.gz", "2026-03-10T19-32-52.patch.gz"]);
		expect(gunzipSync(readFileSync(join(dir, "2026-03-10T19-23-18.patch.gz"))).toString("utf-8")).toBe(DIFF);
		expect(statSync(join(dir, "2026-03-10T19-23-18.patch.gz")).mtimeMs).toBe(OLD.getTime());
	});

	it("leaves a plain file written in the last minute alone", () => {
		const now = Date.now();
		writePlain("2026-10-28T10-00-00.patch", DIFF, new Date(now - 5_000));
		expect(compressDiffSnapshots(dir, now)).toMatchObject({ compressed: 0, skipped: 1 });
		expect(readdirSync(dir)).toEqual(["2026-10-28T10-00-00.patch"]);
	});

	it("keeps the plain file when a same-stem .patch.gz holds different content", () => {
		writePlain("2026-03-10T19-23-18.patch", DIFF);
		writeFileSync(join(dir, "2026-03-10T19-23-18.patch.gz"), gzipSync("something else"));
		expect(compressDiffSnapshots(dir, Date.now())).toMatchObject({ compressed: 0, skipped: 1 });
		expect(readFileSync(join(dir, "2026-03-10T19-23-18.patch"), "utf-8")).toBe(DIFF);
	});

	it("drops the plain file when a same-stem .patch.gz already holds it", () => {
		writePlain("2026-03-10T19-23-18.patch", DIFF);
		writeFileSync(join(dir, "2026-03-10T19-23-18.patch.gz"), gzipSync(DIFF));
		expect(compressDiffSnapshots(dir, Date.now())).toMatchObject({ compressed: 1, skipped: 0 });
		expect(readdirSync(dir)).toEqual(["2026-03-10T19-23-18.patch.gz"]);
	});

	it("is a no-op the second time", () => {
		writePlain("2026-03-10T19-23-18.patch", DIFF);
		compressDiffSnapshots(dir, Date.now());
		expect(compressDiffSnapshots(dir, Date.now())).toMatchObject({ compressed: 0, skipped: 0 });
	});
});

describe("whole-tree helpers", () => {
	it("measure and compress every task's diffs/ directory", () => {
		const a = join(dir, "slug-a", "aaaaaaaa", "diffs");
		const b = join(dir, "slug-b", "bbbbbbbb", "diffs");
		mkdirSync(a, { recursive: true });
		mkdirSync(b, { recursive: true });
		mkdirSync(join(dir, "slug-b", "cccccccc"), { recursive: true });
		for (const d of [a, b]) {
			writeFileSync(join(d, "2026-03-10T19-23-18.patch"), DIFF);
			utimesSync(join(d, "2026-03-10T19-23-18.patch"), OLD, OLD);
		}

		expect(measurePlainDiffSnapshots(dir)).toEqual({ dirs: 2, files: 2, bytes: 2 * Buffer.byteLength(DIFF) });
		const result = compressAllDiffSnapshots(dir, Date.now());
		expect(result).toMatchObject({ dirs: 2, compressed: 2, skipped: 0, bytesBefore: 2 * Buffer.byteLength(DIFF) });
		expect(measurePlainDiffSnapshots(dir)).toEqual({ dirs: 0, files: 0, bytes: 0 });
	});

	it("tolerates a missing worktrees root", () => {
		expect(compressAllDiffSnapshots(join(dir, "missing"))).toMatchObject({ dirs: 0, compressed: 0 });
	});
});
