/**
 * Versioned registry record + atomic on-disk state for the native-session
 * registry (seq 1214).
 *
 * A record fully describes one persistent native session: stable session/pane
 * ids, host + shell identity and ownership evidence, the authenticated loopback
 * endpoint (WITHOUT the token), and the runtime/protocol/schema versions a fresh
 * client needs to decide whether it may reattach.
 *
 * TOKEN PRIVACY: the per-session bearer token is NEVER stored in record.json.
 * It lives in a sibling `token` file (mode 0600) so `list`/`status` output and
 * any diagnostic that serialises a record can never leak it.
 *
 * COMPATIBILITY: parseRecord returns null for anything whose schemaVersion is
 * not exactly the version this build understands — a record written by a newer
 * dev3 is treated as unreadable-and-not-ours, never adopted or migrated. Uses
 * only node:fs/node:path so the pure logic is unit-testable under vitest.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { journalFile, logFile, recordFile, sessionDir, tokenFile } from "./paths";

export const NATIVE_SESSION_SCHEMA_VERSION = 1 as const;
export const NATIVE_SESSION_HOST_ARTIFACT_VERSION = "1" as const;

export type OwnershipEvidenceKind = "posix-start-signature" | "windows-job";

export interface NativeSessionEndpoint {
	transport: "ws";
	address: string;
	port: number;
}

export interface NativeSessionRecord {
	schemaVersion: typeof NATIVE_SESSION_SCHEMA_VERSION;
	sessionId: string;
	paneId: string;
	protocolVersion: number;
	hostArtifactVersion: string;
	runtimeVersion: string;
	platform: string;
	host: { pid: number; executable: string; startSignature: string };
	shell: { pid: number; command: string[]; startSignature: string };
	endpoint: NativeSessionEndpoint;
	ownership: { evidenceKind: OwnershipEvidenceKind };
	cols: number;
	rows: number;
	createdAt: string;
	updatedAt: string;
}

export function serializeRecord(record: NativeSessionRecord): string {
	return `${JSON.stringify(record, null, 2)}\n`;
}

function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

/** Parse + strictly validate a record, or null if unreadable / not this schema. */
export function parseRecord(text: string): NativeSessionRecord | null {
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch {
		return null;
	}
	if (!raw || typeof raw !== "object") return null;
	const r = raw as Record<string, unknown>;
	if (r.schemaVersion !== NATIVE_SESSION_SCHEMA_VERSION) return null;
	const host = r.host as Record<string, unknown> | undefined;
	const shell = r.shell as Record<string, unknown> | undefined;
	const endpoint = r.endpoint as Record<string, unknown> | undefined;
	const ownership = r.ownership as Record<string, unknown> | undefined;
	if (
		typeof r.sessionId !== "string" ||
		typeof r.paneId !== "string" ||
		typeof r.protocolVersion !== "number" ||
		typeof r.hostArtifactVersion !== "string" ||
		typeof r.runtimeVersion !== "string" ||
		typeof r.platform !== "string" ||
		typeof r.cols !== "number" ||
		typeof r.rows !== "number" ||
		typeof r.createdAt !== "string" ||
		typeof r.updatedAt !== "string" ||
		!host ||
		typeof host.pid !== "number" ||
		typeof host.executable !== "string" ||
		typeof host.startSignature !== "string" ||
		!shell ||
		typeof shell.pid !== "number" ||
		!isStringArray(shell.command) ||
		typeof shell.startSignature !== "string" ||
		!endpoint ||
		endpoint.transport !== "ws" ||
		typeof endpoint.address !== "string" ||
		typeof endpoint.port !== "number" ||
		!ownership ||
		(ownership.evidenceKind !== "posix-start-signature" && ownership.evidenceKind !== "windows-job")
	) {
		return null;
	}
	// Refuse to surface a token even if a malformed writer smuggled one in.
	if ("token" in r) return null;
	return {
		schemaVersion: NATIVE_SESSION_SCHEMA_VERSION,
		sessionId: r.sessionId,
		paneId: r.paneId,
		protocolVersion: r.protocolVersion,
		hostArtifactVersion: r.hostArtifactVersion,
		runtimeVersion: r.runtimeVersion,
		platform: r.platform,
		host: { pid: host.pid, executable: host.executable, startSignature: host.startSignature },
		shell: { pid: shell.pid, command: shell.command, startSignature: shell.startSignature },
		endpoint: { transport: "ws", address: endpoint.address, port: endpoint.port },
		ownership: { evidenceKind: ownership.evidenceKind },
		cols: r.cols,
		rows: r.rows,
		createdAt: r.createdAt,
		updatedAt: r.updatedAt,
	};
}

export function readRecord(sessionId: string): NativeSessionRecord | null {
	try {
		return parseRecord(readFileSync(recordFile(sessionId), "utf8"));
	} catch {
		return null;
	}
}

/** Atomically publish a record (tmp write + rename) so readers never see a torn file. */
export function writeRecordAtomic(record: NativeSessionRecord): void {
	const dir = sessionDir(record.sessionId);
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	const target = recordFile(record.sessionId);
	const tmp = `${target}.${process.pid}.tmp`;
	writeFileSync(tmp, serializeRecord(record), { mode: 0o600 });
	renameSync(tmp, target);
}

/** Persist the private bearer token (mode 0600); it never enters record.json. */
export function writeToken(sessionId: string, token: string): void {
	const dir = sessionDir(sessionId);
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	const target = tokenFile(sessionId);
	const tmp = `${target}.${process.pid}.tmp`;
	writeFileSync(tmp, token, { mode: 0o600 });
	renameSync(tmp, target);
}

export function readToken(sessionId: string): string | null {
	try {
		const token = readFileSync(tokenFile(sessionId), "utf8").trim();
		return token.length > 0 ? token : null;
	} catch {
		return null;
	}
}

/**
 * Remove one session's on-disk state, but ONLY when its current token matches
 * `expectedToken`. This is the ownership guard: a stale stop/cleanup cannot
 * erase a newer session that reused the same session id, and one implementation
 * only ever deletes state it can prove it owns. The record is removed last so a
 * concurrent start cannot observe a half-cleared session. Returns false when the
 * token guard rejects the removal.
 */
export function removeSessionState(sessionId: string, expectedToken: string | null): boolean {
	if (expectedToken !== null && readToken(sessionId) !== expectedToken) return false;
	const files = [journalFile(sessionId), logFile(sessionId), tokenFile(sessionId), recordFile(sessionId)];
	for (const file of files) {
		try {
			if (existsSync(file)) unlinkSync(file);
		} catch {
			// best-effort — a leftover file is harmless; liveness is always re-checked
		}
	}
	try {
		rmdirSync(sessionDir(sessionId));
	} catch {
		// dir not empty (unknown sibling files) or already gone — leave it
	}
	return true;
}
