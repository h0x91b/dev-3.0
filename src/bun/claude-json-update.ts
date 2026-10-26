/**
 * The way dev3 changes a `.claude.json` while Claude Code may be writing it too.
 *
 * Claude Code (read out of the 2.1.310 binary, and watched on disk) saves the
 * file under proper-lockfile's mkdir lock at `<file>.lock`, re-reads the file
 * under that lock, and replaces it by rename. dev3 used to do a plain
 * read-modify-write: no lock, and a truncate-then-write that a concurrent reader
 * can catch half-written. A trust entry written that way can be erased by the
 * next Claude save (#2034). So: same lock, read under it, rename into place.
 *
 * The lock only coordinates with writers that take it. A Claude build that does
 * not, or one that falls back to an unlocked write, can still overwrite us; the
 * mtime/size check before the rename narrows that, it cannot close it.
 * See `decisions/2026/10/26/claude-json-writes-take-claude-codes-lock.md`.
 */
import { mkdir, readFile, rename, rmdir, stat, unlink, writeFile } from "node:fs/promises";
import type { Stats } from "node:fs";
import { dirname } from "node:path";
import { createLogger } from "./logger";

const log = createLogger("claude-json-update");

/** proper-lockfile's default `stale`: a lock dir untouched this long belongs to a dead holder. */
export const CLAUDE_JSON_LOCK_STALE_MS = 10_000;
/**
 * A live lock is never written around: that write is exactly what a Claude save
 * in progress overwrites. Polled often, because several booting Claudes queue on
 * this lock and a slow poller loses every mkdir race (measured: 7 of 400 writes
 * fell back after a 3 s budget). Past the stale window a holder that is still
 * alive would have refreshed it, so the budget ends just after it.
 */
const LOCK_WAIT_MS = CLAUDE_JSON_LOCK_STALE_MS + 2_000;
const LOCK_POLL_MS = 25;
/** How many times a writer that ignores the lock may push us into a re-read. */
const MAX_WRITE_ATTEMPTS = 3;

export type ClaudeJsonUpdateResult = "written" | "unchanged" | "unparsable" | "unreadable" | "busy";

export interface ClaudeJsonUpdateOptions {
	sleep?: (ms: number) => Promise<void>;
	now?: () => number;
	lockWaitMs?: number;
}

/** Changes `data` in place; returns false when there was nothing to change. */
export type ClaudeJsonMutation = (data: Record<string, unknown>) => boolean;

export function claudeJsonLockPath(file: string): string {
	return `${file}.lock`;
}

/**
 * Apply `mutate` to `file` under Claude Code's lock and replace the file
 * atomically. Never rewrites a file it cannot parse. Never throws.
 */
export async function updateClaudeJson(
	file: string,
	mutate: ClaudeJsonMutation,
	opts: ClaudeJsonUpdateOptions = {},
): Promise<ClaudeJsonUpdateResult> {
	try {
		await mkdir(dirname(file), { recursive: true });
	} catch (err) {
		log.warn("Cannot create the .claude.json directory", { file, error: String(err) });
		return "unreadable";
	}
	const release = await acquireClaudeJsonLock(file, opts);
	if (!release) log.warn("Claude Code's .claude.json lock stayed busy past its stale window; writing without it", { file });
	try {
		for (let attempt = 1; attempt <= MAX_WRITE_ATTEMPTS; attempt++) {
			const read = await readClaudeJson(file);
			if (read.kind !== "ok") return read.kind;
			if (!mutate(read.data)) return "unchanged";
			if (await replaceIfUnchanged(file, JSON.stringify(read.data, null, 2), read.before)) return "written";
			log.info(".claude.json changed while we held it, re-reading", { file, attempt });
		}
		return "busy";
	} finally {
		await release?.();
	}
}

type ReadOutcome =
	| { kind: "ok"; data: Record<string, unknown>; before: Stats | null }
	| { kind: "unparsable" | "unreadable" };

async function readClaudeJson(file: string): Promise<ReadOutcome> {
	let before: Stats;
	let raw: string;
	try {
		before = await stat(file);
		raw = await readFile(file, "utf-8");
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return { kind: "ok", data: {}, before: null };
		log.warn("Cannot read .claude.json, leaving it alone", { file, error: String(err) });
		return { kind: "unreadable" };
	}
	try {
		const data: unknown = JSON.parse(raw);
		if (data && typeof data === "object" && !Array.isArray(data)) {
			return { kind: "ok", data: data as Record<string, unknown>, before };
		}
	} catch {
		// fall through
	}
	log.warn("Unparsable .claude.json, leaving it alone", { file });
	return { kind: "unparsable" };
}

/** Rename `content` over `file` only if nobody touched the file since `before`. */
async function replaceIfUnchanged(file: string, content: string, before: Stats | null): Promise<boolean> {
	const tmp = `${file}.dev3-${process.pid}-${crypto.randomUUID().slice(0, 8)}.tmp`;
	try {
		await writeFile(tmp, content, { mode: before ? before.mode & 0o777 : 0o600 });
		if (!(await sameFileState(file, before))) {
			await unlink(tmp).catch(() => {});
			return false;
		}
		await rename(tmp, file);
		return true;
	} catch (err) {
		log.warn("Failed to replace .claude.json", { file, error: String(err) });
		await unlink(tmp).catch(() => {});
		return false;
	}
}

async function sameFileState(file: string, before: Stats | null): Promise<boolean> {
	try {
		const now = await stat(file);
		return !!before && now.mtimeMs === before.mtimeMs && now.size === before.size;
	} catch (err) {
		return before === null && (err as NodeJS.ErrnoException).code === "ENOENT";
	}
}

/**
 * Take `<file>.lock` the way proper-lockfile does — `mkdir`, and a lock dir whose
 * mtime is older than the stale window is a dead holder's and may be removed.
 * Returns the release function, or null when the lock could not be had.
 */
export async function acquireClaudeJsonLock(
	file: string,
	opts: ClaudeJsonUpdateOptions = {},
): Promise<(() => Promise<void>) | null> {
	const lockPath = claudeJsonLockPath(file);
	const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
	const now = opts.now ?? Date.now;
	const deadline = now() + (opts.lockWaitMs ?? LOCK_WAIT_MS);
	let stolen = false;
	for (;;) {
		try {
			await mkdir(lockPath);
			return async () => {
				await rmdir(lockPath).catch(() => {});
			};
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code !== "EEXIST") {
				log.warn("Cannot take Claude Code's .claude.json lock", { file, error: String(err) });
				return null;
			}
		}
		if (!stolen && (await isStaleLock(lockPath, now()))) {
			stolen = true;
			log.info("Removing a stale .claude.json lock", { lockPath });
			await rmdir(lockPath).catch(() => {});
			continue;
		}
		if (now() >= deadline) return null;
		await sleep(LOCK_POLL_MS + Math.floor(Math.random() * LOCK_POLL_MS));
	}
}

async function isStaleLock(lockPath: string, nowMs: number): Promise<boolean> {
	try {
		return (await stat(lockPath)).mtimeMs < nowMs - CLAUDE_JSON_LOCK_STALE_MS;
	} catch {
		// Vanished between mkdir and stat: the next mkdir answers.
		return false;
	}
}
