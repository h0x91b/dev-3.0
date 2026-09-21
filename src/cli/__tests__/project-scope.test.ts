import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { createServer, type Server } from "node:net";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
	CLI_ENDPOINT_VERSION,
	CLI_LOOPBACK_HOST,
	cliEndpointFileName,
	serializeCliEndpointRecord,
} from "../../shared/cli-endpoint";
import { projectStorageKey } from "../../shared/project-storage-key";
import type { CliRequest, CliResponse } from "../../shared/types";

/**
 * Which project a command targets when nobody typed `--project`, driven through
 * the REAL CLI: argv → `parseArgs` → `detectContext(cwd)` → the request that
 * lands on the socket. Mocking the context away is exactly what let the bug
 * survive — `dev3 peek --task seq:130` sent no project at all and the app,
 * seeing none, searched every board and reported a collision the caller was
 * standing inside of.
 *
 * Two boards both carry `seq:130` on purpose: every board counts from 1, so a
 * collision is the normal case, not a corner one.
 */

const CLI_ENTRY = fileURLToPath(new URL("../main.ts", import.meta.url));
const TOKEN = "c".repeat(64);

const PROJECT_A = "aaaa1111-2222-3333-4444-555555555555";
const PROJECT_B = "bbbb1111-2222-3333-4444-555555555555";
const TASK_A130 = "a130aaaa-1111-2222-3333-444444444444";
const TASK_B130 = "b130bbbb-1111-2222-3333-444444444444";

let root: string;
let dev3Home: string;
let checkoutA: string;
let checkoutB: string;
let worktreeA: string;
let outsideDir: string;
let server: Server | null = null;
let received: CliRequest[] = [];

function writeJson(path: string, value: unknown): void {
	mkdirSync(join(path, ".."), { recursive: true });
	writeFileSync(path, JSON.stringify(value, null, 2));
}

/** Minimal stand-in app: records every request, answers ok with canned data. */
function startApp(port = 0): Promise<number> {
	return new Promise((resolve) => {
		const srv = createServer((conn) => {
			let buf = "";
			conn.on("data", (chunk) => {
				buf += chunk.toString();
				const lines = buf.split("\n");
				buf = lines.pop() ?? "";
				for (const line of lines) {
					if (!line.trim()) continue;
					const req = JSON.parse(line) as CliRequest;
					received.push(req);
					const resp: CliResponse = { id: req.id, ok: true, data: reply(req.method) };
					conn.write(`${JSON.stringify(resp)}\n`);
					conn.end();
				}
			});
		});
		server = srv;
		srv.listen(port, CLI_LOOPBACK_HOST, () => {
			const address = srv.address();
			resolve(typeof address === "object" && address ? address.port : 0);
		});
	});
}

function reply(method: string): unknown {
	if (method === "task.peek") {
		return {
			taskId: TASK_A130,
			seq: 130,
			title: "Fixture task",
			status: "in-progress",
			backend: "tmux",
			observedAt: new Date().toISOString(),
			sessionPresent: false,
			unavailable: "not-running",
			panes: [],
			tail: null,
		};
	}
	if (method === "pane.list") {
		return { backend: "tmux", panes: [], runs: [] };
	}
	if (method === "note.add") {
		return { id: TASK_A130, notes: [{ id: "note-1234abcd", content: "x", source: "ai", createdAt: 1 }] };
	}
	return {};
}

/**
 * Run the real CLI with a fixture data root and a cwd of our choosing.
 *
 * Asynchronously, deliberately: the stand-in app listens on THIS process's event
 * loop, so a blocking `spawnSync` would never let it accept the child's
 * connection and every case would fail on the client's 30s socket timeout.
 */
function runCli(argv: string[], cwd: string): Promise<{ status: number; stdout: string; stderr: string }> {
	return new Promise((resolve) => {
		const child = spawn("bun", [CLI_ENTRY, ...argv], {
			cwd,
			env: { ...process.env, HOME: root, DEV3_HOME: dev3Home },
		});
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk) => (stdout += String(chunk)));
		child.stderr.on("data", (chunk) => (stderr += String(chunk)));
		child.on("close", (code) => resolve({ status: code ?? -1, stdout, stderr }));
	});
}

function lastRequest(): CliRequest | undefined {
	return received[received.length - 1];
}

/** The project the CLI stamped on the last request, or undefined when it sent none. */
function lastProjectId(): unknown {
	return lastRequest()?.params?.projectId;
}

beforeAll(async () => {
	root = mkdtempSync(join(process.env.DEV3_TEST_ROOT as string, "cli-project-scope-"));
	dev3Home = join(root, ".dev3.0");
	checkoutA = join(root, "checkouts", "alpha");
	checkoutB = join(root, "checkouts", "beta");
	outsideDir = join(root, "elsewhere");
	for (const dir of [checkoutA, checkoutB, outsideDir]) mkdirSync(dir, { recursive: true });

	writeJson(join(dev3Home, "projects.json"), [
		{ id: PROJECT_A, name: "Alpha", path: checkoutA },
		{ id: PROJECT_B, name: "Beta", path: checkoutB },
	]);
	const slugA = projectStorageKey(checkoutA);
	const slugB = projectStorageKey(checkoutB);
	writeJson(join(dev3Home, "data", slugA, "tasks.json"), [
		{ id: TASK_A130, projectId: PROJECT_A, seq: 130, title: "Alpha 130", status: "in-progress" },
	]);
	writeJson(join(dev3Home, "data", slugB, "tasks.json"), [
		{ id: TASK_B130, projectId: PROJECT_B, seq: 130, title: "Beta 130", status: "in-progress" },
		{ id: "b999bbbb-1111-2222-3333-444444444444", projectId: PROJECT_B, seq: 999, title: "Beta 999", status: "in-progress" },
	]);

	worktreeA = join(dev3Home, "worktrees", slugA, TASK_A130.slice(0, 8), "worktree");
	mkdirSync(worktreeA, { recursive: true });

	const port = await startApp();
	// A live pid is what makes the endpoint discoverable; the test process is one.
	writeJson(join(dev3Home, "sockets", "placeholder"), {});
	writeFileSync(
		join(dev3Home, "sockets", cliEndpointFileName(process.pid)),
		serializeCliEndpointRecord({
			v: CLI_ENDPOINT_VERSION,
			pid: process.pid,
			host: CLI_LOOPBACK_HOST,
			port,
			token: TOKEN,
			hostTaskId: null,
			startedAt: "2026-09-21T10:00:00.000Z",
		}),
	);
});

afterEach(() => {
	received = [];
});

afterAll(() => {
	server?.close();
	rmSync(root, { recursive: true, force: true });
});

describe("dev3 peek — which board a bare seq means", () => {
	it("scopes to the task worktree's own project", async () => {
		const run = await runCli(["peek", "--task", "seq:130", "--json"], worktreeA);

		expect(run.status).toBe(0);
		expect(lastRequest()?.method).toBe("task.peek");
		expect(lastProjectId()).toBe(PROJECT_A);
	});

	it("lets an explicit --project reach the other board", async () => {
		const run = await runCli(["peek", "--task", "seq:130", "--project", PROJECT_B.slice(0, 8), "--json"], worktreeA);

		expect(run.status).toBe(0);
		expect(lastProjectId()).toBe(PROJECT_B);
	});

	it("scopes to the project owning a plain checkout, with no task worktree at all", async () => {
		const run = await runCli(["peek", "--task", "seq:130", "--json"], checkoutA);

		expect(run.status).toBe(0);
		expect(lastProjectId()).toBe(PROJECT_A);
	});

	it("sends no project from a directory no project owns, leaving the choice to the app", async () => {
		const run = await runCli(["peek", "--task", "seq:130", "--json"], outsideDir);

		expect(run.status).toBe(0);
		expect(lastRequest()?.params).not.toHaveProperty("projectId");
	});
});

describe("other task-targeting commands scope the same way", () => {
	it("dev3 pane list scopes to the worktree's project", async () => {
		const run = await runCli(["pane", "list", "--task", "seq:130", "--json"], worktreeA);

		expect(run.status).toBe(0);
		expect(lastRequest()?.method).toBe("pane.list");
		expect(lastProjectId()).toBe(PROJECT_A);
	});

	it("dev3 note add scopes to the project owning a plain checkout", async () => {
		const run = await runCli(["note", "add", "--task", "seq:130", "recorded from a plain checkout"], checkoutA);

		expect(run.status).toBe(0);
		expect(lastRequest()?.method).toBe("note.add");
		expect(lastProjectId()).toBe(PROJECT_A);
	});
});
