#!/usr/bin/env bun
/**
 * Graceful-teardown E2E for the native session host (seq 1387), on the REAL Bun
 * runtime — vitest stubs the Bun global, so a live `Bun.Terminal` cannot run
 * there. Run: `bun run test:native-teardown-e2e`.
 *
 * The close path used to cost ~1.7 s because the host signalled the shell with
 * SIGTERM, which an INTERACTIVE shell on a PTY ignores: the 1500 ms grace window
 * always expired and only the SIGKILL escalation ever retired the shell. The host
 * now sends SIGHUP — the hangup a PTY shell is built to honour — and keeps the
 * same bounded SIGKILL ladder behind it.
 *
 * Proves, against real hosts and real shells:
 *   • an idle PTY shell is retired well inside the budget, with record, token,
 *     host PID and shell PID all gone (no leak, no orphan);
 *   • a foreground child of that shell is reaped too — the pane leaves nothing
 *     running behind it;
 *   • a shell that traps BOTH SIGHUP and SIGTERM still stops, via the bounded
 *     SIGKILL fallback, and still leaves nothing alive. Graceful-first is
 *     preserved; force is still the floor, never the first move.
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "../../spawn";
import { recordFile, tokenFile } from "../paths";
import { isProcessAlive } from "../process-identity";
import { readRecord } from "../record";
import { start, stop } from "../registry";
import { defaultNativeShellLaunchSpec, defineShellLaunchSpec } from "../shell-launch";

/**
 * Budget for one graceful stop. Measured p95 on an idle macOS dev machine is
 * ~115 ms end-to-end (was ~1770 ms); 800 ms leaves generous headroom for a
 * loaded CI box while still failing loudly if the grace window comes back.
 */
const GRACEFUL_BUDGET_MS = 800;

/**
 * The trapped-signal case must fall back, so it legitimately pays the host's
 * 1500 ms grace window plus the SIGKILL settle. It must NOT exceed it.
 */
const FALLBACK_BUDGET_MS = 4000;

let failures = 0;
function check(condition: boolean, msg: string): void {
	if (condition) {
		console.log(`  ok   ${msg}`);
	} else {
		console.error(`  FAIL ${msg}`);
		failures++;
	}
}

/** Direct children of `pid`, as the OS reports them right now. */
function childPids(pid: number): number[] {
	const res = spawnSync(["ps", "-eo", "pid=,ppid="]);
	if (!res.success) return [];
	return new TextDecoder()
		.decode(res.stdout)
		.split("\n")
		.map((line) => line.trim().split(/\s+/).map(Number))
		.filter((pair) => pair.length === 2 && pair[1] === pid)
		.map((pair) => pair[0]!);
}

async function until<T>(probe: () => T | null, timeoutMs: number): Promise<T | null> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const value = probe();
		if (value !== null) return value;
		if (Date.now() >= deadline) return null;
		await new Promise((r) => setTimeout(r, 50));
	}
}

/** Every trace of a session, on disk and in the process table, is gone. */
function assertFullyReaped(label: string, sessionId: string, hostPid: number, shellPid: number): void {
	check(readRecord(sessionId) === null, `${label}: record is gone`);
	check(!existsSync(recordFile(sessionId)), `${label}: record file is gone`);
	check(!existsSync(tokenFile(sessionId)), `${label}: token file is gone`);
	check(!isProcessAlive(hostPid), `${label}: host process is gone`);
	check(!isProcessAlive(shellPid), `${label}: shell process is gone`);
}

async function run(): Promise<void> {
	if (process.platform === "win32") {
		console.log("SKIPPED: POSIX signal semantics — Windows tears down through the Job Object instead.");
		return;
	}

	const root = mkdtempSync(join(tmpdir(), "dev3-native-teardown-"));
	const work = join(root, "work");
	mkdirSync(work, { recursive: true });
	process.env.DEV3_NATIVE_SESSIONS_DIR = join(root, "sessions");
	process.env.DEV3_LOG_DIR = join(root, "logs");

	const defaults = defaultNativeShellLaunchSpec({ platform: process.platform, cwd: work, env: process.env });

	try {
		// ── 1. an idle interactive shell is retired inside the graceful budget ──
		console.log("\n1. idle PTY shell");
		const idle = await start("teardown-idle", { launch: defaults, cols: 100, rows: 30, timeoutMs: 15000 });
		const idleHost = idle.record.host.pid;
		const idleShell = idle.record.shell.pid;
		check(isProcessAlive(idleShell), "idle: shell is running before stop");

		let mark = performance.now();
		const idleStopped = await stop("teardown-idle", { timeoutMs: 8000 });
		const idleMs = performance.now() - mark;
		check(idleStopped, "idle: stop reports success");
		check(
			idleMs < GRACEFUL_BUDGET_MS,
			`idle: stop took ${Math.round(idleMs)} ms, under the ${GRACEFUL_BUDGET_MS} ms budget`,
		);
		assertFullyReaped("idle", "teardown-idle", idleHost, idleShell);

		// ── 2. a foreground child of the shell is reaped with it ──
		console.log("\n2. shell with a foreground child");
		const busy = await start("teardown-busy", { launch: defaults, cols: 100, rows: 30, timeoutMs: 15000 });
		const busyHost = busy.record.host.pid;
		const busyShell = busy.record.shell.pid;

		// Drive the real shell the way a user would, then wait for the child to appear.
		const { NativeSessionClient } = await import("../client");
		const client = new NativeSessionClient();
		const busyToken = (await import("../record")).readToken("teardown-busy")!;
		await client.connect(busy.record, busyToken, { timeoutMs: 5000 });
		client.input("sleep 300\r");
		const child = await until(() => childPids(busyShell)[0] ?? null, 8000);
		client.close();
		check(child !== null, "busy: the foreground child is running before stop");

		mark = performance.now();
		const busyStopped = await stop("teardown-busy", { timeoutMs: 8000 });
		const busyMs = performance.now() - mark;
		check(busyStopped, "busy: stop reports success");
		check(
			busyMs < GRACEFUL_BUDGET_MS,
			`busy: stop took ${Math.round(busyMs)} ms, under the ${GRACEFUL_BUDGET_MS} ms budget`,
		);
		assertFullyReaped("busy", "teardown-busy", busyHost, busyShell);
		if (child !== null) {
			// The shell HUPs its own jobs; give the kernel a beat to finish reaping.
			await until(() => (isProcessAlive(child) ? null : true), 2000);
			check(!isProcessAlive(child), "busy: the foreground child was reaped, not orphaned");
		}

		// ── 3. a shell that traps HUP *and* TERM still stops, via the bounded fallback ──
		console.log("\n3. shell that traps SIGHUP and SIGTERM");
		const stubborn = defineShellLaunchSpec({
			executable: "/bin/sh",
			argv: ["-c", 'trap "" HUP TERM; while :; do sleep 1; done'],
			cwd: work,
			env: {},
		});
		const trapped = await start("teardown-trapped", { launch: stubborn, cols: 100, rows: 30, timeoutMs: 15000 });
		const trappedHost = trapped.record.host.pid;
		const trappedShell = trapped.record.shell.pid;
		check(isProcessAlive(trappedShell), "trapped: shell is running before stop");

		mark = performance.now();
		const trappedStopped = await stop("teardown-trapped", { timeoutMs: 8000 });
		const trappedMs = performance.now() - mark;
		check(trappedStopped, "trapped: stop still reports success (SIGKILL fallback)");
		check(
			trappedMs < FALLBACK_BUDGET_MS,
			`trapped: stop took ${Math.round(trappedMs)} ms, inside the ${FALLBACK_BUDGET_MS} ms fallback bound`,
		);
		check(
			trappedMs > GRACEFUL_BUDGET_MS,
			"trapped: the graceful window was actually attempted first, not skipped",
		);
		assertFullyReaped("trapped", "teardown-trapped", trappedHost, trappedShell);
	} finally {
		for (const id of ["teardown-idle", "teardown-busy", "teardown-trapped"]) {
			try {
				await stop(id, { timeoutMs: 5000 });
			} catch {
				// best-effort
			}
		}
		try {
			rmSync(root, { recursive: true, force: true });
		} catch {
			// best-effort
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
	.catch((err) => {
		console.error("\nERROR:", err);
		process.exit(1);
	});
