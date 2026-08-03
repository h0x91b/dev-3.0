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

import { dirname, join } from "node:path";
import type { CaptureProducerDigest } from "./capture-digest";

export const NATIVE_SESSIONS_DIR_ENV = "DEV3_NATIVE_SESSIONS_DIR";

export const NATIVE_HOST_IMAGES_DIR_ENV = "DEV3_NATIVE_HOST_IMAGES_DIR";

export const NATIVE_SESSION_LOCKS_DIR_ENV = "DEV3_NATIVE_SESSION_LOCKS_DIR";

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
 * Root of the session-state lock family: its own top-level sibling, never inside
 * `native-sessions` or a session directory — enumerators of that root read entries
 * as sessions, and a lock living inside a directory keeps it alive through teardown.
 *
 * When only the SESSIONS root is overridden (tests, custom deployments), the locks
 * root is derived beside it rather than falling back to the real home, so an
 * isolated run cannot write lock state into a user's profile.
 */
export function sessionLocksRootDir(): string {
	const explicit = process.env[NATIVE_SESSION_LOCKS_DIR_ENV];
	if (explicit) return explicit;
	const sessionsOverride = process.env[NATIVE_SESSIONS_DIR_ENV];
	if (sessionsOverride) return `${sessionsOverride.replace(/[/\\]+$/, "")}-locks`;
	return join(dev3HomeDir(), "native-session-locks");
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
 * Compact plain-text capture artifact, one path per PRODUCER. Scoping the path is
 * what makes a stale producer physically unable to publish over its successor:
 * there is no shared name to race for, so no ownership check to get wrong.
 */
export function captureRecordFile(id: string, producerDigest: CaptureProducerDigest): string {
	const file = join(sessionDir(id), `capture.${producerDigest}.json`);
	// The digest is validated on construction; the join is asserted anyway, because a
	// path that escaped the session directory would be a traversal.
	if (dirname(file) !== sessionDir(id)) throw new Error(`capture path escaped its session directory: ${file}`);
	return file;
}

/** Matches the whole capture family of a session, for cleanup. */
export const CAPTURE_RECORD_PATTERN = /^capture\.[0-9a-f]{64}\.json(?:\.tmp)?$/;

/**
 * The three members of one session's lock family, all siblings under the locks
 * root: the published lock (`canonical`), a fully-written acquisition awaiting
 * publication (`candidate`), and a contender's blocking claim (`claim`).
 */
export type SessionLockMember = "canonical" | "candidate" | "claim";

export function sessionLockFile(id: string, member: SessionLockMember, generation = ""): string {
	assertValidSessionId(id);
	const suffix = generation === "" ? "" : `.${generation}`;
	const file = join(sessionLocksRootDir(), `${id}.${member}${suffix}.lock`);
	if (dirname(file) !== sessionLocksRootDir()) {
		throw new Error(`session lock path escaped the locks root: ${file}`);
	}
	return file;
}

/** Matches every member of every session's lock family, for enumeration and cleanup. */
export const SESSION_LOCK_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}\.(?:canonical|candidate|claim)(?:\.[0-9a-f]{64})?\.lock$/;

/** Ordered ground-truth stream tap (seq 1228) — proof runs only, env-gated. */
export function streamTapFile(id: string): string {
	return join(sessionDir(id), "stream-tap.ndjson");
}
