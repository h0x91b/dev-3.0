import { describe, it, expect, afterEach } from "vitest";
import { createServer, type Server } from "node:net";
import { unlinkSync, existsSync } from "node:fs";
import { sendRequest } from "../socket-client";

const TEST_SOCKET = "/tmp/dev3-cli-test-socket.sock";

function cleanSocket() {
	try {
		if (existsSync(TEST_SOCKET)) unlinkSync(TEST_SOCKET);
	} catch {}
}

function createMockServer(handler: (data: string) => string): Promise<Server> {
	return new Promise((resolve) => {
		cleanSocket();
		const server = createServer((conn) => {
			let buf = "";
			conn.on("data", (chunk) => {
				buf += chunk.toString();
				const lines = buf.split("\n");
				for (const line of lines) {
					if (!line.trim()) continue;
					const response = handler(line);
					conn.write(response + "\n");
					conn.end();
				}
			});
		});
		server.listen(TEST_SOCKET, () => resolve(server));
	});
}

afterEach(() => {
	cleanSocket();
});

describe("sendRequest", () => {
	it("sends NDJSON request and parses response", async () => {
		let receivedReq: any = null;
		const server = await createMockServer((data) => {
			receivedReq = JSON.parse(data);
			return JSON.stringify({ id: receivedReq.id, ok: true, data: { hello: "world" } });
		});

		try {
			const resp = await sendRequest(TEST_SOCKET, "test.method", { key: "val" });

			// Verify the request format
			expect(receivedReq).toBeTruthy();
			expect(receivedReq.method).toBe("test.method");
			expect(receivedReq.params).toEqual({ key: "val" });
			expect(receivedReq.id).toBeTruthy(); // UUID

			// Verify the response
			expect(resp.ok).toBe(true);
			expect(resp.data).toEqual({ hello: "world" });
		} finally {
			server.close();
		}
	});

	it("sends empty params by default", async () => {
		let receivedReq: any = null;
		const server = await createMockServer((data) => {
			receivedReq = JSON.parse(data);
			return JSON.stringify({ id: receivedReq.id, ok: true, data: null });
		});

		try {
			await sendRequest(TEST_SOCKET, "projects.list");
			expect(receivedReq.params).toEqual({});
		} finally {
			server.close();
		}
	});

	it("returns error response correctly", async () => {
		const server = await createMockServer((data) => {
			const req = JSON.parse(data);
			return JSON.stringify({ id: req.id, ok: false, error: "Task not found" });
		});

		try {
			const resp = await sendRequest(TEST_SOCKET, "task.show", { taskId: "bad" });
			expect(resp.ok).toBe(false);
			expect(resp.error).toBe("Task not found");
		} finally {
			server.close();
		}
	});

	it("throws APP_NOT_RUNNING when socket does not exist", async () => {
		await expect(
			sendRequest("/tmp/dev3-nonexistent-socket.sock", "test"),
		).rejects.toThrow("APP_NOT_RUNNING");
	});

	it("matches request and response IDs", async () => {
		const server = await createMockServer((data) => {
			const req = JSON.parse(data);
			return JSON.stringify({ id: req.id, ok: true, data: "matched" });
		});

		try {
			const resp = await sendRequest(TEST_SOCKET, "test");
			expect(resp.id).toBeTruthy();
			expect(resp.ok).toBe(true);
		} finally {
			server.close();
		}
	});
});
