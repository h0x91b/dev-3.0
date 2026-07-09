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

	it("destroys socket on connection error to prevent fd leak", async () => {
		// Connect to a non-existent socket — the error handler should destroy
		// the socket immediately rather than waiting for the 30s timeout.
		const start = Date.now();
		try {
			await sendRequest("/tmp/dev3-nonexistent-socket.sock", "test");
		} catch (err) {
			// Expected to throw APP_NOT_RUNNING
			expect((err as Error).message).toBe("APP_NOT_RUNNING");
		}
		// If socket.destroy() is called in error handler, this resolves instantly.
		// Without destroy, it would hang for up to 30s.
		expect(Date.now() - start).toBeLessThan(5000);
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

	it("recovers from a transient connect failure once the app socket accepts (issue #714)", async () => {
		// Reproduces the false "app not running" verdict: the socket is briefly
		// unavailable (no listener yet, like a busy app that can't accept()), then
		// the app starts accepting. Without retry, sendRequest gives up on the very
		// first ECONNREFUSED/ENOENT; with retry it must eventually connect.
		cleanSocket();
		const serverPromise = new Promise<Server>((resolve) => {
			setTimeout(() => {
				const srv = createServer((conn) => {
					conn.on("data", (chunk) => {
						const req = JSON.parse(chunk.toString().trim());
						conn.write(JSON.stringify({ id: req.id, ok: true, data: { recovered: true } }) + "\n");
						conn.end();
					});
				});
				srv.listen(TEST_SOCKET, () => resolve(srv));
			}, 120);
		});

		try {
			const resp = await sendRequest(TEST_SOCKET, "test", {}, { connectAttempts: 10, retryDelayMs: 40 });
			expect(resp.ok).toBe(true);
			expect(resp.data).toEqual({ recovered: true });
		} finally {
			(await serverPromise).close();
		}
	});

	it("gives up with APP_NOT_RUNNING after exhausting connect retries", async () => {
		const start = Date.now();
		await expect(
			sendRequest("/tmp/dev3-nonexistent-socket.sock", "test", {}, { connectAttempts: 3, retryDelayMs: 20 }),
		).rejects.toThrow("APP_NOT_RUNNING");
		expect(Date.now() - start).toBeLessThan(5000);
	});

	it("does not retry a real error response from the server", async () => {
		let calls = 0;
		const server = await createMockServer((data) => {
			calls++;
			const req = JSON.parse(data);
			return JSON.stringify({ id: req.id, ok: false, error: "Task not found" });
		});

		try {
			const resp = await sendRequest(TEST_SOCKET, "task.show", { taskId: "bad" }, { connectAttempts: 5 });
			expect(resp.ok).toBe(false);
			expect(calls).toBe(1);
		} finally {
			server.close();
		}
	});

	// Reproduces the false "Empty response from server" failure on
	// dev-server stop/restart: the app drops the in-flight connection during the
	// tmux socket handoff and closes it with no reply. The first connection ends
	// with zero bytes; the settle-and-retry window must reconnect and get the
	// real status instead of surfacing the empty-response error (vents 07-04/06).
	it("retries an empty response and succeeds once the server replies", async () => {
		cleanSocket();
		let connections = 0;
		const server = await new Promise<Server>((resolve) => {
			const srv = createServer((conn) => {
				connections++;
				if (connections === 1) {
					// Handoff: accept, then close mid-request with no response body.
					conn.end();
					return;
				}
				conn.on("data", (chunk) => {
					const req = JSON.parse(chunk.toString().trim());
					conn.write(JSON.stringify({ id: req.id, ok: true, data: { running: false } }) + "\n");
					conn.end();
				});
			});
			srv.listen(TEST_SOCKET, () => resolve(srv));
		});

		try {
			const resp = await sendRequest(TEST_SOCKET, "devServer.stop", {}, {
				retryEmptyResponse: true,
				emptyResponseSettleMs: 10,
			});
			expect(resp.ok).toBe(true);
			expect(resp.data).toEqual({ running: false });
			expect(connections).toBe(2);
		} finally {
			server.close();
		}
	});

	it("does NOT retry an empty response unless the caller opts in", async () => {
		cleanSocket();
		let connections = 0;
		const server = await new Promise<Server>((resolve) => {
			const srv = createServer((conn) => {
				connections++;
				conn.end();
			});
			srv.listen(TEST_SOCKET, () => resolve(srv));
		});

		try {
			await expect(
				sendRequest(TEST_SOCKET, "task.create", {}),
			).rejects.toThrow("Empty response from server");
			// A non-idempotent mutation must not be silently replayed.
			expect(connections).toBe(1);
		} finally {
			server.close();
		}
	});

	it("gives up with 'Empty response from server' after exhausting empty-response retries", async () => {
		cleanSocket();
		let connections = 0;
		const server = await new Promise<Server>((resolve) => {
			const srv = createServer((conn) => {
				connections++;
				conn.end();
			});
			srv.listen(TEST_SOCKET, () => resolve(srv));
		});

		try {
			await expect(
				sendRequest(TEST_SOCKET, "devServer.restart", {}, {
					retryEmptyResponse: true,
					emptyResponseAttempts: 3,
					emptyResponseSettleMs: 10,
				}),
			).rejects.toThrow("Empty response from server");
			expect(connections).toBe(3);
		} finally {
			server.close();
		}
	});

	it("handles large responses without truncation", async () => {
		// Generate a large payload (~50KB) similar to tasks.list with many tasks
		const largeTasks = Array.from({ length: 100 }, (_, i) => ({
			id: crypto.randomUUID(),
			seq: i + 1,
			projectId: "proj-001",
			title: `Task ${i + 1}: ${"Описание задачи на русском языке для проверки ".repeat(3)}`,
			description: "Подробное описание ".repeat(20),
			status: "in-progress",
			baseBranch: "main",
			branchName: `dev3/task-${i}`,
			worktreePath: `/tmp/wt-${i}`,
			createdAt: new Date().toISOString(),
			updatedAt: new Date().toISOString(),
		}));

		const server = await createMockServer((data) => {
			const req = JSON.parse(data);
			return JSON.stringify({ id: req.id, ok: true, data: largeTasks });
		});

		try {
			const resp = await sendRequest(TEST_SOCKET, "tasks.list", { projectId: "proj-001" });
			expect(resp.ok).toBe(true);
			expect((resp.data as any[]).length).toBe(100);
		} finally {
			server.close();
		}
	});

	it("fails with truncated large response (reproduces tasks.list bug)", async () => {
		// Simulate what happens when Bun's socket.write() does a partial write
		// on a large response and socket.end() is called immediately after,
		// truncating the JSON mid-stream.
		const largeTasks = Array.from({ length: 100 }, (_, i) => ({
			id: crypto.randomUUID(),
			seq: i + 1,
			title: `Задача ${i + 1}: ${"Описание на русском ".repeat(5)}`,
			status: "in-progress",
		}));

		cleanSocket();
		const server = await new Promise<Server>((resolve) => {
			const srv = createServer((conn) => {
				conn.on("data", (chunk) => {
					const req = JSON.parse(chunk.toString().trim());
					const fullResponse = JSON.stringify({ id: req.id, ok: true, data: largeTasks }) + "\n";

					// Simulate Bun's partial socket.write(): send only ~60% of the response
					const truncated = fullResponse.slice(0, Math.floor(fullResponse.length * 0.6));
					conn.write(truncated);
					conn.end();
				});
			});
			srv.listen(TEST_SOCKET, () => resolve(srv));
		});

		try {
			await expect(
				sendRequest(TEST_SOCKET, "tasks.list", { projectId: "proj-001" }),
			).rejects.toThrow("Invalid JSON response");
		} finally {
			server.close();
		}
	});
});
