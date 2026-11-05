/**
 * Files in a task's `diffs/` directory: `<timestamp>.patch` (written by every
 * version up to the gzip change, and still by older installs sharing
 * `~/.dev3.0`) and `<timestamp>.patch.gz` (written from then on). Both are
 * read transparently; older versions only ever see the `.patch` ones.
 * Why the split and what an older version sees:
 * decisions/2026/10/28/gzip-task-diff-snapshots.md
 */

import { existsSync, readdirSync, readFileSync, statSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";

export const PLAIN_SNAPSHOT_EXT = ".patch";
export const GZIP_SNAPSHOT_EXT = ".patch.gz";

/** A plain `.patch` modified this recently may still be mid-write by another app version. */
const COMPRESS_MIN_AGE_MS = 60_000;

function snapshotStem(name: string): string | null {
	if (name.endsWith(GZIP_SNAPSHOT_EXT)) return name.slice(0, -GZIP_SNAPSHOT_EXT.length);
	if (name.endsWith(PLAIN_SNAPSHOT_EXT)) return name.slice(0, -PLAIN_SNAPSHOT_EXT.length);
	return null;
}

/** Snapshot file names of both formats, oldest first (timestamp stems sort lexically). */
export function listDiffSnapshots(dir: string): string[] {
	if (!existsSync(dir)) return [];
	return readdirSync(dir)
		.filter((name) => snapshotStem(name) !== null)
		.sort((a, b) => {
			const sa = snapshotStem(a)!;
			const sb = snapshotStem(b)!;
			return sa === sb ? a.localeCompare(b) : sa < sb ? -1 : 1;
		});
}

export function readDiffSnapshot(path: string): string {
	const raw = readFileSync(path);
	return path.endsWith(GZIP_SNAPSHOT_EXT) ? gunzipSync(raw).toString("utf-8") : raw.toString("utf-8");
}

/** Writes `<stem>.patch.gz` and returns its file name. */
export function writeDiffSnapshot(dir: string, stem: string, diff: string): string {
	const name = `${stem}${GZIP_SNAPSHOT_EXT}`;
	writeFileSync(join(dir, name), gzipSync(Buffer.from(diff, "utf-8")));
	return name;
}

export interface CompressDiffsResult {
	compressed: number;
	/** Plain files left alone: too fresh, unreadable, or failed verification. */
	skipped: number;
	bytesBefore: number;
	bytesAfter: number;
}

/**
 * Turns every plain `.patch` in `dir` into a verified `.patch.gz` with the same
 * stem and mtime, then deletes the plain file. A file is only deleted after its
 * gzip copy decompresses back to identical bytes.
 */
export function compressDiffSnapshots(dir: string, now: number = Date.now()): CompressDiffsResult {
	const result: CompressDiffsResult = { compressed: 0, skipped: 0, bytesBefore: 0, bytesAfter: 0 };
	for (const name of listDiffSnapshots(dir)) {
		if (!name.endsWith(PLAIN_SNAPSHOT_EXT)) continue;
		const plainPath = join(dir, name);
		try {
			const stat = statSync(plainPath);
			if (now - stat.mtimeMs < COMPRESS_MIN_AGE_MS) {
				result.skipped++;
				continue;
			}
			const raw = readFileSync(plainPath);
			const gzPath = `${plainPath}.gz`;
			const gz = existsSync(gzPath) ? readFileSync(gzPath) : gzipSync(raw, { level: 9 });
			if (!gunzipSync(gz).equals(raw)) {
				result.skipped++;
				continue;
			}
			if (!existsSync(gzPath)) {
				writeFileSync(gzPath, gz);
				utimesSync(gzPath, stat.atime, stat.mtime);
			}
			unlinkSync(plainPath);
			result.compressed++;
			result.bytesBefore += raw.length;
			result.bytesAfter += gz.length;
		} catch {
			result.skipped++;
		}
	}
	return result;
}

/** Every existing `<root>/<slug>/<shortId>/diffs` directory. */
function allDiffDirs(worktreesRoot: string): string[] {
	const dirs: string[] = [];
	for (const slug of safeListDirs(worktreesRoot)) {
		for (const shortId of safeListDirs(join(worktreesRoot, slug))) {
			const dir = join(worktreesRoot, slug, shortId, "diffs");
			if (existsSync(dir)) dirs.push(dir);
		}
	}
	return dirs;
}

/** Plain `.patch` snapshots still on disk under `worktreesRoot` — what `--gzip-diffs` would compress. */
export function measurePlainDiffSnapshots(worktreesRoot: string): { dirs: number; files: number; bytes: number } {
	const total = { dirs: 0, files: 0, bytes: 0 };
	for (const dir of allDiffDirs(worktreesRoot)) {
		const plain = listDiffSnapshots(dir).filter((name) => name.endsWith(PLAIN_SNAPSHOT_EXT));
		if (plain.length === 0) continue;
		total.dirs++;
		for (const name of plain) {
			total.files++;
			try {
				total.bytes += statSync(join(dir, name)).size;
			} catch { /* vanished between list and stat */ }
		}
	}
	return total;
}

/** {@link compressDiffSnapshots} over every task's `diffs/` under `worktreesRoot`. */
export function compressAllDiffSnapshots(worktreesRoot: string, now: number = Date.now()): CompressDiffsResult & { dirs: number } {
	const total = { dirs: 0, compressed: 0, skipped: 0, bytesBefore: 0, bytesAfter: 0 };
	for (const dir of allDiffDirs(worktreesRoot)) {
		const r = compressDiffSnapshots(dir, now);
		if (r.compressed === 0 && r.skipped === 0) continue;
		total.dirs++;
		total.compressed += r.compressed;
		total.skipped += r.skipped;
		total.bytesBefore += r.bytesBefore;
		total.bytesAfter += r.bytesAfter;
	}
	return total;
}

function safeListDirs(dir: string): string[] {
	try {
		return readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
	} catch {
		return [];
	}
}
