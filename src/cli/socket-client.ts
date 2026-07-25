import { connect } from "node:net";
import { readFileSync } from "node:fs";
import type { CliRequest, CliResponse } from "../shared/types";
import { CLI_ENDPOINT_TOKEN_MISMATCH, isCliEndpointHandle, parseCliEndpointRecord } from "../shared/cli-endpoint";

const DEFAULT_TIMEOUT_MS = 30_000;

// A live desktop app can momentarily fail to accept() a new connection — the
// Unix-domain socket's accept backlog briefly fills while the app's single
// event loop is busy (GC, a sync burst, or many `dev3` invocations firing at
// once from agent hooks). macOS's small default backlog makes this far more
// likely than on Linux. The kernel returns ECONNREFUSED even though the socket
// file exists and the app is alive; ENOENT can likewise appear in a tight race
// between socket (re)creation and connect. Treat these as transient and retry a
// few times with short backoff before concluding the app is actually down —
// otherwise a single hiccup is misreported as "app not running" (issue #714).
const TRANSIENT_CONNECT_CODES = new Set(["ECONNREFUSED", "ENOENT", "EAGAIN"]);
// A sandbox (Claude Code seatbelt / Codex) that denies the Unix-socket connect
// surfaces as EPERM/EACCES. Unlike a busy-backlog ECONNREFUSED, this is
// deterministic — retrying never clears it (issue #726) — so we fail fast and
// route to the same "can't reach the app" path with the errno attached, rather
// than spinning through the retry budget or bubbling a raw EPERM.
const BLOCKED_CONNECT_CODES = new Set(["EPERM", "EACCES"]);
const DEFAULT_CONNECT_ATTEMPTS = 4;
const CONNECT_RETRY_BASE_MS = 75;

// A clean socket `end` carrying zero bytes ("Empty response from server") is a
// RESPONSE-phase transient, distinct from the connect-phase codes above: the
// socket connected and the app accepted, but the connection closed before any
// JSON line was written. This is exactly what happens during the tmux socket
// handoff on `dev-server stop`/`restart` — the app tears the dev session down
// and the CLI's in-flight connection is dropped mid-request without a reply.
// Because the socket connected (not a "who's there?" probe), and because the
// affected `devServer.*` ops are idempotent, the request is safe to replay
// after a short settle window. Callers opt in via `retryEmptyResponse` so
// non-idempotent mutations never get silently double-applied (vents 2026-07-04
// / 2026-07-06 — false `error: Empty response from server` on stop/restart).
const DEFAULT_EMPTY_RESPONSE_ATTEMPTS = 3;
const EMPTY_RESPONSE_SETTLE_MS = 200;

/** Socket ended cleanly with no response body — see the note above. */
export class EmptyResponseError extends Error {
	constructor() {
		super("Empty response from server");
		this.name = "EmptyResponseError";
	}
}

/**
 * True when the failure means "the instance behind this socket is gone or
 * never answered": the retry budget was exhausted on connect (APP_NOT_RUNNING)
 * or the connection kept closing with no reply (EmptyResponseError). For
 * idempotent operations the caller may re-discover a DIFFERENT live socket and
 * replay — e.g. `devServer.*` after the serving instance died mid-teardown
 * because the dev session hosted the instance itself (#910/#920). Matched by
 * name/message rather than instanceof so it stays robust across module mocks.
 */
export function isInstanceLossError(err: unknown): boolean {
	if (!(err instanceof Error)) return false;
	return err.name === "EmptyResponseError" || err.name === "StaleEndpointError" || err.message === "APP_NOT_RUNNING";
}

/**
 * The loopback endpoint record we dialed is unusable or no longer describes the
 * instance that answered: the record is corrupt/foreign, or the listener
 * rejected our token because the record is stale and the port now belongs to
 * something else. A Unix socket cannot hit this — the socket file IS the
 * instance. Reported as "cannot reach the app" (exit code 2), not as a command
 * failure, and treated as instance loss so idempotent replays re-discover.
 */
export class StaleEndpointError extends Error {
	constructor(
		readonly endpoint: string,
		readonly reason: string,
	) {
		super("STALE_ENDPOINT");
		this.name = "StaleEndpointError";
	}
}

/** Connect failed with a code that may clear on retry while the app is alive. */
class TransientConnectError extends Error {
	constructor(readonly code: string) {
		super(`Transient connect failure: ${code}`);
		this.name = "TransientConnectError";
	}
}

/** Connect was deterministically denied (sandbox) — retrying is pointless. */
class BlockedConnectError extends Error {
	constructor(readonly code: string) {
		super(`Blocked connect: ${code}`);
		this.name = "BlockedConnectError";
	}
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Where an endpoint handle actually points. A `.sock` path connects by path as
 * it always has; a `.endpoint.json` record resolves to the app's loopback port
 * plus the token that authorizes the request (see src/shared/cli-endpoint.ts).
 */
type ConnectTarget =
	| { kind: "unix"; path: string }
	| { kind: "tcp"; host: string; port: number; token: string };

function resolveConnectTarget(endpoint: string): ConnectTarget {
	if (!isCliEndpointHandle(endpoint)) return { kind: "unix", path: endpoint };

	let raw: string;
	try {
		raw = readFileSync(endpoint, "utf-8");
	} catch {
		// The record vanished between discovery and connect — the same race a
		// missing `.sock` produces, so reuse the transient ENOENT path.
		throw new TransientConnectError("ENOENT");
	}

	const record = parseCliEndpointRecord(raw);
	if (!record) throw new StaleEndpointError(endpoint, "the endpoint record is corrupt, from a newer format, or not loopback-bound");
	return { kind: "tcp", host: record.host, port: record.port, token: record.token };
}

function sendOnce(endpoint: string, req: CliRequest, timeoutMs: number): Promise<CliResponse> {
	return new Promise((resolve, reject) => {
		let target: ConnectTarget;
		try {
			target = resolveConnectTarget(endpoint);
		} catch (err) {
			reject(err);
			return;
		}

		const socket = target.kind === "unix"
			? connect({ path: target.path })
			: connect({ host: target.host, port: target.port });
		// The token travels only on the loopback carrier, so Unix-socket request
		// bytes stay exactly what they were.
		const payload: CliRequest = target.kind === "tcp" ? { ...req, token: target.token } : req;
		// Accumulate raw buffers to avoid corrupting multi-byte UTF-8
		// characters that may be split across data events.
		const chunks: Buffer[] = [];

		socket.on("connect", () => {
			socket.write(JSON.stringify(payload) + "\n");
		});

		socket.on("data", (data) => {
			chunks.push(Buffer.isBuffer(data) ? data : Buffer.from(data));
		});

		socket.on("end", () => {
			const buffer = Buffer.concat(chunks).toString("utf-8");
			const lines = buffer.split("\n").filter((l) => l.trim());
			if (lines.length === 0) {
				reject(new EmptyResponseError());
				return;
			}
			let resp: CliResponse;
			try {
				resp = JSON.parse(lines[0]) as CliResponse;
			} catch {
				reject(new Error(`Invalid JSON response: ${lines[0]}`));
				return;
			}
			if (resp.error === CLI_ENDPOINT_TOKEN_MISMATCH) {
				reject(new StaleEndpointError(endpoint, "the listening instance rejected the record's token"));
				return;
			}
			resolve(resp);
		});

		socket.on("error", (err) => {
			socket.destroy();
			const code = (err as NodeJS.ErrnoException).code;
			if (code && TRANSIENT_CONNECT_CODES.has(code)) {
				reject(new TransientConnectError(code));
			} else if (code && BLOCKED_CONNECT_CODES.has(code)) {
				reject(new BlockedConnectError(code));
			} else {
				reject(err);
			}
		});

		socket.setTimeout(timeoutMs, () => {
			socket.destroy();
			reject(new Error(`Socket timeout (${Math.round(timeoutMs / 1000)}s)`));
		});
	});
}

/**
 * One request with connect-phase retry. Transient connect hiccups
 * (ECONNREFUSED/ENOENT/EAGAIN) are retried a few times before concluding the
 * app is down; an `EmptyResponseError` (response phase) is NOT handled here —
 * it propagates so the caller can decide whether the request is safe to replay.
 */
async function connectAndSend(
	socketPath: string,
	req: CliRequest,
	timeoutMs: number,
	attempts: number,
	retryDelayMs?: number,
): Promise<CliResponse> {
	let lastCode = "ECONNREFUSED";
	for (let attempt = 0; attempt < attempts; attempt++) {
		try {
			return await sendOnce(socketPath, req, timeoutMs);
		} catch (err) {
			// A deterministic sandbox denial never clears on retry — surface it
			// immediately as APP_NOT_RUNNING (connect stage) with the errno so the
			// CLI prints the sandbox-aware message instead of bubbling a raw EPERM.
			if (err instanceof BlockedConnectError) {
				const blocked = new Error("APP_NOT_RUNNING") as Error & { connectCode?: string };
				blocked.connectCode = err.code;
				throw blocked;
			}
			// Only connection-level hiccups are retried here. A real response (even
			// an error one), an empty response, a timeout, or a malformed payload
			// propagates immediately.
			if (!(err instanceof TransientConnectError)) throw err;
			lastCode = err.code;
			if (attempt === attempts - 1) break;
			await delay(retryDelayMs ?? CONNECT_RETRY_BASE_MS * (attempt + 1));
		}
	}

	// Every connection attempt failed transiently — the app is genuinely down.
	// Attach the last errno so the CLI can surface it under DEV3_DEBUG.
	const appDown = new Error("APP_NOT_RUNNING") as Error & { connectCode?: string };
	appDown.connectCode = lastCode;
	throw appDown;
}

export async function sendRequest(
	socketPath: string,
	method: string,
	params: Record<string, unknown> = {},
	opts: {
		timeoutMs?: number;
		connectAttempts?: number;
		retryDelayMs?: number;
		/**
		 * Replay the whole request when the socket ends with no response body.
		 * Only safe for idempotent operations (e.g. `devServer.*`); leave off for
		 * mutations that must not be applied twice. See EmptyResponseError above.
		 */
		retryEmptyResponse?: boolean;
		emptyResponseAttempts?: number;
		emptyResponseSettleMs?: number;
	} = {},
): Promise<CliResponse> {
	const req: CliRequest = {
		id: crypto.randomUUID(),
		method,
		params,
	};

	const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const attempts = Math.max(1, opts.connectAttempts ?? DEFAULT_CONNECT_ATTEMPTS);

	// When the caller opts in, an empty response gets a short settle-and-retry
	// window (the socket handoff needs a beat to complete). When it doesn't, the
	// single attempt below rethrows the EmptyResponseError verbatim, preserving
	// the historical "Empty response from server" failure for every other command.
	const emptyAttempts = opts.retryEmptyResponse
		? Math.max(1, opts.emptyResponseAttempts ?? DEFAULT_EMPTY_RESPONSE_ATTEMPTS)
		: 1;
	const settleMs = opts.emptyResponseSettleMs ?? EMPTY_RESPONSE_SETTLE_MS;

	for (let attempt = 0; attempt < emptyAttempts; attempt++) {
		try {
			return await connectAndSend(socketPath, req, timeoutMs, attempts, opts.retryDelayMs);
		} catch (err) {
			if (err instanceof EmptyResponseError && attempt < emptyAttempts - 1) {
				await delay(settleMs);
				continue;
			}
			throw err;
		}
	}

	// Unreachable — the final iteration always returns or throws.
	throw new EmptyResponseError();
}
