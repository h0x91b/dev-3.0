/**
 * Cross-instance owner routing for native panes (seq 1377).
 *
 * Several dev3 app processes share one `~/.dev3.0`, and a native pane's host
 * grants the writer lease to exactly ONE connected client — the first to attach.
 * Every other process observes: the host answers its input with `conflict` and
 * drops it. A binding is therefore NOT proof that a write lands.
 *
 * So a process that wants to type into a pane it does not own must ask the host
 * who the owner is and hand the work to that process, rather than claim the
 * lease out from under whoever is typing. The host reports the owner's pid, the
 * pid names a peer socket in `~/.dev3.0/sockets`, and the peer answers on the
 * same NDJSON request/response protocol the CLI already speaks.
 */

import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { DEV3_HOME } from "./paths";
import { createLogger } from "./logger";
import { isCliEndpointHandle, parseCliEndpointRecord } from "../shared/cli-endpoint";
import type { NativeTaskTerminal } from "./native-task-terminal";
import type { CliResponse } from "../shared/types";

const log = createLogger("native-pane-owner");

const SOCKETS_DIR = `${DEV3_HOME}/sockets`;
const FORWARD_TIMEOUT_MS = 10_000;

/** Where a pane's writes have to go for the host to accept them. */
export type PaneOwner =
	/** This process holds the lease — write directly. */
	| { kind: "local" }
	/** Another live app process holds it — forward, never steal. */
	| { kind: "peer"; pid: number; endpoint: string }
	/** Nobody holds it — the caller may claim it and then write. */
	| { kind: "vacant" }
	/**
	 * The host cannot say: it predates writer-pid reporting, the owner never sent
	 * a pid, or the status call failed. Callers must NOT guess — an unknown owner
	 * is a delivery that has to be reported as unproven.
	 */
	| { kind: "unknown" }
	/** No binding at all; the pane's host is gone. */
	| { kind: "gone" };

/** The peer endpoint handle for a pid, or null when that process is not reachable. */
export function peerEndpointForPid(pid: number): string | null {
	if (!Number.isInteger(pid) || pid <= 0) return null;
	try {
		process.kill(pid, 0); // signal 0 = liveness probe, sends nothing
	} catch {
		return null;
	}
	for (const candidate of [`${SOCKETS_DIR}/${pid}.sock`, `${SOCKETS_DIR}/${pid}.endpoint.json`]) {
		if (existsSync(candidate)) return candidate;
	}
	return null;
}

/**
 * Who owns this pane's writes. Reads the answer from the HOST rather than from
 * any app-side bookkeeping: the host is the only process that knows which client
 * actually holds the lease.
 */
export async function resolvePaneOwner(terminal: NativeTaskTerminal | null): Promise<PaneOwner> {
	if (!terminal) return { kind: "gone" };
	if (terminal.hostRole() === "writer") return { kind: "local" };

	const writerPid = await terminal.writerPid();
	if (writerPid === undefined) return { kind: "unknown" };
	if (writerPid === null) return { kind: "vacant" };
	if (writerPid === process.pid) {
		// The host says we own it while our own client says otherwise: a role change
		// we have not processed yet. Treat as unknown rather than write blindly.
		return { kind: "unknown" };
	}

	const endpoint = peerEndpointForPid(writerPid);
	if (!endpoint) {
		// The owner died between holding the lease and now. The host clears the
		// writer on socket close, so a retry resolves to vacant shortly.
		log.info("Pane owner is unreachable", { writerPid });
		return { kind: "unknown" };
	}
	return { kind: "peer", pid: writerPid, endpoint };
}

/**
 * How far a failed forward got. Only `before-dispatch` is safe to treat as "nothing
 * happened"; `possibly-dispatched` starts the moment `socket.write` accepted the complete
 * framed request, and the caller owes an indeterminate verdict rather than a resend.
 */
export type ForwardPhase = "before-dispatch" | "possibly-dispatched";

/** A forward failure that says which side of dispatch it happened on. */
export class ForwardToOwnerError extends Error {
	constructor(
		message: string,
		readonly phase: ForwardPhase,
		readonly ownerPid: number,
		options?: { cause?: unknown },
	) {
		super(message, options);
		this.name = "ForwardToOwnerError";
	}
}

export function isForwardToOwnerError(err: unknown): err is ForwardToOwnerError {
	return err instanceof ForwardToOwnerError;
}

/**
 * Run one request inside the owning app process and return its reply. Forward the WHOLE
 * delivery, not the bytes, so the owner performs it once. Every rejection is a
 * {@link ForwardToOwnerError}; only its `before-dispatch` phase means "not started".
 */
export function forwardToOwner<T = unknown>(
	owner: { pid: number; endpoint: string },
	method: string,
	params: Record<string, unknown>,
): Promise<T> {
	const record = isCliEndpointHandle(owner.endpoint) ? readEndpointRecord(owner.endpoint) : null;
	if (isCliEndpointHandle(owner.endpoint) && !record) {
		return Promise.reject(
			new ForwardToOwnerError(`peer ${owner.pid} has an unusable endpoint record`, "before-dispatch", owner.pid),
		);
	}
	// Unique per REQUEST: two concurrent forwards on one connection would otherwise share
	// an id and could be matched to each other's reply.
	const id = `owner-route-${process.pid}-${method}-${randomUUID()}`;
	const payload = JSON.stringify({ id, method, params, ...(record ? { token: record.token } : {}) }) + "\n";

	return new Promise<T>((resolve, reject) => {
		let buffer = "";
		let settled = false;
		// Flipped only after socket.write accepted the COMPLETE framed request.
		let phase: ForwardPhase = "before-dispatch";
		const fail = (message: string, cause?: unknown): void =>
			finish(() => reject(new ForwardToOwnerError(message, phase, owner.pid, cause === undefined ? undefined : { cause })));
		const finish = (fn: () => void) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			fn();
		};
		const timer = setTimeout(() => fail(`owner ${owner.pid} did not answer ${method} in time`), FORWARD_TIMEOUT_MS);

		const handlers = {
			open(socket: { write(data: string): unknown }) {
				// A short write leaves the request unparseable, so it stays `before-dispatch`.
				// The comparison is in BYTES: a multibyte payload's string length is smaller,
				// which would make a real short write look complete.
				const total = Buffer.byteLength(payload, "utf8");
				const written = socket.write(payload);
				if (typeof written === "number" && written < total) {
					fail(`owner ${owner.pid} accepted only ${written}/${total} bytes of ${method}`);
					return;
				}
				phase = "possibly-dispatched";
			},
			data(_socket: unknown, chunk: Uint8Array) {
				buffer += new TextDecoder().decode(chunk);
				const newline = buffer.indexOf("\n");
				if (newline === -1) return;
				let response: CliResponse;
				try {
					response = JSON.parse(buffer.slice(0, newline)) as CliResponse;
				} catch (err) {
					fail(`owner ${owner.pid} sent an unparseable reply: ${String(err)}`, err);
					return;
				}
				if (response.ok) {
					finish(() => resolve(response.data as T));
					return;
				}
				fail(response.error || `owner ${owner.pid} refused ${method}`);
			},
			close() {
				fail(`owner ${owner.pid} closed before answering ${method}`);
			},
			error(_socket: unknown, error: unknown) {
				fail(String(error instanceof Error ? error.message : error), error);
			},
			drain() { /* no-op */ },
		};

		try {
			const connecting = record
				? Bun.connect({ hostname: record.host, port: record.port, socket: handlers } as never)
				: Bun.connect({ unix: owner.endpoint, socket: handlers } as never);
			connecting.catch((err) => fail(String(err instanceof Error ? err.message : err), err));
		} catch (err) {
			fail(String(err instanceof Error ? err.message : err), err);
		}
	});
}

function readEndpointRecord(path: string): ReturnType<typeof parseCliEndpointRecord> {
	try {
		return parseCliEndpointRecord(readFileSync(path, "utf-8"));
	} catch {
		return null;
	}
}
