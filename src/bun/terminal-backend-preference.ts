/**
 * The machine-local "which terminal backend do NEW tasks get" preference, in its
 * own versioned sidecar file (seq 1352).
 *
 * It deliberately does NOT live in `settings.json`. That loader is a whitelist:
 * a build that predates a field drops it on its next save, so an older app
 * installed side by side would silently delete this rollout choice. A dedicated
 * file no older build reads or rewrites is the only durable place for it —
 * additive, exactly as the on-disk layout invariants require.
 *
 * File contract — `~/.dev3.0/terminal-backend.json`:
 *
 *   { "version": 1, "newTaskBackend": "tmux" | "native" }
 *
 *  • Missing file, unreadable JSON, unknown `version`, or an unrecognized
 *    `newTaskBackend` all mean NO PREFERENCE. The caller then keeps the platform
 *    default (POSIX leaves a new task unmarked ⇒ tmux, Windows stamps native).
 *    This file never decides anything on its own and never repairs itself.
 *  • Writes are atomic (temp file + rename) and machine-local; nothing here is
 *    synced, per-project, or written into a task record.
 *  • A `version` this build does not know is left ALONE on read — reporting "no
 *    preference" is safer than interpreting a newer schema.
 */

import { existsSync, readFileSync, mkdirSync, renameSync } from "node:fs";
import { isTerminalBackendIdentity, type TerminalBackendIdentity } from "../shared/terminal-backend-identity";
import { withFileLock } from "./file-lock";
import { createLogger } from "./logger";
import { DEV3_HOME } from "./paths";

const log = createLogger("terminal-backend-preference");

/** Absolute path of the sidecar. Exported so tests and docs cite one source. */
export const TERMINAL_BACKEND_PREFERENCE_FILE = `${DEV3_HOME}/terminal-backend.json`;

/** Schema version this build writes and is able to read. */
export const TERMINAL_BACKEND_PREFERENCE_VERSION = 1;

export interface TerminalBackendPreferenceFile {
	version: number;
	newTaskBackend: TerminalBackendIdentity;
}

function parse(raw: string): TerminalBackendIdentity | null {
	const data: unknown = JSON.parse(raw);
	if (typeof data !== "object" || data === null || Array.isArray(data)) return null;
	const record = data as Record<string, unknown>;
	if (record.version !== TERMINAL_BACKEND_PREFERENCE_VERSION) {
		log.warn("Ignoring a terminal backend preference written by another schema version", {
			version: record.version,
		});
		return null;
	}
	return isTerminalBackendIdentity(record.newTaskBackend) ? record.newTaskBackend : null;
}

/**
 * The stored preference, or `null` when there is none this build can trust.
 * Never throws: a broken sidecar must not block task creation.
 */
export function readNewTaskTerminalBackendPreference(): TerminalBackendIdentity | null {
	try {
		if (!existsSync(TERMINAL_BACKEND_PREFERENCE_FILE)) return null;
		return parse(readFileSync(TERMINAL_BACKEND_PREFERENCE_FILE, "utf-8"));
	} catch (err) {
		log.warn("Could not read the terminal backend preference", { error: String(err) });
		return null;
	}
}

/**
 * Persist an explicit preference. Rejects an identity this build cannot decode
 * rather than writing a value the creation seam would have to guess about.
 */
export async function writeNewTaskTerminalBackendPreference(
	backend: TerminalBackendIdentity,
): Promise<void> {
	if (!isTerminalBackendIdentity(backend)) {
		throw new Error(`Unsupported terminal backend identity: ${String(backend)}`);
	}
	await withFileLock(TERMINAL_BACKEND_PREFERENCE_FILE, async () => {
		mkdirSync(DEV3_HOME, { recursive: true });
		const payload: TerminalBackendPreferenceFile = {
			version: TERMINAL_BACKEND_PREFERENCE_VERSION,
			newTaskBackend: backend,
		};
		const tempFile = `${TERMINAL_BACKEND_PREFERENCE_FILE}.tmp`;
		await Bun.write(tempFile, `${JSON.stringify(payload, null, 2)}\n`);
		renameSync(tempFile, TERMINAL_BACKEND_PREFERENCE_FILE);
	});
	log.info("New-task terminal backend preference saved", { backend });
}
