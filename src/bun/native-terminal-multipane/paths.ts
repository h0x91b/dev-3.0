/**
 * On-disk namespace for the native multi-pane coordinator (seq 1283).
 *
 * ISOLATION: an ADDITIVE root `~/.dev3.0/native-multipane/`, overridable via
 * DEV3_NATIVE_MULTIPANE_DIR. It is a sibling of — never inside — the registry's
 * `native-sessions/` root, so a coordinator record can never be mistaken for a
 * session record and neither namespace renames or deletes the other. Legacy
 * tmux records are untouched (AGENTS.md on-disk invariants).
 *
 * Dependency-light on purpose: only node:path plus the registry's pure session
 * id validator, so the path logic stays unit-testable under vitest.
 */

import { join } from "node:path";
import { isValidSessionId } from "../native-terminal-registry/paths";

export const NATIVE_MULTIPANE_DIR_ENV = "DEV3_NATIVE_MULTIPANE_DIR";

/** Root of the coordinator namespace: env override, else `~/.dev3.0/native-multipane/`. */
export function multipaneRootDir(): string {
	const explicit = process.env[NATIVE_MULTIPANE_DIR_ENV];
	if (explicit) return explicit;
	const dev3Home =
		process.env.DEV3_HOME || `${process.env.HOME || process.env.USERPROFILE || "/tmp"}/.dev3.0`;
	return join(dev3Home, "native-multipane");
}

// Max 56 chars: a real coordinator id is `dev3-task-<uuid>` (46 chars), and the
// longest derived pane session id `<coordinatorId>-pane-N` (≤53) still fits the
// registry's 64-char limit. `..` is always rejected to block path traversal.
const COORDINATOR_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,55}$/;

export function isValidCoordinatorId(id: string): boolean {
	return typeof id === "string" && COORDINATOR_ID_PATTERN.test(id) && !id.includes("..");
}

export function assertValidCoordinatorId(id: string): void {
	if (!isValidCoordinatorId(id)) {
		throw new Error(
			`invalid native multipane coordinator id ${JSON.stringify(id)} — allowed: ${COORDINATOR_ID_PATTERN.source} (max 56 chars) and no "..".`,
		);
	}
}

export function coordinatorDir(id: string): string {
	assertValidCoordinatorId(id);
	return join(multipaneRootDir(), id);
}

export function coordinatorRecordFile(id: string): string {
	return join(coordinatorDir(id), "coordinator.json");
}

/**
 * The registry session id that backs one logical pane. Deterministic so a fresh
 * controller can rediscover the same host from the layout alone.
 */
export function paneSessionId(coordinatorId: string, paneId: string): string {
	assertValidCoordinatorId(coordinatorId);
	const sessionId = `${coordinatorId}-${paneId}`;
	if (!isValidSessionId(sessionId)) {
		throw new Error(`pane ${JSON.stringify(paneId)} does not map to a valid native session id`);
	}
	return sessionId;
}
