import { existsSync, unlinkSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import type { CliRequest, CliResponse } from "../shared/types";
import { socketMetaPathFor, type SocketMeta } from "../shared/socket-meta";
import {
	CLI_ENDPOINT_TOKEN_MISMATCH,
	CLI_ENDPOINT_VERSION,
	CLI_LOOPBACK_HOST,
	cliEndpointFileName,
	serializeCliEndpointRecord,
	type CliEndpointRecord,
} from "../shared/cli-endpoint";
import { flushAndEnd, drainSocket, pendingWrites } from "./socket-backpressure";
import { createLogger } from "./logger";

const log = createLogger("cli-listener");

export const MAX_CLI_REQUEST_BYTES = 1024 * 1024;

/**
 * Transport for the CLI control listener. `unix` is the POSIX Unix-domain socket
 * (`<pid>.sock`); `tcp` is the Windows loopback-only listener whose ephemeral
 * port is published in `<pid>.endpoint.json`. Both speak the identical NDJSON
 * request/response protocol with identical framing and size bounds — only the
 * carrier and the endpoint handle differ. See `src/shared/cli-endpoint.ts`.
 */
export type CliTransport = "unix" | "tcp";

/**
 * Windows has no Unix-domain socket to bind, so it is the only platform that
 * uses the loopback carrier. Kept as a pure function so the mapping is testable
 * without touching `process.platform`.
 */
export function cliTransportFor(platform: string): CliTransport {
	return platform === "win32" ? "tcp" : "unix";
}

/** What a bound listener exposes; `port` is set for the loopback carrier only. */
export interface BoundListener {
	port?: number;
	stop(): void;
}

/**
 * Bind primitive, injectable so the framing, the endpoint record, and the
 * requested bind address can be asserted without a real socket (vitest runs on
 * Node, where `Bun.listen` does not exist). Production always uses `Bun.listen`.
 */
export type CliListenFn = (opts: {
	unix?: string;
	hostname?: string;
	port?: number;
	socket: unknown;
}) => BoundListener;

const bunListen: CliListenFn = (opts) => Bun.listen(opts as never) as unknown as BoundListener;

export interface StartCliListenerOptions {
	socketsDir: string;
	pid: number;
	/** Task context this instance was launched from, or null for a primary. */
	hostTaskId: string | null;
	transport: CliTransport;
	handle: (req: CliRequest) => Promise<CliResponse>;
	listen?: CliListenFn;
}

export interface CliListener {
	/** Endpoint handle: the `.sock` path, or the `.endpoint.json` record path. */
	endpoint: string;
	transport: CliTransport;
	/** Loopback port for `tcp`; undefined for `unix`. */
	port?: number;
	stop(): void;
}

/** Buffered partial NDJSON per connection (a request may span data events). */
const pendingRequestText = new Map<unknown, string>();

function formatKiB(bytes: number): number {
	return Math.ceil(bytes / 1024);
}

export function payloadTooLargeMessage(bytes: number): string {
	return `Payload exceeded ${formatKiB(MAX_CLI_REQUEST_BYTES)} KB limit, current size ${formatKiB(bytes)} KB`;
}

/** Minimal shape the framing needs from a Bun socket. */
type CliSocket = Parameters<typeof flushAndEnd>[0];

/**
 * Socket handlers shared by both transports, so framing, the 1 MB bound,
 * malformed-line handling, and backpressure cannot drift between platforms.
 * `token`, when set, is required on every request: a loopback TCP port has none
 * of a socket file's access control, and a mismatch also identifies a stale
 * record whose port now belongs to something else.
 */
export function createSocketHandlers(handle: StartCliListenerOptions["handle"], token: string | null) {
	return {
		open() {
			log.debug("CLI client connected");
		},
		async data(socket: CliSocket, raw: string | Uint8Array) {
			const text = typeof raw === "string" ? raw : Buffer.from(raw).toString("utf-8");
			const buffered = pendingRequestText.get(socket) || "";
			const combined = buffered + text;
			const combinedBytes = Buffer.byteLength(combined, "utf-8");

			if (combinedBytes > MAX_CLI_REQUEST_BYTES) {
				pendingRequestText.delete(socket);
				const errResp: CliResponse = {
					id: "unknown",
					ok: false,
					error: payloadTooLargeMessage(combinedBytes),
				};
				flushAndEnd(socket, JSON.stringify(errResp) + "\n");
				return;
			}

			// Handle multiple NDJSON messages in one chunk — accumulate all
			// responses first, then flush once to avoid interleaved partial writes.
			let responseData = "";
			const lines = combined.split("\n");
			const tail = lines.pop() || "";
			if (tail) {
				pendingRequestText.set(socket, tail);
			} else {
				pendingRequestText.delete(socket);
			}

			for (const line of lines) {
				if (!line.trim()) continue;

				let req: CliRequest;
				try {
					req = JSON.parse(line);
				} catch {
					const bytes = Buffer.byteLength(line, "utf-8");
					const errResp: CliResponse = {
						id: "unknown",
						ok: false,
						error: `Invalid JSON in CLI request (${formatKiB(bytes)} KB). The request may be truncated or corrupted.`,
					};
					responseData += JSON.stringify(errResp) + "\n";
					continue;
				}

				if (token !== null && req.token !== token) {
					log.warn("Rejected CLI request with a mismatched endpoint token", { method: req.method });
					responseData += JSON.stringify({ id: req.id ?? "unknown", ok: false, error: CLI_ENDPOINT_TOKEN_MISMATCH } satisfies CliResponse) + "\n";
					continue;
				}

				const resp = await handle(req);
				responseData += JSON.stringify(resp) + "\n";
			}

			if (responseData) {
				flushAndEnd(socket, responseData);
			}
		},
		drain(socket: CliSocket) {
			drainSocket(socket);
		},
		close(socket: CliSocket) {
			pendingWrites.delete(socket);
			pendingRequestText.delete(socket);
			log.debug("CLI client disconnected");
		},
		error(_socket: CliSocket, error: unknown) {
			log.error("CLI socket error", { error: String(error) });
		},
	};
}

/**
 * Bind the CLI control listener and publish its endpoint handle.
 *
 * `unix` reproduces the historical behavior exactly: bind `<pid>.sock`, write the
 * `<pid>.meta.json` guest sidecar. `tcp` binds 127.0.0.1 on an ephemeral port —
 * never a wildcard or LAN address — and writes `<pid>.endpoint.json` with the
 * port plus a fresh random token, after the bind so the assigned port is known.
 */
export function startCliListener(opts: StartCliListenerOptions): CliListener {
	const listen = opts.listen ?? bunListen;

	if (opts.transport === "unix") {
		const endpoint = `${opts.socketsDir}/${opts.pid}.sock`;

		// Remove leftover socket file if it exists
		if (existsSync(endpoint)) {
			unlinkSync(endpoint);
		}

		const listener = listen({
			unix: endpoint,
			socket: createSocketHandlers(opts.handle, null),
		});

		// Meta sidecar: record whether this instance was launched from inside a dev3
		// task context (DEV3_TASK_ID is injected into task/dev-server tmux panes —
		// devScript-booted dev builds, `dev3 remote` from an agent pane). The CLI
		// deprioritizes such guest sockets during discovery so control commands
		// route to the primary app instead of an instance the command may be about
		// to tear down (#910/#920). See src/shared/socket-meta.ts.
		try {
			const meta: SocketMeta = {
				pid: opts.pid,
				hostTaskId: opts.hostTaskId,
				startedAt: new Date().toISOString(),
			};
			writeFileSync(socketMetaPathFor(endpoint), JSON.stringify(meta));
		} catch (err) {
			log.warn("Failed to write socket meta sidecar (non-fatal)", { error: String(err) });
		}

		return { endpoint, transport: "unix", stop: () => listener.stop() };
	}

	const token = randomBytes(32).toString("hex");
	const listener = listen({
		hostname: CLI_LOOPBACK_HOST,
		port: 0,
		socket: createSocketHandlers(opts.handle, token),
	});
	if (typeof listener.port !== "number") throw new Error("Loopback CLI listener did not report a bound port");

	const endpoint = `${opts.socketsDir}/${cliEndpointFileName(opts.pid)}`;
	const record: CliEndpointRecord = {
		v: CLI_ENDPOINT_VERSION,
		pid: opts.pid,
		host: CLI_LOOPBACK_HOST,
		port: listener.port,
		token,
		hostTaskId: opts.hostTaskId,
		startedAt: new Date().toISOString(),
	};
	writeFileSync(endpoint, serializeCliEndpointRecord(record));

	return { endpoint, transport: "tcp", port: listener.port, stop: () => listener.stop() };
}
