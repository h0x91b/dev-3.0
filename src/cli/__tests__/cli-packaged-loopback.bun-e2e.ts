#!/usr/bin/env bun
/**
 * Packaged-executable proof for the Windows CLI control channel (seq 1296).
 *
 * The other suites drive the client as a library. This one compiles the CLI the
 * way the app ships it (`bun build --compile`, the same command as `build:cli`)
 * and runs THAT binary as a child process against real loopback listeners in a
 * temp dev3 state directory. It therefore exercises argv parsing, endpoint
 * discovery from the state dir, instance selection, the loopback carrier,
 * printed output, and the public exit codes — end to end, through the artifact
 * the user actually runs.
 *
 * On the Windows CI runner the compiled artifact is `dev3.exe`, which makes this
 * the automated half of "the packaged Windows CLI talks to the app": the record
 * is published here by the same production code path the desktop app uses.
 *
 * The child runs with cwd set to the temp state root on purpose — inside this
 * repo's own worktree the CLI would resolve context by path and dial the real
 * running app instead of the test instance.
 *
 * Run: bun run test:cli-packaged-e2e
 */

import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startCliListener, type CliListener } from "../../bun/cli-listener";
import {
	cliEndpointFileName,
	parseCliEndpointRecord,
	serializeCliEndpointRecord,
} from "../../shared/cli-endpoint";
import { CLI_EXIT_CODE_APP_NOT_RUNNING } from "../../shared/cli-exit-codes";
import type { CliRequest, CliResponse } from "../../shared/types";

let failures = 0;
function check(condition: boolean, message: string): void {
	if (condition) console.log(`  ok   - ${message}`);
	else {
		failures++;
		console.error(`  FAIL - ${message}`);
	}
}

const TASK_ID = "aabbccdd-1111-2222-3333-444444444444";
const PROJECT_ID = "11112222-3333-4444-5555-666666666666";
const PROJECT_PATH = "/dev3-e2e/fake-repo";
const PROJECT_SLUG = PROJECT_PATH.replace(/^\//, "").replaceAll("/", "-");

const task = {
	id: TASK_ID,
	projectId: PROJECT_ID,
	seq: 1296,
	title: "Connect the Windows CLI to the desktop app",
	description: "packaged CLI over loopback",
	status: "in-progress",
	priority: "P3",
	createdAt: 1,
	updatedAt: 2,
	labelIds: [] as string[],
	overview: "Loopback transport",
};

interface Instance { listener: CliListener; received: CliRequest[]; token: string }

const instances: Instance[] = [];

/** A stand-in app on the real loopback carrier, recording what it receives. */
function startApp(socketsDir: string, pid: number, hostTaskId: string | null = null): Instance {
	const received: CliRequest[] = [];
	const listener = startCliListener({
		socketsDir,
		pid,
		hostTaskId,
		transport: "tcp",
		handle: async (req: CliRequest): Promise<CliResponse> => {
			received.push(req);
			return reply(req, pid);
		},
	});
	const record = parseCliEndpointRecord(readFileSync(listener.endpoint, "utf-8"));
	if (!record) throw new Error(`endpoint record did not parse: ${listener.endpoint}`);
	const instance: Instance = { listener, received, token: record.token };
	instances.push(instance);
	return instance;
}

function reply(req: CliRequest, pid: number): CliResponse {
	const served = { ...task, description: `served by pid ${pid}` };
	switch (req.method) {
		case "task.show":
			return { id: req.id, ok: true, data: served };
		case "task.update":
			return { id: req.id, ok: true, data: { task: { ...served, title: String(req.params.title ?? served.title) }, titlePreserved: false } };
		case "note.add":
			return { id: req.id, ok: true, data: { ...served, notes: [{ id: "note-1234abcd", content: String(req.params.content), source: "ai", createdAt: 3 }] } };
		case "overview.set":
			return { id: req.id, ok: true, data: { ...served, overview: String(req.params.overview) } };
		case "ui.state":
			return { id: req.id, ok: true, data: { appRunning: true, foreground: true, userIdleSeconds: pid, activeProjectId: PROJECT_ID, activeTaskId: TASK_ID } };
		default:
			return { id: req.id, ok: false, error: `Unknown method: ${req.method}` };
	}
}

interface RunResult { code: number; stdout: string; stderr: string }

async function runCli(exe: string, home: string, args: string[]): Promise<RunResult> {
	const proc = Bun.spawn([exe, ...args], {
		cwd: home,
		env: { ...process.env, HOME: home, USERPROFILE: home, DEV3_TASK_ID: TASK_ID },
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, code] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	return { code, stdout, stderr };
}

/** Compile the CLI exactly as `build:cli` does, into the temp root. */
async function buildCli(root: string): Promise<string> {
	// These sources are gitignored, so a fresh clone has none and the compile
	// fails on their imports. Generate a missing one the same way the real build
	// does, and leave an existing one untouched.
	const generated = [
		{ file: "src/shared/build-info.generated.ts", script: "scripts/generate-build-info.ts" },
		{ file: "src/bun/changelog-bundled.ts", script: "scripts/generate-changelog.ts" },
	];
	for (const { file, script } of generated) {
		if (existsSync(file)) continue;
		const gen = Bun.spawn(["bun", script], { stdout: "pipe", stderr: "pipe" });
		const [genErr, genCode] = await Promise.all([new Response(gen.stderr).text(), gen.exited]);
		if (genCode !== 0) throw new Error(`${script} failed (${genCode}):\n${genErr}`);
	}

	const outfile = join(root, "dev3");
	const proc = Bun.spawn(["bun", "build", "src/cli/main.ts", "--compile", "--outfile", outfile], {
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stderr, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
	if (code !== 0) throw new Error(`bun build --compile failed (${code}):\n${stderr}`);
	// Bun appends .exe on Windows.
	for (const candidate of [outfile, `${outfile}.exe`]) if (existsSync(candidate)) return candidate;
	throw new Error(`compiled CLI not found at ${outfile}[.exe]`);
}

async function run(): Promise<void> {
	const root = mkdtempSync(join(tmpdir(), "dev3-cli-packaged-"));
	try {
		console.log("build the CLI the way the app ships it");
		const exe = await buildCli(root);
		check(existsSync(exe), `compiled the CLI to ${exe.slice(root.length + 1)}`);

		// A temp dev3 state directory: enough for the CLI's offline ID resolution.
		const home = join(root, "home");
		const dev3Home = join(home, ".dev3.0");
		const socketsDir = join(dev3Home, "sockets");
		mkdirSync(socketsDir, { recursive: true });
		mkdirSync(join(dev3Home, "data", PROJECT_SLUG), { recursive: true });
		writeFileSync(join(dev3Home, "projects.json"), JSON.stringify([{ id: PROJECT_ID, name: "fake-repo", path: PROJECT_PATH }]));
		writeFileSync(join(dev3Home, "data", PROJECT_SLUG, "tasks.json"), JSON.stringify([task]));

		console.log("\nrepresentative commands through the packaged executable");
		// Two coexisting instances. The guest is published LAST (newest mtime), so
		// only correct instance selection still routes to the primary.
		const primary = startApp(socketsDir, process.pid);
		const guest = startApp(socketsDir, process.ppid, "99999999-1111-2222-3333-444444444444");
		check(guest.token !== primary.token, "the two instances published distinct tokens");

		const current = await runCli(exe, home, ["current"]);
		check(current.code === 0, `\`dev3 current\` exits 0 (got ${current.code}${current.code ? `, stderr: ${current.stderr.trim()}` : ""})`);
		check(current.stdout.includes("1296"), "`dev3 current` prints the seq");
		check(current.stdout.includes(`served by pid ${process.pid}`), "`dev3 current` shows data served by the PRIMARY instance");
		check(primary.received.length > 0, "the primary instance received the request");
		check(guest.received.length === 0, "the guest instance was not addressed");
		check(primary.received.every((req) => req.token === primary.token),
			"every request from the packaged CLI carried the primary instance's token");

		primary.received.length = 0;
		const show = await runCli(exe, home, ["task", "show"]);
		check(show.code === 0 && show.stdout.includes("Connect the Windows CLI"), "`dev3 task show` round-trips");
		check(primary.received[0]?.method === "task.show", "`dev3 task show` issues task.show over the carrier");

		primary.received.length = 0;
		const update = await runCli(exe, home, ["task", "update", "--title", "Renamed by the packaged CLI"]);
		check(update.code === 0, `\`dev3 task update\` exits 0 (got ${update.code}${update.code ? `, stderr: ${update.stderr.trim()}` : ""})`);
		check(primary.received[0]?.method === "task.update" && primary.received[0]?.params.title === "Renamed by the packaged CLI",
			"`dev3 task update` delivers the mutation");

		primary.received.length = 0;
		const note = await runCli(exe, home, ["note", "add", "packaged loopback works"]);
		check(note.code === 0, `\`dev3 note add\` exits 0 (got ${note.code}${note.code ? `, stderr: ${note.stderr.trim()}` : ""})`);
		check(primary.received[0]?.method === "note.add" && primary.received[0]?.params.content === "packaged loopback works",
			"`dev3 note add` delivers the note content");

		primary.received.length = 0;
		const overview = await runCli(exe, home, ["overview", "set", "packaged overview"]);
		check(overview.code === 0, `\`dev3 overview set\` exits 0 (got ${overview.code}${overview.code ? `, stderr: ${overview.stderr.trim()}` : ""})`);
		check(primary.received[0]?.method === "overview.set" && primary.received[0]?.params.overview === "packaged overview",
			"`dev3 overview set` delivers the overview");

		primary.received.length = 0;
		const ui = await runCli(exe, home, ["ui", "state", "--json"]);
		check(ui.code === 0, `\`dev3 ui state\` exits 0 (got ${ui.code}${ui.code ? `, stderr: ${ui.stderr.trim()}` : ""})`);
		check(primary.received[0]?.method === "ui.state", "the app-directed diagnostic reaches the app");
		check(JSON.parse(ui.stdout || "{}").userIdleSeconds === process.pid, "the diagnostic answer came from the primary instance");

		console.log("\nsocket diagnostics never leak the token");
		const diagnostics = await runCli(exe, home, ["doctor"]);
		const diagText = diagnostics.stdout + diagnostics.stderr;
		check(!diagText.includes(primary.token) && !diagText.includes(guest.token), "`dev3 doctor` output contains no endpoint token");

		console.log("\nstale endpoint record");
		guest.listener.stop();
		unlinkSync(guest.listener.endpoint);
		// A record for a LIVE pid whose token the primary rejects: it must neither
		// misroute the command nor break discovery of the healthy instance.
		const stalePid = process.ppid;
		writeFileSync(join(socketsDir, cliEndpointFileName(stalePid)),
			serializeCliEndpointRecord({
				v: 1, pid: stalePid, host: "127.0.0.1", port: primary.listener.port as number,
				token: "d".repeat(64), hostTaskId: null, startedAt: "2026-07-25T10:00:00.000Z",
			}));
		primary.received.length = 0;
		const stale = await runCli(exe, home, ["ui", "state", "--json"]);
		check(stale.code === 0 || stale.code === CLI_EXIT_CODE_APP_NOT_RUNNING,
			`a stale record yields either the primary's answer (0) or the documented ${CLI_EXIT_CODE_APP_NOT_RUNNING} (got ${stale.code})`);
		check(!/Unhandled|stack|TypeError/i.test(stale.stderr), "a stale record never produces a raw crash");
		unlinkSync(join(socketsDir, cliEndpointFileName(stalePid)));

		console.log("\ncorrupt record does not block a healthy instance");
		const corrupt = join(socketsDir, cliEndpointFileName(stalePid));
		writeFileSync(corrupt, "{ truncated");
		primary.received.length = 0;
		const withCorrupt = await runCli(exe, home, ["ui", "state", "--json"]);
		check(withCorrupt.code === 0 && primary.received[0]?.method === "ui.state",
			`a corrupt record is skipped and the live instance still answers (exit ${withCorrupt.code})`);
		unlinkSync(corrupt);

		console.log("\napp not running");
		primary.listener.stop();
		unlinkSync(primary.listener.endpoint);
		const down = await runCli(exe, home, ["ui", "state"]);
		check(down.code === CLI_EXIT_CODE_APP_NOT_RUNNING,
			`with no app the packaged CLI exits ${CLI_EXIT_CODE_APP_NOT_RUNNING} (got ${down.code})`);
		check(/not running|cannot reach/i.test(down.stdout + down.stderr), "the app-not-running output is actionable");

		console.log("\na record pointing at a dead port");
		writeFileSync(join(socketsDir, cliEndpointFileName(process.pid)),
			serializeCliEndpointRecord({
				v: 1, pid: process.pid, host: "127.0.0.1", port: 1,
				token: "e".repeat(64), hostTaskId: null, startedAt: "2026-07-25T10:00:00.000Z",
			}));
		const deadPort = await runCli(exe, home, ["ui", "state"]);
		check(deadPort.code === CLI_EXIT_CODE_APP_NOT_RUNNING,
			`a record pointing at a dead port exits ${CLI_EXIT_CODE_APP_NOT_RUNNING} (got ${deadPort.code})`);
	} finally {
		for (const instance of instances) {
			try { instance.listener.stop(); } catch { /* already stopped */ }
		}
		rmSync(root, { recursive: true, force: true });
	}
}

run()
	.then(() => {
		if (failures > 0) {
			console.error(`\n${failures} check(s) FAILED`);
			process.exit(1);
		}
		console.log("\nALL CHECKS PASSED");
		process.exit(0);
	})
	.catch((error) => {
		console.error("\nERROR:", error);
		process.exit(1);
	});
