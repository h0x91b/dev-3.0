import { connect } from "node:net";
import type { CliRequest, CliResponse } from "../shared/types";

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
class EmptyResponseError extends Error {
	constructor() {
		super("Empty response from server");
		this.name = "EmptyResponseError";
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

function sendOnce(socketPath: string, req: CliRequest, timeoutMs: number): Promise<CliResponse> {
	return new Promise((resolve, reject) => {
		const socket = connect({ path: socketPath });
		// Accumulate raw buffers to avoid corrupting multi-byte UTF-8
		// characters that may be split across data events.
		const chunks: Buffer[] = [];

		socket.on("connect", () => {
			socket.write(JSON.stringify(req) + "\n");
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
			try {
				resolve(JSON.parse(lines[0]) as CliResponse);
			} catch {
				reject(new Error(`Invalid JSON response: ${lines[0]}`));
			}
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
