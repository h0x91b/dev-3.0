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

import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmdirSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
	CAPTURE_RECORD_PATTERN,
	journalFile,
	logFile,
	parserStateFile,
	recordFile,
	sessionDir,
	streamTapFile,
	tokenFile,
} from "./paths";

export const NATIVE_SESSION_SCHEMA_VERSION = 1 as const;
export const NATIVE_SESSION_HOST_ARTIFACT_VERSION = "1" as const;

export type OwnershipEvidenceKind = "posix-start-signature" | "windows-job";

export interface NativeSessionEndpoint {
	transport: "ws";
	address: string;
	port: number;
}

/**
 * The human-readable ownership the host also carries in its argv0 (seq 1383).
 * Numbers only by construction — `process-naming.ts` is the single validator,
 * and nothing free-form (title, prompt, path, token) can reach this field.
 */
export interface NativeSessionIdentity {
	/** Human task number, e.g. `1383` or `1383-1`. */
	seq?: string;
	/** The coordinator's logical pane id, e.g. `pane-1`. */
	paneId?: string;
}

/**
 * Capture surfaces a host publishes. Each is INDEPENDENT: a host may advertise
 * either, both, or neither, and an empty list is omitted entirely. Absence is the
 * load-bearing case — it is how a reader states "not enabled" as a fact.
 */
export const NATIVE_SESSION_CAPTURE_CAPABILITY = "semantic-snapshot-v1" as const;
export const NATIVE_SESSION_TEXT_CAPTURE_CAPABILITY = "plain-text-capture-v1" as const;

export type NativeSessionCaptureSurface =
	| typeof NATIVE_SESSION_CAPTURE_CAPABILITY
	| typeof NATIVE_SESSION_TEXT_CAPTURE_CAPABILITY;

const CAPTURE_SURFACES: readonly NativeSessionCaptureSurface[] = [
	NATIVE_SESSION_CAPTURE_CAPABILITY,
	NATIVE_SESSION_TEXT_CAPTURE_CAPABILITY,
];

export interface NativeSessionCapabilities {
	capture?: NativeSessionCaptureSurface[];
}

export interface NativeSessionRecord {
	schemaVersion: typeof NATIVE_SESSION_SCHEMA_VERSION;
	sessionId: string;
	paneId: string;
	/**
	 * ADDITIVE and optional at schemaVersion 1, so there is no migration: parsing
	 * is a whitelist, so a dev3 that predates this field reads such a record
	 * unchanged and ignores it. Absent for sessions started outside a task.
	 */
	identity?: NativeSessionIdentity;
	/**
	 * ADDITIVE and optional at schemaVersion 1, on the same terms as `identity`:
	 * an older dev3 parses such a record unchanged and ignores this field, and a
	 * record without it is not a downgrade — it is the honest statement that the
	 * host has no capture surface. No migration, no schema break.
	 */
	capabilities?: NativeSessionCapabilities;
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

/**
 * Read the optional identity block. A malformed or unexpected value is DROPPED,
 * never rejected: identity is a display convenience, and refusing the whole
 * record over it would turn a cosmetic field into a lost session.
 */
function parseIdentity(value: unknown): NativeSessionIdentity | null {
	if (!value || typeof value !== "object") return null;
	const raw = value as Record<string, unknown>;
	const identity: NativeSessionIdentity = {};
	if (typeof raw.seq === "string" && isSafeIdentityValue(raw.seq)) identity.seq = raw.seq;
	if (typeof raw.paneId === "string" && isSafeIdentityValue(raw.paneId)) identity.paneId = raw.paneId;
	return identity.seq || identity.paneId ? identity : null;
}

/**
 * Read the optional capabilities block. An unrecognised surface is DROPPED, never
 * rejected: a capability a newer host advertises must not cost an older dev3 the
 * whole session, and dropping lands on "fewer capabilities", the safe side.
 */
function parseCapabilities(value: unknown): NativeSessionCapabilities | null {
	if (!value || typeof value !== "object") return null;
	const raw = (value as Record<string, unknown>).capture;
	if (!Array.isArray(raw)) return null;
	const capture = CAPTURE_SURFACES.filter((surface) => raw.includes(surface));
	return capture.length > 0 ? { capture } : null;
}

/** Belt-and-braces: only the shapes `process-naming.ts` can produce are surfaced. */
function isSafeIdentityValue(value: string): boolean {
	return /^[A-Za-z0-9-]{1,32}$/.test(value);
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
	const identity = parseIdentity(r.identity);
	const capabilities = parseCapabilities(r.capabilities);
	return {
		schemaVersion: NATIVE_SESSION_SCHEMA_VERSION,
		sessionId: r.sessionId,
		paneId: r.paneId,
		...(identity ? { identity } : {}),
		...(capabilities ? { capabilities } : {}),
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

/** Why a record file could not be adopted — the input of an actionable diagnostic. */
export type RecordProblem =
	| { kind: "absent" }
	| { kind: "missing" }
	| { kind: "unreadable-file"; message: string }
	| { kind: "invalid-json" }
	| { kind: "foreign-schema"; schemaVersion: unknown }
	| { kind: "invalid-fields" };

export type RecordInspection = { ok: true; record: NativeSessionRecord } | { ok: false; problem: RecordProblem };

/**
 * Same fail-closed acceptance rule as `readRecord`, but it reports WHY a record
 * was rejected so recovery can print an actionable diagnostic instead of
 * silently skipping a session directory.
 */
export function inspectRecordFile(sessionId: string): RecordInspection {
	let text: string;
	try {
		text = readFileSync(recordFile(sessionId), "utf8");
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		// No session directory at all ≠ a directory that lost its record.
		if (code === "ENOENT") {
			return { ok: false, problem: { kind: existsSync(sessionDir(sessionId)) ? "missing" : "absent" } };
		}
		return { ok: false, problem: { kind: "unreadable-file", message: (error as Error).message } };
	}
	const record = parseRecord(text);
	if (record) return { ok: true, record };
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch {
		return { ok: false, problem: { kind: "invalid-json" } };
	}
	if (!raw || typeof raw !== "object") return { ok: false, problem: { kind: "invalid-json" } };
	const schemaVersion = (raw as Record<string, unknown>).schemaVersion;
	if (schemaVersion !== NATIVE_SESSION_SCHEMA_VERSION) return { ok: false, problem: { kind: "foreign-schema", schemaVersion } };
	return { ok: false, problem: { kind: "invalid-fields" } };
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
/**
 * Every capture artifact of this session, whichever producers wrote them. The path
 * is producer-scoped, so cleanup matches the bounded family instead of one name —
 * and it stays inside the session directory, matching nothing else.
 */
function captureFamilyFiles(sessionId: string): string[] {
	try {
		return readdirSync(sessionDir(sessionId))
			.filter((entry) => CAPTURE_RECORD_PATTERN.test(entry))
			.map((entry) => join(sessionDir(sessionId), entry));
	} catch {
		return [];
	}
}

export function removeSessionState(sessionId: string, expectedToken: string | null): boolean {
	if (expectedToken === null || readToken(sessionId) !== expectedToken) return false;
	const record = readRecord(sessionId);
	const atomicFiles = [journalFile(sessionId), parserStateFile(sessionId), tokenFile(sessionId), recordFile(sessionId)];
	if (record && Number.isInteger(record.host.pid) && record.host.pid > 0) {
		for (const file of atomicFiles) {
			try {
				unlinkSync(`${file}.${record.host.pid}.tmp`);
			} catch {
				// absent, already published, or not owned by this recorded host
			}
		}
	}
	const files = [
		journalFile(sessionId),
		parserStateFile(sessionId),
		...captureFamilyFiles(sessionId),
		streamTapFile(sessionId),
		logFile(sessionId),
		tokenFile(sessionId),
		recordFile(sessionId),
	];
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
