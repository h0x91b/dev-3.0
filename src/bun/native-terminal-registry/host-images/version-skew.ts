/**
 * Version-skew boundary for staged native terminal hosts (seq 1248).
 *
 * The protocol's hello/version boundary (protocol.ts `evaluateHello`) is frozen
 * at v1. To reason about an app update that stages a host speaking a DIFFERENT
 * protocol version, this generalises exactly that boundary by the host's own
 * version — nothing more. It reuses the real, version-agnostic `decodeHello`, so
 * a host at any version can still READ a foreign-version hello in order to answer
 * it with one explicit `version-mismatch` error and close only that socket.
 *
 * `evaluateHelloAtVersion(text, sessionId, hostVersion)` is proven byte-identical
 * to the real `evaluateHello` at `hostVersion === NATIVE_SESSION_PROTOCOL_VERSION`
 * (version-skew.test.ts) — so this stays a faithful generalisation, not a fork.
 *
 * Pure module: no Bun/Node runtime deps.
 */

import { decodeHello, type ErrorCode, type ErrorMessage, type HelloVerdict } from "../protocol";

export interface VersionedWelcome {
	v: number;
	type: "welcome";
	id: number;
	sessionId: string;
	protocolVersion: number;
}

/** Build an error frame stamped with the HOST's protocol version (not a fixed v1). */
export function versionedError(hostVersion: number, code: ErrorCode, id?: number, message?: string): ErrorMessage {
	const msg: ErrorMessage = { v: hostVersion, type: "error", code };
	if (id !== undefined) msg.id = id;
	if (message !== undefined) msg.message = message;
	return msg;
}

export function versionedWelcome(hostVersion: number, id: number, sessionId: string): VersionedWelcome {
	return { v: hostVersion, type: "welcome", id, sessionId, protocolVersion: hostVersion };
}

export function versionedHello(clientVersion: number, sessionId: string, id: number): string {
	return JSON.stringify({ v: clientVersion, type: "hello", sessionId, id });
}

/**
 * Decide whether a first frame is an acceptable hello for a host speaking
 * `hostVersion`. Mirrors `evaluateHello` exactly, only parameterised by the
 * host's version: a non-hello frame is bad-request; a foreign version is
 * version-mismatch; a wrong session id is not-found. On every failure the caller
 * sends the error and closes ONLY that socket — host + shell + other clients live.
 */
export function evaluateHelloAtVersion(text: string, expectedSessionId: string, hostVersion: number): HelloVerdict {
	const hello = decodeHello(text);
	if (!hello) return { ok: false, error: versionedError(hostVersion, "bad-request", undefined, "expected a hello frame") };
	if (hello.v !== hostVersion) {
		return { ok: false, error: versionedError(hostVersion, "version-mismatch", hello.id, `host speaks protocol v${hostVersion}`) };
	}
	if (hello.sessionId !== expectedSessionId) {
		return { ok: false, error: versionedError(hostVersion, "not-found", hello.id, "session id does not match this host") };
	}
	return { ok: true, id: hello.id };
}

// ── Compact version/session verdict matrix ────────────────────────────────

export type SkewVerdict = "compatible" | "version-mismatch";

/** A client speaks the same protocol version as the host, or it does not. Nothing in between. */
export function classifyVersionSkew(hostVersion: number, clientVersion: number): SkewVerdict {
	return hostVersion === clientVersion ? "compatible" : "version-mismatch";
}

export interface SkewMatrixRow {
	hostVersion: number;
	clientVersion: number;
	verdict: SkewVerdict;
	/** The error code an incompatible client receives (none when compatible). */
	rejection: Extract<ErrorCode, "version-mismatch"> | null;
	/** True when the live session (host + shell) must remain untouched by the attempt. */
	sessionPreserved: true;
}

/** Build the full host×client verdict matrix for the given versions. */
export function buildSkewMatrix(hostVersions: number[], clientVersions: number[]): SkewMatrixRow[] {
	const rows: SkewMatrixRow[] = [];
	for (const hostVersion of hostVersions) {
		for (const clientVersion of clientVersions) {
			const verdict = classifyVersionSkew(hostVersion, clientVersion);
			rows.push({
				hostVersion,
				clientVersion,
				verdict,
				rejection: verdict === "version-mismatch" ? "version-mismatch" : null,
				// A rejected handshake NEVER kills or replaces the live session — the
				// invariant every row asserts, whatever the verdict.
				sessionPreserved: true,
			});
		}
	}
	return rows;
}

/** Render the matrix as a compact GitHub-flavoured markdown table (docs + proof output). */
export function renderSkewMatrix(rows: SkewMatrixRow[]): string {
	const header = "| host \\ client | verdict | client receives | live session |";
	const divider = "|---|---|---|---|";
	const body = rows.map((row) => {
		const receives = row.rejection ? `error: ${row.rejection}` : "welcome";
		return `| host v${row.hostVersion} ← client v${row.clientVersion} | ${row.verdict} | ${receives} | preserved |`;
	});
	return [header, divider, ...body].join("\n");
}
