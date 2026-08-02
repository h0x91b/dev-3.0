/**
 * The wire half of cross-instance owner routing (seq 1381, follow-up to #1218).
 *
 * `resolvePaneOwner` decides WHERE a pane's writes have to go; `forwardToOwner`
 * is what actually takes them there, and until now nothing exercised it. The
 * contract it has to keep is exactly-once: the owning process must perform the
 * whole delivery one time, and every failure must come back as a rejection so
 * the caller reports unproven delivery instead of quietly writing locally too.
 *
 * These run against REAL sockets — a `node:net` server on a unix path and on
 * loopback TCP — with `Bun.connect` bridged onto `node:net` for the duration,
 * because this vitest project runs in Node (see `src/bun/test-setup.ts`). The
 * NDJSON framing, the chunk boundaries, and the connection lifecycle are
 * genuine; only the dialer's name is borrowed. The same path is proven end to
 * end between two real Bun processes in `owner-routing.bun-e2e.ts`.
 */
import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from "vitest";
import net from "node:net";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("../logger", () => ({
	createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { forwardToOwner } from "../native-pane-owner";
import { CLI_ENDPOINT_VERSION, CLI_LOOPBACK_HOST, serializeCliEndpointRecord } from "../../shared/cli-endpoint";

const OWNER_PID = 4711;

/** One request the peer received, already split off the NDJSON stream. */
interface WireRequest {
	id: string;
	method: string;
	params: Record<string, unknown>;
	token?: string;
}

/**
 * A stand-in for the app process that holds the lease. It speaks the same
 * NDJSON request/response the CLI socket server does, and records every line it
 * was handed so a test can prove a delivery arrived exactly one time.
 */
class PeerProcess {
	readonly requests: WireRequest[] = [];
	/** Raw lines, so a malformed or duplicated delivery is still visible. */
	readonly lines: string[] = [];
	connections = 0;
	/** What to do with each request; default is a plain successful reply. */
	respond: (request: WireRequest, socket: net.Socket) => void = (request, socket) => {
		socket.write(`${JSON.stringify({ id: request.id, ok: true, data: { delivered: true } })}\n`);
	};

	private server: net.Server | null = null;
	private readonly sockets = new Set<net.Socket>();

	async listenOnUnixPath(path: string): Promise<string> {
		await this.listen((server) => server.listen(path));
		return path;
	}

	/** The ephemeral loopback port, for the `.endpoint.json` transport. */
	async listenOnLoopback(): Promise<number> {
		await this.listen((server) => server.listen(0, CLI_LOOPBACK_HOST));
		const address = this.server?.address();
		if (!address || typeof address === "string") throw new Error("no loopback port");
		return address.port;
	}

	close(): void {
		for (const socket of this.sockets) socket.destroy();
		this.sockets.clear();
		this.server?.close();
		this.server = null;
	}

	private listen(bind: (server: net.Server) => void): Promise<void> {
		const server = net.createServer((socket) => {
			this.connections++;
			this.sockets.add(socket);
			let buffer = "";
			socket.on("data", (chunk) => {
				buffer += chunk.toString("utf-8");
				for (;;) {
					const newline = buffer.indexOf("\n");
					if (newline === -1) break;
					const line = buffer.slice(0, newline);
					buffer = buffer.slice(newline + 1);
					if (!line) continue;
					this.lines.push(line);
					const request = JSON.parse(line) as WireRequest;
					this.requests.push(request);
					this.respond(request, socket);
				}
			});
			socket.on("error", () => { /* a test closing mid-flight is not a failure */ });
			socket.on("close", () => this.sockets.delete(socket));
		});
		this.server = server;
		return new Promise((resolve, reject) => {
			server.once("error", reject);
			server.once("listening", () => resolve());
			bind(server);
		});
	}
}

/**
 * `Bun.connect` over `node:net`, matching the shape `forwardToOwner` relies on:
 * a promise that rejects when the dial fails, and an `open`/`data`/`close`/
 * `error` handler set driven by the real socket.
 */
interface BunConnectOptions {
	unix?: string;
	hostname?: string;
	port?: number;
	socket: {
		open(socket: { write(data: string): unknown }): void;
		data(socket: unknown, chunk: Uint8Array): void;
		close(): void;
		error(socket: unknown, error: unknown): void;
	};
}

let restoreConnect: (() => void) | null = null;

beforeAll(() => {
	const bun = (globalThis as unknown as { Bun: Record<string, unknown> }).Bun;
	const previous = bun.connect;
	bun.connect = (options: BunConnectOptions) =>
		new Promise((resolve, reject) => {
			const socket = options.unix
				? net.connect(options.unix)
				: net.connect(options.port as number, options.hostname);
			const handle = { write: (data: string) => socket.write(data) };
			socket.on("connect", () => {
				options.socket.open(handle);
				resolve(handle);
			});
			// A node Buffer IS a Uint8Array at runtime; the cast only bridges the
			// ArrayBufferLike generic that TS distinguishes and Bun's handler does not.
			socket.on("data", (chunk) => options.socket.data(handle, chunk as unknown as Uint8Array));
			socket.on("close", () => options.socket.close());
			socket.on("error", (error) => {
				options.socket.error(handle, error);
				reject(error);
			});
		});
	restoreConnect = () => {
		bun.connect = previous;
	};
});

afterAll(() => {
	restoreConnect?.();
});

let root: string;
let peer: PeerProcess;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "dev3-owner-forward-"));
	peer = new PeerProcess();
});

afterEach(() => {
	peer.close();
	rmSync(root, { recursive: true, force: true });
});

/** A unix socket path short enough for the 104-byte sun_path limit. */
function socketPath(): string {
	return join(root, "o.sock");
}

function endpointRecord(port: number, token: string): string {
	const path = join(root, `${OWNER_PID}.endpoint.json`);
	writeFileSync(
		path,
		serializeCliEndpointRecord({
			v: CLI_ENDPOINT_VERSION,
			pid: OWNER_PID,
			host: CLI_LOOPBACK_HOST,
			port,
			token,
			hostTaskId: null,
			startedAt: "2026-08-02T00:00:00.000Z",
		}),
	);
	return path;
}

describe("forwardToOwner over a unix socket", () => {
	it("hands the owner the whole delivery and returns what it answered", async () => {
		const endpoint = await peer.listenOnUnixPath(socketPath());
		peer.respond = (request, socket) => {
			socket.write(`${JSON.stringify({ id: request.id, ok: true, data: { delivered: true, taskId: "t1" } })}\n`);
		};

		const reply = await forwardToOwner({ pid: OWNER_PID, endpoint }, "message.send", {
			taskId: "t1",
			text: "hello pane-1",
		});

		expect(reply).toEqual({ delivered: true, taskId: "t1" });
		expect(peer.requests).toHaveLength(1);
		expect(peer.requests[0]).toMatchObject({
			method: "message.send",
			params: { taskId: "t1", text: "hello pane-1" },
		});
	});

	// The whole point of forwarding a request rather than the bytes: the owner
	// performs it once. A second line on the wire is a second delivery.
	it("writes the delivery exactly once, even when the reply comes back in pieces", async () => {
		const endpoint = await peer.listenOnUnixPath(socketPath());
		peer.respond = (request, socket) => {
			const line = `${JSON.stringify({ id: request.id, ok: true, data: { delivered: true } })}\n`;
			socket.write(line.slice(0, 7));
			setTimeout(() => socket.write(line.slice(7)), 5);
		};

		await forwardToOwner({ pid: OWNER_PID, endpoint }, "message.send", { text: "once" });

		expect(peer.lines).toHaveLength(1);
		expect(peer.connections).toBe(1);
	});

	it("frames the request as one NDJSON line and sends no token over a socket file", async () => {
		const endpoint = await peer.listenOnUnixPath(socketPath());

		await forwardToOwner({ pid: OWNER_PID, endpoint }, "message.send", { text: "x" });

		expect(peer.lines[0].indexOf("\n")).toBe(-1);
		expect(JSON.parse(peer.lines[0])).not.toHaveProperty("token");
	});

	it("surfaces the owner's refusal instead of pretending the write landed", async () => {
		const endpoint = await peer.listenOnUnixPath(socketPath());
		peer.respond = (request, socket) => {
			socket.write(`${JSON.stringify({ id: request.id, ok: false, error: "pane-1 is gone" })}\n`);
		};

		await expect(forwardToOwner({ pid: OWNER_PID, endpoint }, "message.send", { text: "x" })).rejects.toThrow(
			"pane-1 is gone",
		);
	});

	it("rejects when the owner hangs up before answering", async () => {
		const endpoint = await peer.listenOnUnixPath(socketPath());
		peer.respond = (_request, socket) => socket.destroy();

		await expect(forwardToOwner({ pid: OWNER_PID, endpoint }, "message.send", { text: "x" })).rejects.toThrow(
			`owner ${OWNER_PID} closed before answering message.send`,
		);
	});

	it("rejects a reply it cannot parse rather than guessing the outcome", async () => {
		const endpoint = await peer.listenOnUnixPath(socketPath());
		peer.respond = (_request, socket) => socket.write("not json at all\n");

		await expect(forwardToOwner({ pid: OWNER_PID, endpoint }, "message.send", { text: "x" })).rejects.toThrow(
			"unparseable reply",
		);
	});

	it("rejects when the owner's socket is not there at all", async () => {
		await expect(
			forwardToOwner({ pid: OWNER_PID, endpoint: join(root, "missing.sock") }, "message.send", { text: "x" }),
		).rejects.toThrow();
	});
});

describe("forwardToOwner over a loopback endpoint record", () => {
	it("dials the recorded port and echoes the record's token", async () => {
		const port = await peer.listenOnLoopback();
		const endpoint = endpointRecord(port, "secret-token");

		const reply = await forwardToOwner({ pid: OWNER_PID, endpoint }, "message.send", { text: "x" });

		expect(reply).toEqual({ delivered: true });
		expect(peer.requests[0].token).toBe("secret-token");
	});

	// A corrupted record must fail before any dialling: a bad host or port is
	// exactly the case the record parser exists to refuse.
	it("refuses an unusable record without opening a connection", async () => {
		await peer.listenOnLoopback();
		const endpoint = join(root, `${OWNER_PID}.endpoint.json`);
		writeFileSync(endpoint, "{ this is not a record }");

		await expect(forwardToOwner({ pid: OWNER_PID, endpoint }, "message.send", { text: "x" })).rejects.toThrow(
			`peer ${OWNER_PID} has an unusable endpoint record`,
		);
		expect(peer.connections).toBe(0);
	});

	it("refuses a record that is missing entirely", async () => {
		const endpoint = join(root, "9999.endpoint.json");

		await expect(forwardToOwner({ pid: OWNER_PID, endpoint }, "message.send", { text: "x" })).rejects.toThrow(
			"unusable endpoint record",
		);
	});
});
