import { describe, it, expect, afterEach } from "vitest";
import { createServer, type Server } from "node:net";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { sendRequest, isInstanceLossError } from "../socket-client";
import {
	CLI_ENDPOINT_TOKEN_MISMATCH,
	CLI_ENDPOINT_VERSION,
	CLI_LOOPBACK_HOST,
	cliEndpointFileName,
	serializeCliEndpointRecord,
} from "../../shared/cli-endpoint";
import type { CliRequest } from "../../shared/types";

const TOKEN = "b".repeat(64);

const servers: Server[] = [];
const dirs: string[] = [];

function tempDir(): string {
	const dir = mkdtempSync(join(process.env.DEV3_TEST_ROOT as string, "cli-loopback-"));
	dirs.push(dir);
	return dir;
}

/**
 * A loopback server that answers with whatever `reply` builds. `node:net` is the
 * same client `socket-client` uses, so this exercises the real TCP path end to
 * end (the app side's real `Bun.listen` is covered by the bun-e2e script).
 */
function startServer(reply: (req: CliRequest) => string | null): Promise<{ port: number; received: CliRequest[] }> {
	const received: CliRequest[] = [];
	return new Promise((resolve) => {
		const server = createServer((conn) => {
			let buf = "";
			conn.on("data", (chunk) => {
				buf += chunk.toString();
				for (const line of buf.split("\n")) {
					if (!line.trim()) continue;
					const req = JSON.parse(line) as CliRequest;
					received.push(req);
					const response = reply(req);
					if (response === null) {
						conn.end();
						return;
					}
					conn.write(response + "\n");
					conn.end();
				}
			});
		});
		servers.push(server);
		server.listen(0, CLI_LOOPBACK_HOST, () => {
			const address = server.address();
			resolve({ port: typeof address === "object" && address ? address.port : 0, received });
		});
	});
}

function writeRecord(dir: string, pid: number, overrides: Record<string, unknown> = {}): string {
	const endpoint = join(dir, cliEndpointFileName(pid));
	writeFileSync(endpoint, serializeCliEndpointRecord({
		v: CLI_ENDPOINT_VERSION,
		pid,
		host: CLI_LOOPBACK_HOST,
		port: 1,
		token: TOKEN,
		hostTaskId: null,
		startedAt: "2026-07-25T10:00:00.000Z",
		...overrides,
	} as never));
	return endpoint;
}

afterEach(() => {
	for (const server of servers.splice(0)) server.close();
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("sendRequest over a loopback endpoint record", () => {
	it("dials the record's port and attaches its token", async () => {
		const dir = tempDir();
		const { port, received } = await startServer((req) => JSON.stringify({ id: req.id, ok: true, data: { hello: "windows" } }));
		const endpoint = writeRecord(dir, 4242, { port });

		const resp = await sendRequest(endpoint, "task.show", { taskId: "abc" });

		expect(resp.ok).toBe(true);
		expect(resp.data).toEqual({ hello: "windows" });
		expect(received[0].method).toBe("task.show");
		expect(received[0].params).toEqual({ taskId: "abc" });
		expect(received[0].token).toBe(TOKEN);
	});

	it("never attaches a token when the handle is a Unix socket path", async () => {
		const dir = tempDir();
		const socketPath = join(dir, "unix.sock");
		const received: CliRequest[] = [];
		await new Promise<void>((resolve) => {
			const server = createServer((conn) => {
				conn.on("data", (chunk) => {
					const req = JSON.parse(chunk.toString().trim()) as CliRequest;
					received.push(req);
					conn.write(JSON.stringify({ id: req.id, ok: true }) + "\n");
					conn.end();
				});
			});
			servers.push(server);
			server.listen(socketPath, () => resolve());
		});

		await sendRequest(socketPath, "current", {});

		expect(received[0].token).toBeUndefined();
	});

	it("maps a token rejection to a stale-endpoint failure, not a command failure", async () => {
		const dir = tempDir();
		const { port } = await startServer((req) => JSON.stringify({ id: req.id, ok: false, error: CLI_ENDPOINT_TOKEN_MISMATCH }));
		const endpoint = writeRecord(dir, 4243, { port });

		const err = await sendRequest(endpoint, "task.show").catch((e) => e);

		expect(err).toBeInstanceOf(Error);
		expect((err as Error).name).toBe("StaleEndpointError");
		expect((err as Error & { reason: string }).reason).toContain("token");
		// Idempotent callers may re-discover another live instance.
		expect(isInstanceLossError(err)).toBe(true);
	});

	it("treats an unparseable record as a stale endpoint", async () => {
		const dir = tempDir();
		const endpoint = join(dir, cliEndpointFileName(4244));
		writeFileSync(endpoint, "{ this is not a record");

		const err = await sendRequest(endpoint, "task.show").catch((e) => e);

		expect((err as Error).name).toBe("StaleEndpointError");
		expect((err as Error & { reason: string }).reason).toContain("corrupt");
	});

	it("treats a record advertising a non-loopback host as a stale endpoint", async () => {
		const dir = tempDir();
		const endpoint = writeRecord(dir, 4245, { host: "10.0.0.5", port: 9999 });

		const err = await sendRequest(endpoint, "task.show").catch((e) => e);

		expect((err as Error).name).toBe("StaleEndpointError");
	});

	it("reports APP_NOT_RUNNING when the record vanished", async () => {
		const dir = tempDir();
		const endpoint = join(dir, cliEndpointFileName(4246));

		await expect(sendRequest(endpoint, "task.show", {}, { connectAttempts: 2, retryDelayMs: 1 })).rejects.toThrow("APP_NOT_RUNNING");
	});

	it("reports APP_NOT_RUNNING when nothing listens on the recorded port", async () => {
		const dir = tempDir();
		// Bind then immediately close, so the port is real but unowned.
		const { port } = await startServer(() => null);
		for (const server of servers.splice(0)) server.close();
		const endpoint = writeRecord(dir, 4247, { port });

		await expect(sendRequest(endpoint, "task.show", {}, { connectAttempts: 2, retryDelayMs: 1 })).rejects.toThrow("APP_NOT_RUNNING");
	});

	it("surfaces an empty response the same way the Unix carrier does", async () => {
		const dir = tempDir();
		const { port } = await startServer(() => null);
		const endpoint = writeRecord(dir, 4248, { port });

		await expect(sendRequest(endpoint, "task.show")).rejects.toThrow("Empty response from server");
	});

	it("routes two coexisting instances to their own ports", async () => {
		const dir = tempDir();
		const first = await startServer((req) => JSON.stringify({ id: req.id, ok: true, data: { instance: "first" } }));
		const second = await startServer((req) => JSON.stringify({ id: req.id, ok: true, data: { instance: "second" } }));
		const firstEndpoint = writeRecord(dir, 5001, { port: first.port });
		const secondEndpoint = writeRecord(dir, 5002, { port: second.port });

		expect((await sendRequest(firstEndpoint, "current")).data).toEqual({ instance: "first" });
		expect((await sendRequest(secondEndpoint, "current")).data).toEqual({ instance: "second" });
	});
});
