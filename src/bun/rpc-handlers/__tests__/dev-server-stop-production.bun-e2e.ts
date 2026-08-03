#!/usr/bin/env bun
/**
 * The PRODUCTION dev-server stop path, end to end (seq 1407).
 *
 * The earlier matrix for this investigation drove the multipane coordinator directly,
 * which proved the pane layer and nothing above it. This drives the real
 * `runDevServer` and `stopDevServer` handlers, so everything a click actually touches
 * runs for real: the data layer reading real `projects.json` / `tasks.json`, the real
 * project config, `openAuxPane` / `closeAuxPane`, the native pane and its host
 * process, the launch-script wrapper, pool-port allocation, the process-tree
 * snapshot, verified reaping, and the wait for ports to be released. Nothing is
 * mocked — a temp `HOME` is the only isolation.
 *
 * The dev script deliberately leaves work behind that a naive teardown would miss:
 * it binds a pool port and spawns a background child that outlives the foreground
 * process. Both must be gone, and the port must be free, by the time `stopDevServer`
 * returns — "stop returned" has to mean "the next start can bind".
 *
 * A plain bun script rather than a vitest file on purpose: the native host is spawned
 * with `process.execPath`, which under vitest is node and cannot run the host
 * entrypoint at all, so the pane open would hang.
 *
 * What it asserts is the END STATE, not which mechanism produced it — and that is a
 * finding worth writing down: closing the pane and the explicit process-tree reap are
 * each INDEPENDENTLY sufficient here. Disabling either one alone leaves every check
 * green; only disabling BOTH turns the harness red (verified). So the teardown is
 * defence in depth, and no assertion below should be read as proof that one specific
 * mechanism ran.
 *
 * NOT covered, deliberately: the desktop Electrobun IPC transport (no real bridge
 * exists outside the app), and reaping an orphan discovered purely by port ownership
 * after being reparented out of the pane's process tree.
 *
 * Run: bun run test:dev-server-stop-e2e   [--cycles N]
 */

import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

let failures = 0;
function check(condition: boolean, message: string): void {
	if (condition) console.log(`  ok   - ${message}`);
	else {
		failures++;
		console.error(`  FAIL - ${message}`);
	}
}

const cycles = (() => {
	const flag = process.argv.indexOf("--cycles");
	const parsed = flag >= 0 ? Number(process.argv[flag + 1]) : NaN;
	return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 20;
})();

/** Generous: a real pane launch plus verified reaping plus port release. */
const STOP_BUDGET_MS = 20_000;
const START_BUDGET_MS = 60_000;

const root = mkdtempSync(join(tmpdir(), "dev3-stopprod-"));
const home = join(root, "home");
const projectPath = join(root, "project");
const worktree = join(root, "worktree");

const TASK_ID = "11111111-2222-3333-4444-555555555555";
const PROJECT_ID = "99999999-8888-7777-6666-555555555555";

function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

async function portHolders(port: number): Promise<string[]> {
	const { spawn } = await import("../../spawn");
	const proc = spawn(["lsof", `-ti:${port}`], { stdout: "pipe", stderr: "ignore" });
	const out = await new Response(proc.stdout).text();
	await proc.exited;
	return out.trim().split("\n").filter(Boolean);
}

/** Each teardown step gets its own deadline; a hang is a reported failure, not a stall. */
const TEARDOWN_BUDGET_MS = 15_000;

async function settleStep(label: string, work: Promise<unknown>): Promise<void> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timedOut = Symbol("timeout");
	try {
		const outcome = await Promise.race([
			work.then(() => null).catch((err) => err ?? new Error("unknown failure")),
			new Promise<typeof timedOut>((resolve) => {
				timer = setTimeout(() => resolve(timedOut), TEARDOWN_BUDGET_MS);
			}),
		]);
		if (outcome === timedOut) check(false, `${label} did not settle within ${TEARDOWN_BUDGET_MS} ms`);
		else if (outcome !== null) check(false, `${label} failed — ${String(outcome)}`);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

async function waitUntil(predicate: () => boolean | Promise<boolean>, budgetMs: number): Promise<boolean> {
	const deadline = Date.now() + budgetMs;
	for (;;) {
		if (await predicate()) return true;
		if (Date.now() >= deadline) return false;
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
}

/** PIDs the dev script recorded: its server, a plain child, and a detached one. */
function recordedPids(): { server: number; background: number; detached: number } | null {
	const file = join(worktree, "pids.txt");
	if (!existsSync(file)) return null;
	const [server, background, detached] = readFileSync(file, "utf8").trim().split(/\s+/).map(Number);
	return server && background && detached ? { server, background, detached } : null;
}

async function run(): Promise<void> {
	mkdirSync(home, { recursive: true });
	mkdirSync(join(worktree, ".dev3"), { recursive: true });
	mkdirSync(projectPath, { recursive: true });

	// A real project config, read by the real resolver.
	writeFileSync(
		join(worktree, ".dev3", "config.json"),
		JSON.stringify({
			devScript: [
				"sleep 600 &",
				"BG=$!",
				// A new session leader: closing the pane kills the pane's process GROUP,
				// which this child is no longer part of. Only the explicit process-tree
				// reap can end it, so it is what makes the reap assertion mean something.
				`python3 -c 'import os,time; os.setsid(); time.sleep(600)' &`,
				"DETACHED=$!",
				'python3 -m http.server "${DEV3_PORT0:?no pool port}" --bind 127.0.0.1 &',
				"SRV=$!",
				`printf '%s %s %s\\n' "$SRV" "$BG" "$DETACHED" > "$DEV3_WORKTREE_ROOT/pids.txt"`,
				"wait $SRV",
			].join("\n"),
			portCount: 1,
		}),
		"utf8",
	);

	// A temp HOME isolates every ~/.dev3.0 write: projects/tasks state, port-pool
	// assignments, the generated launch script, native session and multipane records.
	process.env.HOME = home;
	process.env.USERPROFILE = home;

	// tmux must never be reached by a native stop; a sentinel proves it.
	const shimDir = join(root, "shim");
	const sentinel = join(root, "tmux-was-invoked");
	mkdirSync(shimDir, { recursive: true });
	const shim = join(shimDir, "tmux");
	writeFileSync(shim, `#!/bin/sh\necho called >> "${sentinel}"\nexit 0\n`);
	chmodSync(shim, 0o755);
	process.env.PATH = `${shimDir}${delimiter}${process.env.PATH ?? ""}`;

	// Real data files, so data.getProject/getTask are the production ones.
	const { projectSlug } = await import("../../git");
	writeFileSync(
		join(home, ".dev3.0", "projects.json"),
		JSON.stringify([{ id: PROJECT_ID, name: "stop-e2e", path: projectPath, createdAt: 0 }]),
		"utf8",
	);
	const dataDir = join(home, ".dev3.0", "data", projectSlug(projectPath));
	mkdirSync(dataDir, { recursive: true });
	writeFileSync(
		join(dataDir, "tasks.json"),
		JSON.stringify([
			{
				id: TASK_ID,
				projectId: PROJECT_ID,
				title: "stop-path e2e",
				description: "",
				status: "in-progress",
				worktreePath: worktree,
				terminalBackend: "native",
				createdAt: 0,
				seq: 1,
			},
		]),
		"utf8",
	);

	const { runDevServer, stopDevServer } = await import("../tmux-pty");
	const portPool = await import("../../port-pool");
	const pty = await import("../../pty-server");

	// A dev-server pane is a SPLIT of the task's own terminal pane, so the terminal
	// has to exist first — exactly the precondition production has when the button is
	// clickable at all. Without it openAuxPane correctly refuses with
	// AuxPaneUnavailableError("terminal-not-running").
	// Ownership opens BEFORE anything that can spawn: the task's native host is
	// detached by design, so a factory that spawns and then throws would orphan a host
	// and a shell with no handle to reach them. Every pid we learn about goes into
	// `ownedPids` as soon as it is known, and the finally reaps whatever is in there —
	// plus an unconditional teardown addressed by task id, which needs no handle at all.
	const ownedPids = new Set<number>();
	const ownedPorts = new Set<number>();
	const stopDurations: number[] = [];
	try {
		await pty.createNativeTaskSession(TASK_ID, PROJECT_ID, worktree, {
			executable: "/bin/bash",
			argv: ["--norc", "--noprofile"],
		});
		const nativePanes = await import("../../native-task-panes");
		const agentPane = (await nativePanes.nativeTaskPanesState(TASK_ID))?.panes[0];
		if (!agentPane) throw new Error("the task's own native pane never came up");
		ownedPids.add(agentPane.hostPid);
		ownedPids.add(agentPane.shellPid);
		if (process.env.DEV3_STOP_E2E_INJECT === "after-session") {
			throw new Error("injected failure right after the native session came up");
		}
		for (let cycle = 1; cycle <= cycles; cycle++) {
			rmSync(join(worktree, "pids.txt"), { force: true });
			await runDevServer({ taskId: TASK_ID, projectId: PROJECT_ID, opId: `start${cycle}` });
			for (const allocated of portPool.getPortAssignments(TASK_ID)) ownedPorts.add(allocated);

			// Prove it is genuinely up first, or the stop assertions are vacuous.
			if (!(await waitUntil(() => recordedPids() !== null, START_BUDGET_MS))) {
				check(false, `cycle ${cycle}: the dev script never reported its pids`);
				break;
			}
			const pids = recordedPids()!;
			ownedPids.add(pids.server);
			ownedPids.add(pids.background);
			ownedPids.add(pids.detached);
			if (process.env.DEV3_STOP_E2E_INJECT === "after-start") {
				throw new Error("injected failure with the dev server up");
			}
			const port = portPool.getPortAssignments(TASK_ID)[0]!;
			if (!(await waitUntil(async () => (await portHolders(port)).length > 0, 15_000))) {
				check(false, `cycle ${cycle}: nothing ever bound pool port ${port}`);
				break;
			}

			const startedAt = performance.now();
			const status = await stopDevServer({ taskId: TASK_ID, projectId: PROJECT_ID, opId: `stop${cycle}` });
			const stopMs = performance.now() - startedAt;
			stopDurations.push(stopMs);

			const holdersAfter = await portHolders(port);
			check(status.running === false, `cycle ${cycle}: status reports stopped`);
			check(!alive(pids.server), `cycle ${cycle}: the dev-server process is gone`);
			check(!alive(pids.background), `cycle ${cycle}: the background child is gone`);
			check(
				!alive(pids.detached),
				`cycle ${cycle}: the DETACHED child (own session, survives the pane's group kill) is reaped`,
			);
			check(holdersAfter.length === 0, `cycle ${cycle}: pool port ${port} is free when stop returns`);
			check(stopMs < STOP_BUDGET_MS, `cycle ${cycle}: stop took ${Math.round(stopMs)} ms`);
			if (failures > 0) break;
		}

		if (stopDurations.length > 0) {
			console.log(`\n  ${stopDurations.length}/${cycles} cycles · worst stop ${Math.round(Math.max(...stopDurations))} ms`);
		}
		check(stopDurations.length === cycles, `all ${cycles} cycles completed`);

		const again = await stopDevServer({ taskId: TASK_ID, projectId: PROJECT_ID, opId: "again" });
		check(again.running === false, "stopping an already-stopped dev server is idempotent");
		check(!existsSync(sentinel), "the whole native start/stop path NEVER invokes tmux");
	} finally {
		// Every step below runs on EVERY path and has its OWN deadline: a teardown that
		// never resolves must not be able to hang the harness and skip the fallbacks
		// behind it. A step that fails or times out is reported, never swallowed.
		await settleStep("final stopDevServer", stopDevServer({ taskId: TASK_ID, projectId: PROJECT_ID }));
		// Addressed by task id, so it needs no handle — this is what covers a factory
		// that spawned and then threw before returning one.
		await settleStep("destroyNativeTaskSession", pty.destroyNativeTaskSession(TASK_ID));
		await settleStep("stopNativeTaskPanes", (await import("../../native-task-panes")).stopNativeTaskPanes(TASK_ID));

		const survivors = () => [...ownedPids].filter((pid) => alive(pid));
		const reapedOnItsOwn = await waitUntil(() => survivors().length === 0, TEARDOWN_BUDGET_MS);
		for (const pid of survivors()) {
			try {
				process.kill(pid, "SIGKILL");
			} catch {
				/* already gone */
			}
		}
		// Re-probe AFTER the force-kill and BEFORE deleting records: SIGKILL is not
		// instantaneous, and "a signal was sent" is not evidence.
		const goneAfterKill = await waitUntil(() => survivors().length === 0, TEARDOWN_BUDGET_MS);
		check(reapedOnItsOwn, "teardown reaped every owned pid without a force-kill");
		check(goneAfterKill, `no owned pid survives even the force-kill — alive: ${survivors()}`);
		for (const port of ownedPorts) {
			const freed = await waitUntil(async () => (await portHolders(port)).length === 0, TEARDOWN_BUDGET_MS);
			check(freed, `pool port ${port} is free after teardown`);
		}
		try {
			rmSync(root, { recursive: true, force: true });
		} catch (err) {
			check(false, `removing temp state threw — ${String(err)}`);
		}
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
