import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createServer, type Server } from "node:net";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { CliRequest, CliResponse } from "../../shared/types";
import {
	CLI_ENDPOINT_VERSION,
	CLI_LOOPBACK_HOST,
	cliEndpointFileName,
	serializeCliEndpointRecord,
} from "../../shared/cli-endpoint";

// `../socket-client` is deliberately NOT mocked: these cases drive the real CLI
// commands through the real client over a real loopback socket, so the whole
// Windows carrier is exercised from argv to printed output. Only the context
// (which needs a live app + worktree on disk) is supplied.
vi.mock("../context", async (importOriginal) => ({
	...(await importOriginal<typeof import("../context")>()),
	detectContext: vi.fn(() => CONTEXT),
	detectContextDiagnostics: vi.fn(() => "test diagnostics"),
	readProjectDirect: vi.fn(() => null),
	readTaskDirect: vi.fn(() => null),
}));

vi.mock("../../shared/build-info.generated", () => ({
	BUILD_TIME: "Sat, 25 Jul 2026 · 00:00:00",
	BUILD_COMMIT: "deadbeef",
	BUILD_VERSION: "test",
}));

import { handleCurrent } from "../commands/current";
import { handleTask } from "../commands/task";
import { handleNote } from "../commands/note";
import { handleOverview } from "../commands/overview";
import { handleUi } from "../commands/ui-control";

const TASK_ID = "aabbccdd-1111-2222-3333-444444444444";
const PROJECT_ID = "11112222-3333-4444-5555-666666666666";
const TOKEN = "e".repeat(64);
const CONTEXT = { projectId: PROJECT_ID, taskId: TASK_ID, socketPath: "" };

const servers: Server[] = [];
const dirs: string[] = [];
let stdout = "";
let stdoutSpy: ReturnType<typeof vi.spyOn>;

/** Minimal stand-in app: records requests, answers with canned data. */
function startApp(): Promise<{ endpoint: string; received: CliRequest[] }> {
	const received: CliRequest[] = [];
	const dir = mkdtempSync(join(process.env.DEV3_TEST_ROOT as string, "cli-cmd-loopback-"));
	dirs.push(dir);

	return new Promise((resolve) => {
		const server = createServer((conn) => {
			let buf = "";
			conn.on("data", (chunk) => {
				buf += chunk.toString();
				const lines = buf.split("\n");
				buf = lines.pop() ?? "";
				for (const line of lines) {
					if (!line.trim()) continue;
					const req = JSON.parse(line) as CliRequest;
					received.push(req);
					conn.write(JSON.stringify(reply(req)) + "\n");
					conn.end();
				}
			});
		});
		servers.push(server);
		server.listen(0, CLI_LOOPBACK_HOST, () => {
			const address = server.address();
			const port = typeof address === "object" && address ? address.port : 0;
			const endpoint = join(dir, cliEndpointFileName(4242));
			writeFileSync(endpoint, serializeCliEndpointRecord({
				v: CLI_ENDPOINT_VERSION,
				pid: 4242,
				host: CLI_LOOPBACK_HOST,
				port,
				token: TOKEN,
				hostTaskId: null,
				startedAt: "2026-07-25T10:00:00.000Z",
			}));
			resolve({ endpoint, received });
		});
	});
}

function reply(req: CliRequest): CliResponse {
	const task = {
		id: TASK_ID,
		projectId: PROJECT_ID,
		seq: 1296,
		title: "Connect the Windows CLI to the desktop app",
		description: "desc",
		status: "in-progress",
		priority: "P3",
		createdAt: 1,
		updatedAt: 2,
		labelIds: [],
		overview: "Loopback transport",
	};
	switch (req.method) {
		case "current":
			return { id: req.id, ok: true, data: { project: { id: PROJECT_ID, name: "dev-3.0", path: "/repo" }, task } };
		case "task.show":
			return { id: req.id, ok: true, data: task };
		case "task.update":
			return { id: req.id, ok: true, data: { task: { ...task, title: String(req.params.title ?? task.title) }, titlePreserved: false } };
		case "note.add":
			return {
				id: req.id,
				ok: true,
				data: { ...task, notes: [{ id: "note-1234abcd", content: String(req.params.content), source: "ai", createdAt: 3 }] },
			};
		case "overview.set":
			return { id: req.id, ok: true, data: { ...task, overview: String(req.params.overview) } };
		case "ui.state":
			return {
				id: req.id,
				ok: true,
				data: { appRunning: true, foreground: true, userIdleSeconds: 4, activeProjectId: PROJECT_ID, activeTaskId: TASK_ID },
			};
		default:
			return { id: req.id, ok: false, error: `Unknown method: ${req.method}` };
	}
}

function args(flags: Record<string, string | boolean> = {}, positional: string[] = []) {
	return { flags, positional } as never;
}

beforeEach(() => {
	stdout = "";
	stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
		stdout += String(chunk);
		return true;
	});
});

afterEach(() => {
	stdoutSpy.mockRestore();
	for (const server of servers.splice(0)) server.close();
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("representative CLI commands over the loopback transport", () => {
	it("current reads the active project and task", async () => {
		const { endpoint, received } = await startApp();

		await handleCurrent(endpoint, { brief: true });

		expect(received.length).toBeGreaterThan(0);
		expect(received.every((req) => req.token === TOKEN)).toBe(true);
		expect(stdout).toContain("Seq:         1296");
		expect(stdout).toContain("Connect the Windows CLI to the desktop app");
		expect(stdout).toContain("Loopback transport");
	});

	it("task show reads a single task", async () => {
		const { endpoint, received } = await startApp();

		await handleTask("show", args({ task: TASK_ID }), endpoint, CONTEXT);

		expect(received[0].method).toBe("task.show");
		expect(received[0].token).toBe(TOKEN);
		expect(stdout).toContain("Connect the Windows CLI to the desktop app");
	});

	it("task update mutates the task", async () => {
		const { endpoint, received } = await startApp();

		await handleTask("update", args({ task: TASK_ID, title: "Renamed by loopback" }), endpoint, CONTEXT);

		expect(received[0].method).toBe("task.update");
		expect(received[0].params).toMatchObject({ taskId: TASK_ID, title: "Renamed by loopback" });
		expect(received[0].token).toBe(TOKEN);
	});

	it("note add writes a note", async () => {
		const { endpoint, received } = await startApp();

		await handleNote("add", args({ task: TASK_ID }, ["Loopback works"]), endpoint, CONTEXT);

		expect(received[0].method).toBe("note.add");
		expect(received[0].params).toMatchObject({ content: "Loopback works" });
		expect(received[0].token).toBe(TOKEN);
	});

	it("overview set writes the overview", async () => {
		const { endpoint, received } = await startApp();

		await handleOverview("set", args({ task: TASK_ID }, ["Now on loopback"]), endpoint, CONTEXT);

		expect(received[0].method).toBe("overview.set");
		expect(received[0].params).toMatchObject({ overview: "Now on loopback" });
		expect(received[0].token).toBe(TOKEN);
	});

	it("ui state returns the app diagnostic", async () => {
		const { endpoint, received } = await startApp();

		await handleUi("state", args({ json: true }), endpoint, CONTEXT);

		expect(received[0].method).toBe("ui.state");
		expect(received[0].token).toBe(TOKEN);
		expect(JSON.parse(stdout)).toMatchObject({ appRunning: true, foreground: true });
	});
});
