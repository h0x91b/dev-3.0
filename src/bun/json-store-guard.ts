/**
 * Reading a JSON store without ever mistaking "unreadable" for "empty".
 *
 * A loader that turns a parse error into `[]` hands the caller defaults, and the
 * caller then saves them over the user's file — which is how a torn read during
 * startup wiped every custom agent preset (h0x91b/dev-3.0#2434). These helpers
 * keep the three outcomes apart, ride out a transient torn read, and copy
 * unreadable bytes aside instead of letting them be overwritten.
 *
 * Every file written here is an additive sibling (`<file>.corrupt-<ts>`); nothing
 * existing is moved or renamed (AGENTS.md on-disk rules).
 */

import { readFile, readdir, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

export type GuardedJsonRead<T> =
	| { kind: "missing" }
	| { kind: "ok"; data: T }
	| { kind: "corrupt"; raw: string; error: string };

/** Backoff between re-reads of an unparsable file. An in-place writer (an older
 *  app version still running) finishes a few-hundred-KB write well inside this. */
export const TORN_READ_RETRY_DELAYS_MS = [25, 100, 250];

function parseAs<T>(raw: string, isValid: (data: unknown) => data is T): { ok: true; data: T } | { ok: false; error: string } {
	if (raw.trim() === "") return { ok: false, error: "file is empty" };
	try {
		const data: unknown = JSON.parse(raw);
		return isValid(data) ? { ok: true, data } : { ok: false, error: "unexpected JSON shape" };
	} catch (err) {
		return { ok: false, error: String(err) };
	}
}

/**
 * Read and validate `file`, re-reading a few times when the bytes do not parse.
 * An empty file or a valid document of the wrong shape counts as corrupt: both
 * are what a half-finished in-place write looks like from outside.
 */
export async function readJsonGuarded<T>(
	file: string,
	isValid: (data: unknown) => data is T,
	retryDelaysMs: readonly number[] = TORN_READ_RETRY_DELAYS_MS,
): Promise<GuardedJsonRead<T>> {
	for (let attempt = 0; ; attempt++) {
		let raw: string;
		try {
			raw = await readFile(file, "utf8");
		} catch (err: any) {
			if (err?.code === "ENOENT") return { kind: "missing" };
			throw err;
		}
		const parsed = parseAs(raw, isValid);
		if (parsed.ok) return { kind: "ok", data: parsed.data };
		if (attempt >= retryDelaysMs.length) return { kind: "corrupt", raw, error: parsed.error };
		await new Promise((resolve) => setTimeout(resolve, retryDelaysMs[attempt]));
	}
}

/** Parse a fallback copy (e.g. the last-known-good snapshot), or null when it is absent or unusable. */
export async function readJsonFallback<T>(file: string, isValid: (data: unknown) => data is T): Promise<T | null> {
	const read = await readJsonGuarded(file, isValid, []);
	return read.kind === "ok" ? read.data : null;
}

/**
 * Copy unreadable bytes to `<file>.corrupt-<timestamp>` so nothing that later
 * rewrites `file` can destroy them. Identical bytes already copied are not copied
 * again — a loader runs on every read, and a stuck file must not fill the disk.
 * Returns the backup path, the existing one for a repeat, or null on failure.
 */
export async function backupCorruptFile(file: string, raw: string, now: Date = new Date()): Promise<string | null> {
	const dir = dirname(file);
	const prefix = `${basename(file)}.corrupt-`;
	try {
		for (const name of await readdir(dir)) {
			if (!name.startsWith(prefix)) continue;
			const existing = join(dir, name);
			if ((await readFile(existing, "utf8").catch(() => null)) === raw) return existing;
		}
		const target = join(dir, `${prefix}${now.toISOString().replace(/[:.]/g, "-")}`);
		await writeFile(target, raw, { flag: "wx" });
		return target;
	} catch {
		return null;
	}
}
