/**
 * On-disk namespace for the persistent native-session registry (seq 1214).
 *
 * ISOLATION: an ADDITIVE, dedicated namespace under a NEW `~/.dev3.0/
 * native-sessions/` root, overridable via DEV3_NATIVE_SESSIONS_DIR (tests point
 * it at a tmpdir). It never touches, renames, or deletes any existing
 * `~/.dev3.0/` entry, so the frozen on-disk layout and every already-running
 * dev3/tmux flow are unaffected (AGENTS.md on-disk invariants).
 *
 * Every session gets its OWN subdirectory keyed by a stable, caller-supplied
 * session id, so N sessions coexist without a shared mutable index file.
 *
 * Dependency-light on purpose: only node:path — no Bun runtime — so the pure
 * path/validation logic is unit-testable under vitest (which stubs Bun).
 */

import { join } from "node:path";

export const NATIVE_SESSIONS_DIR_ENV = "DEV3_NATIVE_SESSIONS_DIR";

export const NATIVE_HOST_IMAGES_DIR_ENV = "DEV3_NATIVE_HOST_IMAGES_DIR";

function dev3HomeDir(): string {
	return process.env.DEV3_HOME || `${process.env.HOME || process.env.USERPROFILE || "/tmp"}/.dev3.0`;
}

/** Root of the registry namespace: env override, else additive `~/.dev3.0/native-sessions/`. */
export function sessionsRootDir(): string {
	const explicit = process.env[NATIVE_SESSIONS_DIR_ENV];
	if (explicit) return explicit;
	return join(dev3HomeDir(), "native-sessions");
}

/**
 * Root the packaged host images are staged into: env override, else an additive
 * `~/.dev3.0/native-host-images/`. Deliberately OUTSIDE the replaceable
 * installation directory, so an update that swaps the app bundle cannot delete
 * the image a running host was launched from.
 */
export function hostImagesRootDir(): string {
	const explicit = process.env[NATIVE_HOST_IMAGES_DIR_ENV];
	if (explicit) return explicit;
	return join(dev3HomeDir(), "native-host-images");
}

// Stable session ids are chosen by launchers, so they must map to a safe single
// directory segment — no path separators, no traversal, no leading dot.
const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export function isValidSessionId(id: string): boolean {
	return typeof id === "string" && SESSION_ID_PATTERN.test(id) && !id.includes("..");
}

export function assertValidSessionId(id: string): void {
	if (!isValidSessionId(id)) {
		throw new Error(
			`invalid native session id ${JSON.stringify(id)} — allowed: ${SESSION_ID_PATTERN.source} and no "..".`,
		);
	}
}

export function sessionDir(id: string): string {
	assertValidSessionId(id);
	return join(sessionsRootDir(), id);
}

export function recordFile(id: string): string {
	return join(sessionDir(id), "record.json");
}

/** Private per-session bearer token (mode 0600); never part of record.json. */
export function tokenFile(id: string): string {
	return join(sessionDir(id), "token");
}

export function logFile(id: string): string {
	return join(sessionDir(id), "host.log");
}

/** Independent per-session output journal (bounded, append-only). */
export function journalFile(id: string): string {
	return join(sessionDir(id), "journal.ndjson");
}

/** Live-parser semantic snapshot (seq 1228) — bounded, atomic, additive. */
export function parserStateFile(id: string): string {
	return join(sessionDir(id), "parser-state.json");
}

/**
 * Compact plain-text capture projection — bounded, atomic. Sibling of
 * the per-cell snapshot, not a replacement for it: reconnect still wants cells,
 * a capture only wants rows.
 */
export function captureRecordFile(id: string): string {
	return join(sessionDir(id), "capture.json");
}

/** Ordered ground-truth stream tap (seq 1228) — proof runs only, env-gated. */
export function streamTapFile(id: string): string {
	return join(sessionDir(id), "stream-tap.ndjson");
}
