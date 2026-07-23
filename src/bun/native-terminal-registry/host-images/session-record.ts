/**
 * The small discovery record a running staged-host session publishes (seq 1248).
 *
 * Distinct from the frozen registry record.ts: this lab only needs enough to
 * prove version skew + image immutability — which image the host booted from,
 * the protocol version it speaks, its host/shell PIDs, pane id, and loopback
 * endpoint (WITHOUT the token, which lives in a sibling 0600 file). Atomic
 * tmp+rename so a reader never sees a torn file.
 *
 * node:fs / node:path only, so parsing is unit-testable under the Bun stub.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const HOST_SESSION_RECORD_SCHEMA = 1 as const;

export interface HostSessionRecord {
	schema: typeof HOST_SESSION_RECORD_SCHEMA;
	sessionId: string;
	paneId: string;
	imageTag: string;
	protocolVersion: number;
	/** argv[1] the host was launched with — must resolve inside its own image dir. */
	entrypoint: string;
	hostPid: number;
	shellPid: number;
	endpoint: { address: string; port: number };
	/** The shell-state marker baked into the shell's environment at boot. */
	stateMarker: string;
	startedAt: string;
}

export function recordPath(stateDir: string): string {
	return join(stateDir, "session.json");
}

export function tokenPath(stateDir: string): string {
	return join(stateDir, "token");
}

export function parseHostSessionRecord(text: string): HostSessionRecord | null {
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch {
		return null;
	}
	if (!raw || typeof raw !== "object") return null;
	const r = raw as Record<string, unknown>;
	const endpoint = r.endpoint as Record<string, unknown> | undefined;
	if (
		r.schema !== HOST_SESSION_RECORD_SCHEMA ||
		typeof r.sessionId !== "string" ||
		typeof r.paneId !== "string" ||
		typeof r.imageTag !== "string" ||
		typeof r.protocolVersion !== "number" ||
		typeof r.entrypoint !== "string" ||
		typeof r.hostPid !== "number" ||
		typeof r.shellPid !== "number" ||
		typeof r.stateMarker !== "string" ||
		typeof r.startedAt !== "string" ||
		!endpoint ||
		typeof endpoint.address !== "string" ||
		typeof endpoint.port !== "number"
	) {
		return null;
	}
	if ("token" in r) return null; // never surface a token, even if smuggled in
	return {
		schema: HOST_SESSION_RECORD_SCHEMA,
		sessionId: r.sessionId,
		paneId: r.paneId,
		imageTag: r.imageTag,
		protocolVersion: r.protocolVersion,
		entrypoint: r.entrypoint,
		hostPid: r.hostPid,
		shellPid: r.shellPid,
		endpoint: { address: endpoint.address, port: endpoint.port },
		stateMarker: r.stateMarker,
		startedAt: r.startedAt,
	};
}

export function writeHostSessionRecord(stateDir: string, record: HostSessionRecord): void {
	mkdirSync(stateDir, { recursive: true, mode: 0o700 });
	const target = recordPath(stateDir);
	const tmp = `${target}.${process.pid}.tmp`;
	writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
	renameSync(tmp, target);
}

export function readHostSessionRecord(stateDir: string): HostSessionRecord | null {
	try {
		return parseHostSessionRecord(readFileSync(recordPath(stateDir), "utf8"));
	} catch {
		return null;
	}
}

export function writeHostSessionToken(stateDir: string, token: string): void {
	mkdirSync(stateDir, { recursive: true, mode: 0o700 });
	const target = tokenPath(stateDir);
	const tmp = `${target}.${process.pid}.tmp`;
	writeFileSync(tmp, token, { mode: 0o600 });
	renameSync(tmp, target);
}

export function readHostSessionToken(stateDir: string): string | null {
	try {
		const token = readFileSync(tokenPath(stateDir), "utf8").trim();
		return token.length > 0 ? token : null;
	} catch {
		return null;
	}
}
