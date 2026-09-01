/**
 * Hourly safety snapshots for every file of user state under ~/.dev3.0.
 *
 * On 2026-08-31 something wiped a chunk of the data root. `projects.json` got
 * this cover afterwards; `spaces.json`, `settings.json`, `agents.json`,
 * `virtual-projects.json` and `model-catalog.json` had the same hole and were
 * lost with it. This module is that one scheme, generalised, so the next file
 * added to the data root is protected by joining a list rather than by
 * re-implementing anything.
 *
 * Every path here is an ADDITIVE sibling (AGENTS.md on-disk rule 5): nothing
 * existing is moved or renamed, and an older app version simply never reads
 * these files. There is deliberately no restore-on-startup — see
 * docs/state-backups.md.
 */

import { mkdir, readFile, readdir, stat, unlink, writeFile } from "node:fs/promises";
import { atomicWriteFile } from "./atomic-write";
import { createLogger } from "./logger";
import { DEV3_HOME } from "./paths";

const log = createLogger("state-backup");

export const HOURLY_BACKUP_FILE_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}Z\.json$/;

/** Three days of hourly copies — the window in which a wipe is noticed. */
export const STATE_BACKUP_RETENTION_HOURS = 72;

/**
 * May the incoming bytes become the copy no rotation can evict?
 *
 * Per file, because the shapes differ and a rule bent to cover all of them is a
 * rule that protects none of them properly. Returning false freezes the good
 * copy for this tick; the dated hourly slot still records the incoming bytes
 * faithfully either way.
 */
export type AdvancePredicate = (incoming: string, existing: string | null) => boolean;

export interface ProtectedStateFile {
	/** Stable name, used in logs and in the docs table. */
	id: string;
	file: string;
	backupDir: string;
	lastKnownGoodFile: string;
	retentionHours: number;
	advance: AdvancePredicate;
}

// ---- Collapse predicates ----

function parseJson(content: string): unknown {
	try {
		return JSON.parse(content);
	} catch {
		return undefined;
	}
}

/** Entries in a top-level JSON array, or null when the bytes are not one. */
export function countArrayEntries(content: string): number | null {
	const parsed = parseJson(content);
	return Array.isArray(parsed) ? parsed.length : null;
}

/** Spaces recorded in `spaces.json`, deleted ones included — deletion is soft,
 *  so this count only ever grows during ordinary use. */
export function countSpaces(content: string): number | null {
	const parsed = parseJson(content) as { version?: unknown; spaces?: unknown; order?: unknown } | undefined;
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
	if (parsed.version !== 1 || !Array.isArray(parsed.spaces) || !Array.isArray(parsed.order)) return null;
	return parsed.spaces.length;
}

/** Providers plus named models — the two halves of the catalog a user authored. */
export function countCatalogEntries(content: string): number | null {
	const parsed = parseJson(content) as { providers?: unknown; models?: unknown } | undefined;
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
	if (!Array.isArray(parsed.providers) || !Array.isArray(parsed.models)) return null;
	return parsed.providers.length + parsed.models.length;
}

/**
 * The list rule, unchanged from the one `projects.json` shipped with: advance
 * unless more than half the entries went at once.
 *
 * The threshold is the whole argument. "Never shrink" would be its own bug — a
 * user who deletes a project would freeze the good copy forever and it would go
 * on holding data they meant to be rid of. "Always advance" is what makes a wipe
 * the only surviving copy. A collapse is the one shape no ordinary editing
 * produces, so it is the one shape worth refusing.
 */
export function collapseGuard(count: (content: string) => number | null): AdvancePredicate {
	return (incoming, existing) => {
		const incomingCount = count(incoming);
		if (incomingCount === null) return false; // Unreadable bytes are never "good".
		if (existing === null) return true;
		const existingCount = count(existing);
		if (existingCount === null) return true; // Anything readable beats an unreadable good copy.
		return incomingCount * 2 >= existingCount;
	};
}

function topLevelKeys(content: string): string[] | null {
	const parsed = parseJson(content);
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
	return Object.keys(parsed);
}

/**
 * `settings.json` is an object, so counting entries is the wrong instrument: the
 * loader drops every default-valued field before writing, so a user turning one
 * toggle back to its default legitimately removes a key.
 *
 * The shape actually worth refusing is the one that happened — the file vanished
 * and came back written from `DEFAULT_SETTINGS`, four keys where twenty had
 * been, which is how a canary build came to read `updateChannel: "stable"` and
 * swap the whole app mid-flight. That shape is a strict SUBSET of the good copy
 * with most of it gone. Ordinary editing either introduces a key or drops a
 * handful, so requiring both conditions leaves normal use untouched.
 */
export const settingsAdvance: AdvancePredicate = (incoming, existing) => {
	const incomingKeys = topLevelKeys(incoming);
	if (incomingKeys === null) return false;
	if (existing === null) return true;
	const existingKeys = topLevelKeys(existing);
	if (existingKeys === null) return true;
	const known = new Set(existingKeys);
	const gainedAKey = incomingKeys.some((key) => !known.has(key));
	if (gainedAKey) return true;
	return incomingKeys.length * 2 >= existingKeys.length;
};

// ---- The registry ----

function protect(id: string, basename: string, advance: AdvancePredicate): ProtectedStateFile {
	const stem = basename.replace(/\.json$/, "");
	return {
		id,
		file: `${DEV3_HOME}/${basename}`,
		backupDir: `${DEV3_HOME}/${stem}-backups`,
		lastKnownGoodFile: `${DEV3_HOME}/${stem}-last-known-good.json`,
		retentionHours: STATE_BACKUP_RETENTION_HOURS,
		advance,
	};
}

/**
 * Every file of user state in the data root, and nothing else.
 *
 * A file earns a place here by being authored by the user and unrecoverable
 * without them. Derived or ephemeral state (window geometry, the last route,
 * port assignments, which tips were seen) is cheaper to recreate than to keep 72
 * copies of, and credentials are deliberately absent: multiplying a live API key
 * into 72 dated files widens its exposure far more than re-pasting it costs.
 * The full table, with the reason per file, is in docs/state-backups.md.
 */
export const PROTECTED_STATE_FILES: ProtectedStateFile[] = [
	protect("projects", "projects.json", collapseGuard(countArrayEntries)),
	protect("virtual-projects", "virtual-projects.json", collapseGuard(countArrayEntries)),
	protect("spaces", "spaces.json", collapseGuard(countSpaces)),
	protect("agents", "agents.json", collapseGuard(countArrayEntries)),
	protect("model-catalog", "model-catalog.json", collapseGuard(countCatalogEntries)),
	protect("settings", "settings.json", settingsAdvance),
];

export function protectedStateFile(id: string): ProtectedStateFile {
	const entry = PROTECTED_STATE_FILES.find((candidate) => candidate.id === id);
	if (!entry) throw new Error(`No protected state file registered under id "${id}"`);
	return entry;
}

// ---- The mechanism ----

function hourlyBackupFileName(now: Date): string {
	return `${now.toISOString().slice(0, 13)}Z.json`;
}

/**
 * At most one snapshot per entry hour, decided with stat() rather than by
 * reading two whole files. The hour is captured before reading, so a
 * boundary-spanning read stays in its start hour. See decision 204.
 *
 * Shared by the task store and every registered state file so the two can never
 * drift into different levels of protection. Returns the bytes it snapshotted,
 * or null when the hour was already covered or the source does not exist yet.
 */
export async function writeHourlySnapshot(
	sourceFile: string,
	backupDir: string,
	retentionHours: number,
	now: Date = new Date(),
): Promise<string | null> {
	const backupFile = `${backupDir}/${hourlyBackupFileName(now)}`;

	try {
		await stat(backupFile);
		return null; // This hour is already snapshotted.
	} catch (err: any) {
		if (err.code !== "ENOENT") throw err;
	}

	let currentContent: string;
	try {
		currentContent = await readFile(sourceFile, "utf8");
	} catch (err: any) {
		if (err.code === "ENOENT") return null;
		throw err;
	}

	await mkdir(backupDir, { recursive: true });
	await writeFile(backupFile, currentContent);

	const backupFiles = (await readdir(backupDir))
		.filter((entry) => HOURLY_BACKUP_FILE_PATTERN.test(entry))
		.sort();
	for (const staleFile of backupFiles.slice(0, Math.max(0, backupFiles.length - retentionHours))) {
		await unlink(`${backupDir}/${staleFile}`);
	}
	return currentContent;
}

/**
 * Advance the un-evictable copy, unless this file's predicate refuses.
 *
 * Hourly and daily snapshots both rotate, so a run of degenerate ones can push
 * every good copy out of the window — which is how the only same-day copy of a
 * 29-project list came to hold one project.
 */
async function advanceLastKnownGood(entry: ProtectedStateFile, content: string): Promise<void> {
	let existing: string | null = null;
	try {
		existing = await readFile(entry.lastKnownGoodFile, "utf8");
	} catch (err: any) {
		if (err.code !== "ENOENT") throw err;
	}

	if (!entry.advance(content, existing)) {
		log.warn("Refusing to advance last-known-good copy: state collapsed", { id: entry.id });
		return;
	}
	await atomicWriteFile(entry.lastKnownGoodFile, content);
}

/** Snapshot one registered file and advance its good copy if the bytes qualify. */
export async function snapshotStateFile(entry: ProtectedStateFile, now: Date = new Date()): Promise<void> {
	const snapshotted = await writeHourlySnapshot(entry.file, entry.backupDir, entry.retentionHours, now);
	if (snapshotted !== null) await advanceLastKnownGood(entry, snapshotted);
}

/**
 * Snapshot every registered file. Driven by a timer, because a save-only trigger
 * snapshots nothing on a day nobody edits — which is exactly why 28-30 Aug 2026
 * have no copy at all. One file failing must not cost the others their tick, so
 * each is guarded on its own.
 */
export async function snapshotProtectedState(now: Date = new Date()): Promise<void> {
	for (const entry of PROTECTED_STATE_FILES) {
		try {
			await snapshotStateFile(entry, now);
		} catch (err) {
			log.warn("State snapshot failed (non-fatal)", { id: entry.id, error: String(err) });
		}
	}
}
