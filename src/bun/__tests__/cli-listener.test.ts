import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import {
	cliTransportFor,
	createSocketHandlers,
	startCliListener,
	payloadTooLargeMessage,
	MAX_CLI_REQUEST_BYTES,
	type BoundListener,
	type CliListenFn,
} from "../cli-listener";
import { pendingWrites } from "../socket-backpressure";
import { CLI_ENDPOINT_TOKEN_MISMATCH, cliEndpointFileName, parseCliEndpointRecord } from "../../shared/cli-endpoint";
import type { CliRequest, CliResponse } from "../../shared/types";

/**
 * The real bind is `Bun.listen`, which does not exist under vitest's Node
 * runtime — inject a fake that records what was requested and hands back the
 * socket handlers so framing can be driven directly. The real round-trip over a
 * real loopback socket is proved by `cli-loopback-transport.bun-e2e.ts`.
 */
function fakeListen(port = 51515) {
	const calls: Array<{ unix?: string; hostname?: string; port?: number; socket: unknown }> = [];
	let stopped = 0;
	const listen: CliListenFn = (opts) => {
		calls.push(opts);
		const bound: BoundListener = { port: opts.unix ? undefined : port, stop: () => { stopped++; } };
		return bound;
	};
	return {
		listen,
		calls,
		stopped: () => stopped,
		handlers: () => calls[calls.length - 1].socket as ReturnType<typeof createSocketHandlers>,
	};
}

function tempSocketsDir(): string {
	return mkdtempSync(join(process.env.DEV3_TEST_ROOT as string, "cli-listener-"));
}

const echoHandler = async (req: CliRequest): Promise<CliResponse> => ({ id: req.id, ok: true, data: { echoed: req.method } });

/** Mock socket that captures everything the handlers write. */
function mockSocket() {
	const written: Buffer[] = [];
	return {
		written,
		text: () => Buffer.concat(written).toString("utf-8"),
		write(data: Buffer): number {
			written.push(Buffer.from(data));
			return data.length;
		},
		end(): void { /* nothing to assert */ },
	};
}

function responses(socket: ReturnType<typeof mockSocket>): CliResponse[] {
	return socket.text().split("\n").filter((line) => line.trim()).map((line) => JSON.parse(line) as CliResponse);
}

function requestLine(method: string, token?: string): string {
	const req: CliRequest = { id: `req-${method}`, method, params: {}, ...(token ? { token } : {}) };
	return JSON.stringify(req) + "\n";
}

function readRecord(endpoint: string) {
	const record = parseCliEndpointRecord(readFileSync(endpoint, "utf-8"));
	if (!record) throw new Error(`Endpoint record did not parse: ${endpoint}`);
	return record;
}

beforeEach(() => {
	pendingWrites.clear();
});

describe("cliTransportFor", () => {
	it("uses the loopback carrier only on Windows", () => {
		expect(cliTransportFor("win32")).toBe("tcp");
		expect(cliTransportFor("darwin")).toBe("unix");
		expect(cliTransportFor("linux")).toBe("unix");
	});
});

describe("startCliListener (unix transport)", () => {
	it("binds the historical socket path and writes the guest sidecar", () => {
		const dir = tempSocketsDir();
		const fake = fakeListen();

		const listener = startCliListener({
			socketsDir: dir,
			pid: 4242,
			hostTaskId: "aabbccdd-1111-2222-3333-444444444444",
			transport: "unix",
			handle: echoHandler,
			listen: fake.listen,
		});

		expect(listener.endpoint).toBe(join(dir, "4242.sock"));
		expect(listener.transport).toBe("unix");
		expect(listener.port).toBeUndefined();
		expect(fake.calls[0].unix).toBe(join(dir, "4242.sock"));
		expect(fake.calls[0].hostname).toBeUndefined();

		// No endpoint record on POSIX — older builds must keep seeing only `.sock`.
		expect(existsSync(join(dir, cliEndpointFileName(4242)))).toBe(false);
		const meta = JSON.parse(readFileSync(join(dir, "4242.meta.json"), "utf-8"));
		expect(meta).toMatchObject({ pid: 4242, hostTaskId: "aabbccdd-1111-2222-3333-444444444444" });
	});

	it("never requires a token on the Unix carrier", async () => {
		const dir = tempSocketsDir();
		const fake = fakeListen();
		startCliListener({ socketsDir: dir, pid: 4243, hostTaskId: null, transport: "unix", handle: echoHandler, listen: fake.listen });

		const socket = mockSocket();
		await fake.handlers().data(socket, requestLine("task.show"));

		expect(responses(socket)[0]).toMatchObject({ ok: true, data: { echoed: "task.show" } });
	});
});

describe("startCliListener (loopback TCP transport)", () => {
	it("binds 127.0.0.1 on an ephemeral port and publishes the record", () => {
		const dir = tempSocketsDir();
		const fake = fakeListen(60123);

		const listener = startCliListener({
			socketsDir: dir,
			pid: 7001,
			hostTaskId: null,
			transport: "tcp",
			handle: echoHandler,
			listen: fake.listen,
		});

		expect(fake.calls[0].hostname).toBe("127.0.0.1");
		expect(fake.calls[0].port).toBe(0);
		expect(fake.calls[0].unix).toBeUndefined();

		expect(listener.endpoint).toBe(join(dir, cliEndpointFileName(7001)));
		expect(listener.transport).toBe("tcp");
		expect(listener.port).toBe(60123);

		const record = readRecord(listener.endpoint);
		expect(record).toMatchObject({ v: 1, pid: 7001, host: "127.0.0.1", port: 60123, hostTaskId: null });
		expect(record.token).toHaveLength(64);

		// The loopback record carries its own guest info — no separate sidecar.
		expect(existsSync(join(dir, "7001.meta.json"))).toBe(false);
	});

	it("records the launching task so guest instances stay identifiable", () => {
		const dir = tempSocketsDir();
		const fake = fakeListen();
		const listener = startCliListener({
			socketsDir: dir,
			pid: 7002,
			hostTaskId: "deadbeef-1111-2222-3333-444444444444",
			transport: "tcp",
			handle: echoHandler,
			listen: fake.listen,
		});

		expect(readRecord(listener.endpoint).hostTaskId).toBe("deadbeef-1111-2222-3333-444444444444");
	});

	it("gives two coexisting instances distinct records and tokens", () => {
		const dir = tempSocketsDir();
		const first = readRecord(startCliListener({
			socketsDir: dir, pid: 8001, hostTaskId: null, transport: "tcp", handle: echoHandler, listen: fakeListen(60001).listen,
		}).endpoint);
		const second = readRecord(startCliListener({
			socketsDir: dir, pid: 8002, hostTaskId: null, transport: "tcp", handle: echoHandler, listen: fakeListen(60002).listen,
		}).endpoint);

		expect(first.port).toBe(60001);
		expect(second.port).toBe(60002);
		expect(second.token).not.toBe(first.token);
	});

	it("fails loudly when the bind reports no port instead of publishing a broken record", () => {
		const dir = tempSocketsDir();
		const portless: CliListenFn = () => ({ stop: () => {} });

		expect(() => startCliListener({
			socketsDir: dir, pid: 8003, hostTaskId: null, transport: "tcp", handle: echoHandler, listen: portless,
		})).toThrow(/did not report a bound port/);
		expect(existsSync(join(dir, cliEndpointFileName(8003)))).toBe(false);
	});
});

describe("loopback request handling", () => {
	function startTcp(): { handlers: ReturnType<typeof createSocketHandlers>; token: string } {
		const dir = tempSocketsDir();
		const fake = fakeListen();
		const listener = startCliListener({
			socketsDir: dir, pid: 9001, hostTaskId: null, transport: "tcp", handle: echoHandler, listen: fake.listen,
		});
		return { handlers: fake.handlers(), token: readRecord(listener.endpoint).token };
	}

	it("answers the existing request contract when the token matches", async () => {
		const { handlers, token } = startTcp();
		const socket = mockSocket();

		await handlers.data(socket, requestLine("task.update", token));

		expect(responses(socket)[0]).toMatchObject({ id: "req-task.update", ok: true, data: { echoed: "task.update" } });
	});

	it("rejects a mismatched token", async () => {
		const { handlers } = startTcp();
		const socket = mockSocket();

		await handlers.data(socket, requestLine("task.update", "not-the-token"));

		expect(responses(socket)[0]).toMatchObject({ ok: false, error: CLI_ENDPOINT_TOKEN_MISMATCH });
	});

	it("rejects a request carrying no token", async () => {
		const { handlers } = startTcp();
		const socket = mockSocket();

		await handlers.data(socket, requestLine("task.update"));

		expect(responses(socket)[0]).toMatchObject({ ok: false, error: CLI_ENDPOINT_TOKEN_MISMATCH });
	});

	it("reports a malformed frame the same way the Unix carrier does", async () => {
		const { handlers } = startTcp();
		const socket = mockSocket();

		await handlers.data(socket, "{not json at all\n");

		expect(responses(socket)[0].id).toBe("unknown");
		expect(responses(socket)[0].error).toContain("Invalid JSON in CLI request");
	});

	it("rejects an oversized request with the shared size-bound message", async () => {
		const { handlers, token } = startTcp();
		const socket = mockSocket();
		const oversized = "x".repeat(MAX_CLI_REQUEST_BYTES + 512);

		await handlers.data(socket, oversized);

		expect(responses(socket)[0].error).toBe(payloadTooLargeMessage(MAX_CLI_REQUEST_BYTES + 512));
		// A valid request on a fresh connection still works afterwards.
		const next = mockSocket();
		await handlers.data(next, requestLine("current", token));
		expect(responses(next)[0].ok).toBe(true);
	});

	it("buffers a request split across data events", async () => {
		const { handlers, token } = startTcp();
		const socket = mockSocket();
		const line = requestLine("note.add", token);
		const half = Math.floor(line.length / 2);

		await handlers.data(socket, line.slice(0, half));
		expect(responses(socket)).toHaveLength(0);
		await handlers.data(socket, line.slice(half));

		expect(responses(socket)[0]).toMatchObject({ ok: true, data: { echoed: "note.add" } });
	});

	it("answers every request in a batched chunk", async () => {
		const { handlers, token } = startTcp();
		const socket = mockSocket();

		await handlers.data(socket, requestLine("current", token) + requestLine("overview.set", token));

		expect(responses(socket).map((r) => (r.data as { echoed: string }).echoed)).toEqual(["current", "overview.set"]);
	});

	it("drops per-connection buffers when a client disconnects mid-request", async () => {
		const { handlers, token } = startTcp();
		const socket = mockSocket();
		const line = requestLine("task.show", token);

		await handlers.data(socket, line.slice(0, 10));
		handlers.close(socket);

		// The tail is gone, so a re-sent full request is not corrupted by it.
		const resumed = mockSocket();
		await handlers.data(resumed, line);
		expect(responses(resumed)[0].ok).toBe(true);
	});
});
