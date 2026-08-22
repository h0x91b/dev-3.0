import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn } from "node:child_process";
import { createServer, type Server } from "node:net";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import type { CliRequest, CliResponse } from "../../shared/types";
import {
	CLI_ENDPOINT_VERSION,
	CLI_LOOPBACK_HOST,
	cliEndpointFileName,
	serializeCliEndpointRecord,
} from "../../shared/cli-endpoint";
import { writeDev3SelfShim } from "../cli-self-install";

/**
 * Routing proof at the process level: a REAL `dev3` CLI process, real argv, real
 * socket transport, and two real instances listening at once — the installed app
 * plus a task's own dev-server. Unit tests can only show that the resolver picks
 * a path; this shows which instance actually receives the request.
 *
 * Both halves matter equally:
 *  - a human shell (`--instance`, DEV3_CLI_SOCKET, the armed `dev3-self` shim)
 *    reaches the task's own dev-server;
 *  - everything an agent runs — no flag, DEV3_TASK_ID injected, cwd inside the
 *    task worktree, which is exactly how status hooks run — still reaches the
 *    primary, as it does today.
 */

const REPO_ROOT = resolve(import.meta.dirname, "../../..");
const CLI_ENTRY = join(REPO_ROOT, "src", "cli", "main.ts");

const TASK_A = "aabbccdd-1111-2222-3333-444444444444";
const TASK_B = "bbccddee-1111-2222-3333-444444444444";
const PROJECT_ID = "11112222-3333-4444-5555-666666666666";
const PROJECT_PATH = "/test/project";
const PROJECT_SLUG = "test-project";
const TOKEN = "e".repeat(64);

let root: string;
let dev3Home: string;
let worktreeA: string;
const servers: Server[] = [];
const seen: Record<string, CliRequest[]> = {};

/**
 * A stand-in instance: a loopback listener plus the endpoint record the CLI
 * discovers it by. `pid` must be a live process for discovery to accept it, so
 * the two instances borrow this process and its parent.
 */
async function startInstance(name: string, pid: number, hostTaskId: string | null): Promise<void> {
	const received: CliRequest[] = [];
	seen[name] = received;
	await new Promise<void>((done) => {
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
					const res: CliResponse = { id: req.id, ok: true, data: { instance: name } };
					conn.write(`${JSON.stringify(res)}\n`);
					conn.end();
				}
			});
		});
		servers.push(server);
		server.listen(0, CLI_LOOPBACK_HOST, () => {
			const address = server.address();
			const port = typeof address === "object" && address ? address.port : 0;
			writeFileSync(join(dev3Home, "sockets", cliEndpointFileName(pid)), serializeCliEndpointRecord({
				v: CLI_ENDPOINT_VERSION,
				pid,
				host: CLI_LOOPBACK_HOST,
				port,
				token: TOKEN,
				hostTaskId,
				startedAt: "2026-08-22T10:00:00.000Z",
			}));
			done();
		});
	});
}

interface CliRun {
	reached: string | null;
	status: number | null;
	stderr: string;
}

/**
 * Run the real CLI and report which instance received the request.
 *
 * ASYNC on purpose: the stand-in instances listen on this process's event loop,
 * so a synchronous spawn would block the accept() and every request would time
 * out after 30s while looking exactly like a routing failure.
 */
async function runCli(args: string[], opts: { cwd?: string; env?: Record<string, string> } = {}): Promise<CliRun> {
	const before = Object.fromEntries(Object.entries(seen).map(([k, v]) => [k, v.length]));
	const run = await spawnCli("bun", [CLI_ENTRY, ...args], opts);
	const reached = Object.keys(seen).find((k) => seen[k].length > before[k]) ?? null;
	return { reached, status: run.status, stderr: run.stderr };
}

function spawnCli(
	command: string,
	args: string[],
	opts: { cwd?: string; env?: Record<string, string> } = {},
): Promise<{ status: number | null; stdout: string; stderr: string }> {
	return new Promise((done) => {
		const child = spawn(command, args, {
			cwd: opts.cwd ?? root,
			env: { ...process.env, HOME: root, DEV3_HOME: dev3Home, ...opts.env },
		});
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk) => { stdout += String(chunk); });
		child.stderr.on("data", (chunk) => { stderr += String(chunk); });
		child.on("close", (status) => done({ status, stdout, stderr }));
	});
}

beforeAll(async () => {
	root = mkdtempSync(join(process.env.DEV3_TEST_ROOT ?? tmpdir(), "dev3-instance-routing-"));
	dev3Home = join(root, ".dev3.0");
	mkdirSync(join(dev3Home, "sockets"), { recursive: true });
	mkdirSync(join(dev3Home, "data", PROJECT_SLUG), { recursive: true });
	worktreeA = join(dev3Home, "worktrees", PROJECT_SLUG, TASK_A.slice(0, 8), "worktree");
	mkdirSync(worktreeA, { recursive: true });

	writeFileSync(join(dev3Home, "projects.json"), JSON.stringify([
		{ id: PROJECT_ID, name: "test", path: PROJECT_PATH },
	]));
	writeFileSync(join(dev3Home, "data", PROJECT_SLUG, "tasks.json"), JSON.stringify([
		{ id: TASK_A, projectId: PROJECT_ID, seq: 1513, title: "task A", status: "in-progress" },
		{ id: TASK_B, projectId: PROJECT_ID, seq: 1630, title: "task B", status: "in-progress" },
	]));

	await startInstance("primary", process.pid, null);
	await startInstance("guestA", process.ppid, TASK_A);
}, 30_000);

afterAll(() => {
	for (const server of servers) server.close();
	rmSync(root, { recursive: true, force: true });
});

describe("which instance a real dev3 process reaches", () => {
	it("sanity: the fabricated home really holds two live instances", async () => {
		const out = await spawnCli("bun", [CLI_ENTRY, "doctor", "--json"]);
		expect(out.stdout).toContain(String(process.pid));
		expect(out.stdout).toContain(String(process.ppid));
	}, 60_000);

	// ── The human shell ──

	it("--instance task:<prefix> reaches that task's own dev-server", async () => {
		expect((await runCli(["ui", "state", "--instance", `task:${TASK_A.slice(0, 8)}`])).reached).toBe("guestA");
	});

	it("--instance seq:<N> reaches it too", async () => {
		expect((await runCli(["ui", "state", "--instance", "seq:1513"])).reached).toBe("guestA");
	});

	it("--instance self reaches it from inside the task worktree", async () => {
		expect((await runCli(["ui", "state", "--instance", "self"], { cwd: worktreeA })).reached).toBe("guestA");
	});

	it("--instance primary reaches the installed app even from that worktree", async () => {
		expect((await runCli(["ui", "state", "--instance", "primary"], { cwd: worktreeA })).reached).toBe("primary");
	});

	it("DEV3_CLI_SOCKET pins a whole shell without any flag", async () => {
		const endpoint = join(dev3Home, "sockets", cliEndpointFileName(process.ppid));
		expect((await runCli(["ui", "state"], { env: { DEV3_CLI_SOCKET: endpoint } })).reached).toBe("guestA");
	});

	it("the armed dev3-self shim reaches the task it was armed for", async () => {
		// Stand in for the packaged binary the Settings button links.
		const fakeBinary = join(root, "cli-under-test");
		writeFileSync(fakeBinary, `#!/bin/sh\nexec bun "${CLI_ENTRY}" "$@"\n`, { mode: 0o755 });
		const { path } = writeDev3SelfShim(dev3Home, fakeBinary, TASK_A);

		const before = seen.guestA.length;
		const out = await spawnCli(path, ["ui", "state"]);
		expect(out.stderr).not.toContain("Invalid --instance");
		expect(seen.guestA.length).toBeGreaterThan(before);
	}, 60_000);

	it("a selector nothing answers to fails loudly instead of falling back", async () => {
		const run = await runCli(["ui", "state", "--instance", "task:deadbeef"]);
		expect(run.reached).toBeNull();
		expect(run.status).toBe(16);
		expect(run.stderr).toContain("No running dev3 instance matches");
	});

	// ── The agent-hook path, which must not move ──

	it("no flag, inside the task worktree: still the primary", async () => {
		expect((await runCli(["ui", "state"], { cwd: worktreeA })).reached).toBe("primary");
	});

	it("DEV3_TASK_ID injected (every agent pane has it): still the primary", async () => {
		expect((await runCli(["ui", "state"], { cwd: worktreeA, env: { DEV3_TASK_ID: TASK_A } })).reached).toBe("primary");
	});

	it("the frozen bin/dev3 path an agent hook invokes: still the primary", async () => {
		// The hooks' own command string, run the way a hook runner runs it.
		mkdirSync(join(dev3Home, "bin"), { recursive: true });
		const cliCopy = join(dev3Home, "bin", "dev3");
		writeFileSync(cliCopy, `#!/bin/sh\nexec bun "${CLI_ENTRY}" "$@"\n`, { mode: 0o755 });

		const before = seen.primary.length;
		await spawnCli(cliCopy, ["ui", "state"], { cwd: worktreeA, env: { DEV3_TASK_ID: TASK_A } });
		expect(seen.primary.length).toBeGreaterThan(before);
	}, 60_000);
});
