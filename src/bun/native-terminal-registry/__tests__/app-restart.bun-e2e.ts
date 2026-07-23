#!/usr/bin/env bun
/**
 * App-restart reattach E2E for the persistent native-session registry (seq 1247),
 * on the REAL Bun runtime (vitest stubs the Bun global, so a live Bun.Terminal
 * cannot run there). Run: `bun run test:native-app-restart-e2e`.
 *
 * This owns the app-restart slice of HOST-006 / WIN-002 (seq 1141 tmux removal):
 * it proves a live native terminal session outlives FULL app-process turnover,
 * using TWO genuinely separate short-lived controller subprocesses — not one
 * long-lived driver that merely reconnects in-process:
 *
 *   • controller A starts a session, plants a unique shell-state marker, detaches,
 *     and EXITS without stopping the host;
 *   • the still-detached host survives A's exit;
 *   • controller B (a clean process with no shared handle) rediscovers the record
 *     from disk and reattaches to the SAME host PID, shell PID, session id, pane id,
 *     and preserved shell state;
 *   • the writer lease after restart is deterministic — B is the single writer, a
 *     concurrent client is a pure observer, and no duplicate input path or resize
 *     owner survives A's departure;
 *   • an explicit stop from a later app instance tears down ONLY the owned tree +
 *     registry state; an unrelated process and the tmux sentinel survive;
 *   • stale (dead / reused) and missing metadata each yield an honest lost-session
 *     result — the reattach path never silently spawns a replacement shell;
 *   • tmux is never invoked (PATH-shim sentinel stays absent).
 *
 * Scope: additive test-only proof. It changes no production behaviour, adds no
 * TerminalBackend / UI / RPC / settings, and never touches the tmux path.
 */

import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "../../spawn";
import { recordFile, sessionsRootDir } from "../paths";
import { isProcessAlive } from "../process-identity";
import { list } from "../registry";
import {
	NATIVE_SESSION_SCHEMA_VERSION,
	readRecord,
	writeRecordAtomic,
	writeToken,
	type NativeSessionRecord,
} from "../record";
import { defineShellLaunchSpec, encodeShellLaunchSpec, NATIVE_SESSION_LAUNCH_ENV } from "../shell-launch";

let failures = 0;
function check(condition: boolean, message: string): void {
	if (condition) console.log(`  ok   - ${message}`);
	else {
		failures++;
		console.error(`  FAIL - ${message}`);
	}
}

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const isWindows = process.platform === "win32";
const controllerEntry = fileURLToPath(new URL("./app-restart-controller.ts", import.meta.url));
const JSON_SENTINEL = "__APP_RESTART_JSON__";

interface ControllerResult {
	exitCode: number;
	verdict: Record<string, unknown> | null;
	stdout: string;
	stderr: string;
}

/** Run ONE disposable app-controller process and extract its single JSON verdict. */
function runController(phase: string, sessionId: string, nonce: string): ControllerResult {
	const proc = spawnSync([process.execPath, controllerEntry, phase, sessionId], {
		env: { ...process.env, DEV3_APP_RESTART_NONCE: nonce },
		stdout: "pipe",
		stderr: "pipe",
	});
	const stdout = new TextDecoder().decode(proc.stdout);
	const stderr = new TextDecoder().decode(proc.stderr);
	let verdict: Record<string, unknown> | null = null;
	for (const line of stdout.split("\n")) {
		if (line.startsWith(JSON_SENTINEL)) {
			verdict = JSON.parse(line.slice(JSON_SENTINEL.length)) as Record<string, unknown>;
			break;
		}
	}
	return { exitCode: proc.exitCode, verdict, stdout, stderr };
}

function num(verdict: Record<string, unknown> | null, key: string): number {
	const value = verdict?.[key];
	return typeof value === "number" ? value : Number.NaN;
}

function ghostRecord(sessionId: string, hostPid: number, shellPid: number): NativeSessionRecord {
	return {
		schemaVersion: NATIVE_SESSION_SCHEMA_VERSION,
		sessionId,
		paneId: `${sessionId}:0`,
		protocolVersion: 1,
		hostArtifactVersion: "1",
		runtimeVersion: Bun.version,
		platform: process.platform,
		host: { pid: hostPid, executable: process.execPath, startSignature: "ghost@never-matches" },
		shell: { pid: shellPid, command: ["ghost"], startSignature: "ghost@never-matches" },
		endpoint: { transport: "ws", address: "127.0.0.1", port: 1 },
		ownership: { evidenceKind: isWindows ? "windows-job" : "posix-start-signature" },
		cols: 80,
		rows: 24,
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
	};
}

function sessionDirCount(): number {
	try {
		return readdirSync(sessionsRootDir(), { withFileTypes: true }).filter((entry) => entry.isDirectory()).length;
	} catch {
		return 0;
	}
}

async function run(): Promise<void> {
	const root = mkdtempSync(join(tmpdir(), "dev3-native-app-restart-e2e-"));
	const metaDir = join(root, "native-sessions");
	const shimDir = join(root, "shim");
	const sentinel = join(root, "tmux-was-invoked");
	mkdirSync(shimDir, { recursive: true });
	mkdirSync(metaDir, { recursive: true });
	const shim = join(shimDir, isWindows ? "tmux.cmd" : "tmux");
	writeFileSync(
		shim,
		isWindows ? `@echo off\r\necho called>>"${sentinel}"\r\nexit /b 0\r\n` : `#!/bin/sh\necho called >> "${sentinel}"\nexit 0\n`,
	);
	if (!isWindows) chmodSync(shim, 0o755);

	process.env.DEV3_NATIVE_SESSIONS_DIR = metaDir;
	const launch = defineShellLaunchSpec({
		executable: isWindows ? "powershell.exe" : "/bin/bash",
		argv: isWindows ? ["-NoLogo", "-NoProfile", "-NoExit"] : ["--norc", "--noprofile"],
		cwd: root,
		env: {},
	});
	process.env[NATIVE_SESSION_LAUNCH_ENV] = encodeShellLaunchSpec(launch);
	process.env.PATH = `${shimDir}${delimiter}${process.env.PATH ?? ""}`;

	const sessionId = "app-restart";
	const nonce = `n${Date.now()}`;
	// An unrelated, pre-existing process the registry must never adopt or signal.
	const guardCommand = isWindows
		? ["powershell.exe", "-NoLogo", "-NoProfile", "-Command", "Start-Sleep -Seconds 300"]
		: ["sleep", "300"];
	const guard = spawn(guardCommand, { stdin: "ignore", stdout: "ignore", stderr: "ignore" });

	console.log(`  info - platform=${process.platform} bun=${Bun.version}`);
	if (isWindows) check(Bun.version === "1.3.14", "native Windows proof runs on Bun 1.3.14");

	try {
		// ── 1. controller A: start + mark + detach + EXIT (host must survive) ──
		const a = runController("start-mark", sessionId, nonce);
		if (a.stderr.trim()) console.log(`       [A stderr] ${a.stderr.trim().split("\n").slice(-3).join(" | ")}`);
		check(a.exitCode === 0 && a.verdict?.ok === true, "controller A started the session and planted its shell-state marker");
		const aHostPid = num(a.verdict, "hostPid");
		const aShellPid = num(a.verdict, "shellPid");
		const aControllerPid = num(a.verdict, "controllerPid");
		check(Number.isInteger(aHostPid) && aHostPid !== aControllerPid, "the host is a separate detached process, not controller A itself");

		const recordAfterA = readRecord(sessionId);
		check(recordAfterA !== null, "the session record persists on disk after controller A exits");
		check(isProcessAlive(aHostPid) && isProcessAlive(aShellPid), "host + shell stay ALIVE after controller A's process has exited");
		check(!isProcessAlive(aControllerPid), "controller A's process is genuinely gone (full app-process turnover)");
		check(isProcessAlive(guard.pid), "unrelated guard process is alive after controller A exits");

		// Let the OS finish tearing down A's socket so the host has cleared the writer.
		await delay(300);

		// ── 2. controller B (clean process): rediscover + reattach + prove identity/state ──
		const b = runController("reattach-verify", sessionId, nonce);
		if (b.stderr.trim()) console.log(`       [B stderr] ${b.stderr.trim().split("\n").slice(-3).join(" | ")}`);
		check(b.exitCode === 0 && b.verdict?.ok === true, "controller B reattached, proved single-writer determinism, and read preserved state");
		const bControllerPid = num(b.verdict, "controllerPid");
		check(bControllerPid !== aControllerPid, "controller B is a genuinely separate process from controller A");
		check(num(b.verdict, "hostPid") === aHostPid, "controller B reattached to the SAME host PID");
		check(num(b.verdict, "shellPid") === aShellPid, "controller B reattached to the SAME shell PID");
		check(b.verdict?.sessionId === sessionId && b.verdict?.sessionId === recordAfterA?.sessionId, "controller B reattached to the SAME session id");
		check(b.verdict?.paneId === `${sessionId}:0` && b.verdict?.paneId === recordAfterA?.paneId, "controller B reattached to the SAME pane id");
		check(b.verdict?.statePreserved === true, "controller B observed the preserved shell state (env var + root PID)");
		check(b.verdict?.roleAfterDiscover === "writer" && b.verdict?.writerAttached === true, "controller B is the single writer after restart (no stale writer lease survived)");
		check(b.verdict?.observerRole === "observer", "a concurrent second client after restart is a pure observer");
		check(b.verdict?.observerInputRejected === true, "no duplicate input path exists — observer input is refused");
		check(b.verdict?.observerResizeRejected === true && b.verdict?.writerControlsResize === true, "no duplicate resize owner exists — only the reattached writer resizes the PTY");
		check(isProcessAlive(aHostPid) && isProcessAlive(aShellPid), "host + shell survive controller B's disconnect too");

		// ── 3. explicit stop from a later app instance: only the owned tree dies ──
		const beforeStopGuardAlive = isProcessAlive(guard.pid);
		const c = runController("stop", sessionId, nonce);
		if (c.stderr.trim()) console.log(`       [stop stderr] ${c.stderr.trim().split("\n").slice(-3).join(" | ")}`);
		check(c.exitCode === 0 && c.verdict?.ok === true, "explicit stop from a later app instance succeeds");
		const stopDeadline = Date.now() + 4000;
		while (Date.now() < stopDeadline && (isProcessAlive(aHostPid) || isProcessAlive(aShellPid))) await delay(50);
		check(!isProcessAlive(aHostPid) && !isProcessAlive(aShellPid), "stop terminated exactly the owned host + shell tree");
		check(readRecord(sessionId) === null && !existsSync(recordFile(sessionId)), "stop removed the owned registry state");
		check(beforeStopGuardAlive && isProcessAlive(guard.pid), "stop left the unrelated guard process untouched");

		// ── 4. honest lost-session: missing metadata never spawns a replacement shell ──
		const dirsBeforeMissing = sessionDirCount();
		const missing = runController("reattach-lost", sessionId, nonce);
		check(missing.exitCode === 0 && missing.verdict?.ok === true, "reattach against MISSING metadata reports an honest lost session");
		check(missing.verdict?.discoverFailed === true && missing.verdict?.statusRunning === false, "missing-metadata reattach fails discovery and reports not-running");
		check(sessionDirCount() === dirsBeforeMissing && readRecord(sessionId) === null, "missing-metadata reattach spawned NO replacement shell or session state");

		// ── 5. honest lost-session: a stale DEAD record is passive; no shell is spawned ──
		const deadId = "app-restart-dead";
		writeRecordAtomic(ghostRecord(deadId, 2_000_000_000, 2_000_000_000));
		writeToken(deadId, "a".repeat(48));
		const dead = runController("reattach-lost", deadId, nonce);
		check(dead.exitCode === 0 && dead.verdict?.ok === true, "reattach against a stale DEAD record reports an honest lost session");
		check(dead.verdict?.verdict === "dead" && dead.verdict?.statusRunning === false, "the dead record is classified dead and not-running");
		check(readRecord(deadId) !== null && dead.verdict?.staleHostAlive === false, "the dead reattach neither spawned a shell nor revived the recorded host");

		// ── 6. honest lost-session: a REUSED PID (the live guard) is never adopted or signalled ──
		const reusedId = "app-restart-reused";
		writeRecordAtomic(ghostRecord(reusedId, guard.pid, guard.pid));
		writeToken(reusedId, "b".repeat(48));
		const reused = runController("reattach-lost", reusedId, nonce);
		check(reused.exitCode === 0 && reused.verdict?.ok === true, "reattach against a REUSED-PID record reports an honest lost session");
		check(reused.verdict?.verdict === "reused" && reused.verdict?.statusRunning === false, "the reused-PID record is classified reused and not-running");
		check(isProcessAlive(guard.pid), "the reused-PID reattach never adopted, killed, or replaced the unrelated guard process");

		const listing = await list();
		check(
			listing.every((s) => s.state !== "running") && !listing.some((s) => s.sessionId === sessionId),
			"no live native session remains after teardown and the lost-session probes",
		);

		// ── 7. the entire app-restart proof never invoked tmux ──
		check(!existsSync(sentinel), "the complete app-restart reattach proof NEVER invoked tmux (PATH shim sentinel absent)");
	} finally {
		try {
			runController("stop", sessionId, nonce);
		} catch {
			// best-effort
		}
		try {
			guard.kill();
		} catch {
			// already gone
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
