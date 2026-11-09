import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { readdir, rename, stat, unlink } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { createGunzip, createGzip } from "node:zlib";
import { getLogPath } from "./logger";

/** Today and the two days before it stay plain text; anything older is packed. */
export const LOG_ARCHIVE_AFTER_DAYS = 3;
export const LOG_ARCHIVE_SUFFIX = ".tgz";

const DAY_MS = 24 * 60 * 60 * 1000;
const PLAIN_LOG_RE = /^(\d{4})-(\d{2})-(\d{2})\.log$/;
const TEMP_ARCHIVE_RE = /^\d{4}-\d{2}-\d{2}\.log\.tgz\.\d+\.tmp$/;
const STALE_TEMP_MS = 60 * 60 * 1000;
const BLOCK = 512;

function dayOf(fileName: string): number | null {
	const match = PLAIN_LOG_RE.exec(fileName);
	if (!match) return null;
	const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
	const date = new Date(Date.UTC(year, month - 1, day));
	if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
	return date.getTime();
}

function octal(value: number, width: number): string {
	return value.toString(8).padStart(width - 1, "0") + "\0";
}

/** A POSIX ustar header for one regular file — enough for tar, bsdtar, 7-Zip and Finder. */
export function tarHeader(name: string, size: number, mtimeMs: number): Buffer {
	const header = Buffer.alloc(BLOCK);
	header.write(name, 0, 100, "utf8");
	header.write(octal(0o644, 8), 100, "ascii");
	header.write(octal(0, 8), 108, "ascii");
	header.write(octal(0, 8), 116, "ascii");
	header.write(octal(size, 12), 124, "ascii");
	header.write(octal(Math.floor(mtimeMs / 1000), 12), 136, "ascii");
	header.write("        ", 148, "ascii");
	header.write("0", 156, "ascii");
	header.write("ustar\0", 257, "ascii");
	header.write("00", 263, "ascii");
	let checksum = 0;
	for (const byte of header) checksum += byte;
	header.write(octal(checksum, 7) + " ", 148, "ascii");
	return header;
}

function padding(size: number): Buffer {
	return Buffer.alloc((BLOCK - (size % BLOCK)) % BLOCK);
}

async function hashFile(path: string): Promise<{ sha256: string; size: number }> {
	const hash = createHash("sha256");
	let size = 0;
	for await (const chunk of createReadStream(path)) {
		hash.update(chunk as Buffer);
		size += (chunk as Buffer).length;
	}
	return { sha256: hash.digest("hex"), size };
}

/** Unpack the single entry of an archive this module wrote and hash its content. */
export async function readArchiveEntry(archivePath: string): Promise<{ name: string; sha256: string; size: number }> {
	const hash = createHash("sha256");
	let header: Buffer | null = null;
	let pending = Buffer.alloc(0);
	let size = 0;
	let remaining = 0;
	for await (const chunk of createReadStream(archivePath).pipe(createGunzip())) {
		let data = chunk as Buffer;
		if (!header) {
			pending = Buffer.concat([pending, data]);
			if (pending.length < BLOCK) continue;
			header = pending.subarray(0, BLOCK);
			remaining = parseInt(header.toString("ascii", 124, 135), 8);
			if (!Number.isFinite(remaining)) throw new Error("invalid tar size field");
			size = remaining;
			data = pending.subarray(BLOCK);
		}
		if (remaining > 0) {
			const take = Math.min(remaining, data.length);
			hash.update(data.subarray(0, take));
			remaining -= take;
		}
	}
	if (!header) throw new Error("archive too short");
	if (remaining > 0) throw new Error("archive truncated");
	const name = header.toString("utf8", 0, 100).replace(/\0.*$/s, "");
	return { name, sha256: hash.digest("hex"), size };
}

async function matchesSource(archivePath: string, name: string, source: { sha256: string; size: number }): Promise<boolean> {
	try {
		const entry = await readArchiveEntry(archivePath);
		return entry.name === name && entry.size === source.size && entry.sha256 === source.sha256;
	} catch {
		return false;
	}
}

async function exists(path: string): Promise<boolean> {
	try {
		await stat(path);
		return true;
	} catch {
		return false;
	}
}

export type ArchiveOutcome = "archived" | "already-archived" | "skipped";

/**
 * Pack `<dir>/<name>` into `<name>.tgz` and delete the plain file only after the
 * archive has been read back and matches it byte for byte. Any failure leaves the
 * plain file where it was.
 */
export async function archiveLogFile(dir: string, name: string): Promise<ArchiveOutcome> {
	const source = `${dir}/${name}`;
	const archive = `${source}${LOG_ARCHIVE_SUFFIX}`;
	const before = await stat(source);
	const sourceHash = await hashFile(source);

	if (await exists(archive) && await matchesSource(archive, name, sourceHash)) {
		await unlink(source);
		return "already-archived";
	}

	const temp = `${archive}.${process.pid}.tmp`;
	try {
		await pipeline(
			async function* () {
				yield tarHeader(name, sourceHash.size, before.mtimeMs);
				let written = 0;
				if (sourceHash.size > 0) {
					// Exactly the hashed bytes, even if a straggler appends meanwhile.
					for await (const chunk of createReadStream(source, { start: 0, end: sourceHash.size - 1 })) {
						written += (chunk as Buffer).length;
						yield chunk as Buffer;
					}
				}
				if (written !== sourceHash.size) throw new Error("log file changed while archiving");
				yield padding(sourceHash.size);
				yield Buffer.alloc(BLOCK * 2);
			},
			createGzip(),
			createWriteStream(temp),
		);
		const after = await stat(source);
		if (after.size !== before.size || after.mtimeMs !== before.mtimeMs) return "skipped";
		if (!(await matchesSource(temp, name, sourceHash))) return "skipped";
		await rename(temp, archive);
		if (!(await matchesSource(archive, name, sourceHash))) return "skipped";
		await unlink(source);
		return "archived";
	} finally {
		await unlink(temp).catch(() => {});
	}
}

async function listDir(path: string): Promise<{ name: string; dir: boolean; file: boolean }[]> {
	try {
		const entries = await readdir(path, { withFileTypes: true });
		return entries.map((entry) => ({ name: entry.name, dir: entry.isDirectory(), file: entry.isFile() }));
	} catch {
		return [];
	}
}

async function removeStaleTemp(path: string, nowMs: number): Promise<void> {
	try {
		if (nowMs - (await stat(path)).mtimeMs > STALE_TEMP_MS) await unlink(path);
	} catch {
		// Another process may be finishing it right now.
	}
}

/** Archive every `YYYY/MM/YYYY-MM-DD.log` at least LOG_ARCHIVE_AFTER_DAYS old. Never throws. */
export async function archiveOldLogs(now: Date = new Date(), root: string = getLogPath()): Promise<{ archived: number; failed: number }> {
	const today = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
	const cutoff = today - (LOG_ARCHIVE_AFTER_DAYS - 1) * DAY_MS;
	let archived = 0;
	let failed = 0;
	for (const year of await listDir(root)) {
		if (!year.dir || !/^\d{4}$/.test(year.name)) continue;
		for (const month of await listDir(`${root}/${year.name}`)) {
			if (!month.dir || !/^\d{2}$/.test(month.name)) continue;
			const dir = `${root}/${year.name}/${month.name}`;
			for (const file of await listDir(dir)) {
				if (!file.file) continue;
				if (TEMP_ARCHIVE_RE.test(file.name)) {
					await removeStaleTemp(`${dir}/${file.name}`, now.getTime());
					continue;
				}
				const day = dayOf(file.name);
				if (day === null || day >= cutoff) continue;
				try {
					const outcome = await archiveLogFile(dir, file.name);
					if (outcome === "skipped") failed += 1;
					else archived += 1;
				} catch {
					failed += 1;
				}
			}
		}
	}
	return { archived, failed };
}
