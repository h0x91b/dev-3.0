/**
 * The record parser EXACTLY as it stood at 3228bbd, vendored verbatim so the N-2
 * compatibility proof cannot drift with the current build. It imports nothing from
 * today's modules on purpose.
 *
 * Regenerate only from that commit:
 *   git show 3228bbd75:src/bun/native-terminal-registry/record.ts
 */

const NATIVE_SESSION_SCHEMA_VERSION = 1 as const;

type OwnershipEvidenceKind = "posix-start-signature" | "windows-job";

interface N2SessionIdentity {
	seq?: string;
	paneId?: string;
}

export interface N2SessionRecord {
	schemaVersion: typeof NATIVE_SESSION_SCHEMA_VERSION;
	sessionId: string;
	paneId: string;
	identity?: N2SessionIdentity;
	protocolVersion: number;
	hostArtifactVersion: string;
	runtimeVersion: string;
	platform: string;
	host: { pid: number; executable: string; startSignature: string };
	shell: { pid: number; command: string[]; startSignature: string };
	endpoint: { transport: "ws"; address: string; port: number };
	ownership: { evidenceKind: OwnershipEvidenceKind };
	cols: number;
	rows: number;
	createdAt: string;
	updatedAt: string;
}

function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

/**
 * Read the optional identity block. A malformed or unexpected value is DROPPED,
 * never rejected: identity is a display convenience, and refusing the whole
 * record over it would turn a cosmetic field into a lost session.
 */
function parseIdentity(value: unknown): N2SessionIdentity | null {
	if (!value || typeof value !== "object") return null;
	const raw = value as Record<string, unknown>;
	const identity: N2SessionIdentity = {};
	if (typeof raw.seq === "string" && isSafeIdentityValue(raw.seq)) identity.seq = raw.seq;
	if (typeof raw.paneId === "string" && isSafeIdentityValue(raw.paneId)) identity.paneId = raw.paneId;
	return identity.seq || identity.paneId ? identity : null;
}

/** Belt-and-braces: only the shapes `process-naming.ts` can produce are surfaced. */
function isSafeIdentityValue(value: string): boolean {
	return /^[A-Za-z0-9-]{1,32}$/.test(value);
}

/** Parse + strictly validate a record, or null if unreadable / not this schema. */
export function n2ParseRecord(text: string): N2SessionRecord | null {
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
	return {
		schemaVersion: NATIVE_SESSION_SCHEMA_VERSION,
		sessionId: r.sessionId,
		paneId: r.paneId,
		...(identity ? { identity } : {}),
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

