#!/usr/bin/env bun
/**
 * PRODUCT end-to-end tracer for a dev3 task's PRIMARY terminal on the native
 * backend (seq 1292), on the REAL Bun runtime with a REAL host and shell (vitest
 * stubs the Bun global, so a live Bun.Terminal cannot run there).
 * Run: `bun run test:native-task-terminal-e2e`.
 *
 * Everything is driven through the PRODUCT surface of `native-task-terminal.ts`
 * — `startNativeTaskTerminal` / `attachNativeTaskTerminal` /
 * `nativeTaskTerminalAlive` / `stopNativeTaskTerminal` — not through registry
 * primitives, so the proof covers the path a task with
 * `terminalBackend: "native"` actually takes:
 *
 *   1. explicit create → exactly ONE native session; host pid ≠ shell pid, both alive;
 *   2. the agent/shell round-trip: input written through the terminal comes back on
 *      the onOutput byte stream;
 *   3. resize → the SHELL observes the new geometry (and the host persists it);
 *   4. detach → host + shell survive with the same PIDs, and it is not a death;
 *   5. app-controller restart → a SEPARATE short-lived process reattaches to the
 *      SAME host/shell and receives the replayed screen, with no second spawn;
 *   6. a second raw client is an OBSERVER — its input and resize are refused while
 *      the product writer keeps working;
 *   7. cleanup removes exactly the owned tree, and a pre-existing tmux sentinel
 *      session on a throwaway socket is still alive afterwards;
 *   8. after cleanup, reattach returns null and nothing respawns.
 *
 * Isolation: registry state, host images, and logs are redirected into a tmpdir
 * (DEV3_NATIVE_SESSIONS_DIR / DEV3_NATIVE_HOST_IMAGES_DIR / DEV3_LOG_DIR), so the
 * user's `~/.dev3.0/` is never touched. Test-only: no production file changes.
 */

import { mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "../spawn";
import {
	attachNativeTaskTerminal,
	nativeTaskTerminalAlive,
	startNativeTaskTerminal,
	stopNativeTaskTerminal,
	type NativeTaskTerminal,
} from "../native-task-terminal";
import { nativeTaskSessionId, type TerminalLaunchSpec } from "../task-terminal-backend";
import { NativeSessionClient } from "../native-terminal-registry/client";
import { readRecord } from "../native-terminal-registry/record";
import { sessionsRootDir } from "../native-terminal-registry/paths";
import { isProcessAlive } from "../native-terminal-registry/process-identity";
import { defaultNativeShellLaunchSpec } from "../native-terminal-registry/shell-launch";
import type { ErrorMessage } from "../native-terminal-registry/protocol";
import { sendUntilObserved, SHELL_WARMUP_PROBE } from "../native-terminal-registry/__tests__/command-roundtrip";
import { tmux } from "../tmux";

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
const lineEnd = isWindows ? "\r" : "\n";
const controllerEntry = fileURLToPath(new URL("./native-task-terminal-controller.ts", import.meta.url));
const JSON_SENTINEL = "__TASK_TERMINAL_JSON__";

// A fixed task id keeps the session id deterministic across runs, which is the
// property the reattach path depends on.
const TASK_ID = "00000000-0000-4000-8000-0000000e2e12";
const SESSION_ID = nativeTaskSessionId(TASK_ID);

interface Sink {
	text: () => string;
	waitFor: (needle: string, timeoutMs?: number) => Promise<boolean>;
}

function makeSink(): { sink: Sink; onOutput: (bytes: Uint8Array) => void } {
	let buf = "";
	const decoder = new TextDecoder();
	return {
		onOutput: (bytes) => {
			buf += decoder.decode(bytes, { stream: true });
		},
		sink: {
			text: () => buf,
			async waitFor(needle, timeoutMs = 5000) {
				const deadline = Date.now() + timeoutMs;
				while (Date.now() < deadline) {
					if (buf.includes(needle)) return true;
					await delay(30);
				}
				return false;
			},
		},
	};
}

/** The platform shell the registry itself picks, with rc files skipped for determinism. */
function taskLaunch(cwd: string): TerminalLaunchSpec {
	if (isWindows) {
		const spec = defaultNativeShellLaunchSpec({ platform: process.platform, cwd, env: process.env });
		return { executable: spec.executable, argv: spec.argv };
	}
	return { executable: "/bin/bash", argv: ["--norc", "--noprofile"] };
}

/** Plant a shell-state marker that also proves the interactive ROOT pid answered. */
function markerProbe(nonce: string, shellPid: number): { setup: string[]; command: string; expected: string } {
	if (isWindows) {
		return {
			setup: [`$env:DEV3_TASK_E2E_MARK='${nonce}'`],
			command: 'Write-Output "HELLO[$env:DEV3_TASK_E2E_MARK][$PID]"',
			expected: `HELLO[${nonce}][${shellPid}]`,
		};
	}
	return {
		setup: ["set +H", `export DEV3_TASK_E2E_MARK=${nonce}`],
		command: 'echo "HELLO[$DEV3_TASK_E2E_MARK][$$]"',
		expected: `HELLO[${nonce}][${shellPid}]`,
	};
}

/** Ask the SHELL itself what geometry it sees — the only honest resize evidence. */
function geometryProbe(cols: number, rows: number): { command: string; expected: string } {
	if (isWindows) {
		return {
			command: 'Write-Output "GEO[$($Host.UI.RawUI.WindowSize.Width)x$($Host.UI.RawUI.WindowSize.Height)]"',
			expected: `GEO[${cols}x${rows}]`,
		};
	}
	return { command: `echo "GEO[$(stty size | tr ' ' x)]"`, expected: `GEO[${rows}x${cols}]` };
}

function sessionDirCount(): number {
	try {
		return readdirSync(sessionsRootDir(), { withFileTypes: true }).filter((entry) => entry.isDirectory()).length;
	} catch {
		return 0;
	}
}

interface ControllerResult {
	exitCode: number;
	verdict: Record<string, unknown> | null;
	stderr: string;
}

/** Run ONE disposable app-controller process and extract its single JSON verdict. */
function runController(marker: string): ControllerResult {
	const proc = spawnSync([process.execPath, controllerEntry, TASK_ID], {
		env: { ...process.env, DEV3_NATIVE_TASK_E2E_MARKER: marker },
		stdout: "pipe",
		stderr: "pipe",
	});
	const stdout = new TextDecoder().decode(proc.stdout);
	let verdict: Record<string, unknown> | null = null;
	for (const line of stdout.split("\n")) {
		if (line.startsWith(JSON_SENTINEL)) {
			verdict = JSON.parse(line.slice(JSON_SENTINEL.length)) as Record<string, unknown>;
			break;
		}
	}
	return { exitCode: proc.exitCode, verdict, stderr: new TextDecoder().decode(proc.stderr) };
}

function num(verdict: Record<string, unknown> | null, key: string): number {
	const value = verdict?.[key];
	return typeof value === "number" ? value : Number.NaN;
}

async function run(): Promise<void> {
	const root = mkdtempSync(join(tmpdir(), "dev3-native-task-terminal-e2e-"));
	const metaDir = join(root, "native-sessions");
	const work = join(root, "work");
	mkdirSync(metaDir, { recursive: true });
	mkdirSync(work, { recursive: true });
	process.env.DEV3_NATIVE_SESSIONS_DIR = metaDir;
	process.env.DEV3_NATIVE_HOST_IMAGES_DIR = join(root, "host-images");
	process.env.DEV3_LOG_DIR = join(root, "logs");

	const nonce = `n${Date.now()}`;
	console.log(`  info - platform=${process.platform} bun=${Bun.version} session=${SESSION_ID}`);

	// A real tmux session on a throwaway socket: the native teardown must not touch it.
	const sentinelSocket = `dev3-native-task-e2e-${process.pid}`;
	const sentinelSession = "dev3-native-task-e2e-sentinel";
	let sentinelAlive = false;
	try {
		await tmux.newSessionDetached({
			sessionName: sentinelSession,
			cwd: work,
			socket: sentinelSocket,
			command: isWindows ? undefined : "sleep 600",
		});
		sentinelAlive = await tmux.hasSession(sentinelSession, { socket: sentinelSocket });
	} catch (err) {
		console.log(`  SKIP - tmux sentinel unavailable (${err instanceof Error ? err.message : String(err)})`);
	}
	if (sentinelAlive) console.log(`  info - tmux sentinel session live on socket ${sentinelSocket}`);

	let terminal: NativeTaskTerminal | null = null;
	try {
		// ── 1. explicit native create through the product path ──
		const first = makeSink();
		let closedEvents = 0;
		terminal = await startNativeTaskTerminal({
			taskId: TASK_ID,
			cwd: work,
			env: {},
			launch: taskLaunch(work),
			cols: 100,
			rows: 30,
			onOutput: first.onOutput,
			onClosed: () => {
				closedEvents++;
			},
		});
		const hostPid = terminal.hostPid;
		const shellPid = terminal.shellPid;
		check(terminal.sessionId === SESSION_ID, "the task's terminal addresses the deterministic native session id");
		check(sessionDirCount() === 1, "exactly ONE native session exists after the explicit create");
		check(await nativeTaskTerminalAlive(TASK_ID), "the product presence check reports the task terminal alive");
		check(hostPid > 0 && shellPid > 0 && hostPid !== shellPid, "host pid and shell pid are distinct");
		check(
			isProcessAlive(hostPid) && isProcessAlive(shellPid) && hostPid !== process.pid,
			"host + shell are alive and the host is a separate detached process",
		);

		// ── 2. the shell round-trip: input in, bytes out ──
		const marker = markerProbe(nonce, shellPid);
		for (const line of marker.setup) terminal.write(`${line}${lineEnd}`);
		const writerRef = terminal;
		const markerSeen = await sendUntilObserved({
			send: () => writerRef.write(`${marker.command}${lineEnd}`),
			observe: () => (first.sink.text().includes(marker.expected) ? marker.expected : null),
			...SHELL_WARMUP_PROBE,
		});
		check(markerSeen !== null, "a command written through the terminal produced its output on the onOutput stream");

		// ── 3. resize: the SHELL sees the new geometry, the host persists it ──
		const cols = 132;
		const rows = 43;
		terminal.resize(cols, rows);
		const geo = geometryProbe(cols, rows);
		const geoSeen = await sendUntilObserved({
			send: () => writerRef.write(`${geo.command}${lineEnd}`),
			observe: () => (first.sink.text().includes(geo.expected) ? geo.expected : null),
			...SHELL_WARMUP_PROBE,
		});
		check(geoSeen !== null, `the shell observed the resized geometry (${cols}x${rows})`);
		const resized = readRecord(SESSION_ID);
		check(resized?.cols === cols && resized?.rows === rows, "the host persisted the new geometry in the session record");

		// ── 4. detach: the app-side client goes, the terminal does not ──
		terminal.detach();
		terminal = null;
		await delay(400);
		check(closedEvents === 0, "an intentional detach is not reported as a terminal death");
		const afterDetach = readRecord(SESSION_ID);
		check(
			afterDetach?.host.pid === hostPid && afterDetach?.shell.pid === shellPid,
			"the session record still names the same host + shell after detach",
		);
		check(isProcessAlive(hostPid) && isProcessAlive(shellPid), "host + shell survive the app-side detach");
		check(await nativeTaskTerminalAlive(TASK_ID), "the task terminal is still present after detach");

		// ── 5. app-controller restart: a separate process reattaches, nothing respawns ──
		const restart = runController(marker.expected);
		if (restart.stderr.trim()) console.log(`       [controller stderr] ${restart.stderr.trim().split("\n").slice(-3).join(" | ")}`);
		check(restart.exitCode === 0 && restart.verdict?.ok === true, "a separate short-lived app controller reattached through the product path");
		const controllerPid = num(restart.verdict, "controllerPid");
		check(controllerPid !== process.pid && !isProcessAlive(controllerPid), "the reattaching controller was a genuinely separate, now-gone process");
		check(num(restart.verdict, "hostPid") === hostPid, "the restarted app reattached to the SAME host pid");
		check(num(restart.verdict, "shellPid") === shellPid, "the restarted app reattached to the SAME shell pid");
		check(restart.verdict?.sawReplayedMarker === true, "the restarted app received the replayed screen state");
		check(sessionDirCount() === 1 && num(restart.verdict, "dirsAfter") === 1, "the reattach spawned NO second host or session");

		// ── 6. one writer, everyone else observes ──
		await delay(500); // let the host clear the writer slot freed by the controller's exit
		const second = makeSink();
		terminal = await attachNativeTaskTerminal(TASK_ID, { onOutput: second.onOutput, onClosed: () => {} });
		check(terminal !== null, "the app reattached to the task terminal after the controller left");
		if (!terminal) throw new Error("reattach returned null while the session is alive");
		const writer = terminal;

		const observer = await NativeSessionClient.discover(SESSION_ID);
		const observerErrors: ErrorMessage[] = [];
		observer.onError((error) => observerErrors.push(error));
		const observerText = makeSink();
		observer.onOutput(observerText.onOutput);
		check(observer.getRole() === "observer", "a second raw client attaching to the same session is an observer");

		const before = await observer.status();
		const rejected = `OBSREJECT[${nonce}]`;
		observer.input(`${isWindows ? `Write-Output "${rejected}"` : `echo "${rejected}"`}${lineEnd}`);
		observer.resize(before.cols + 11, before.rows + 7);
		const barrier = `BARRIER[${nonce}]`;
		writer.write(`${isWindows ? `Write-Output "${barrier}"` : `echo "${barrier}"`}${lineEnd}`);
		const writerWorks = await second.sink.waitFor(barrier, 8000);
		await observerText.sink.waitFor(barrier, 4000);
		const after = await observer.status();
		check(writerWorks, "the product writer keeps working while an observer is attached");
		check(
			observerErrors.filter((e) => e.code === "conflict").length >= 2 && !second.sink.text().includes(rejected),
			"the observer's input and resize are both refused by the host",
		);
		check(after.cols === before.cols && after.rows === before.rows, "the observer's resize never changed the PTY geometry");
		observer.close();

		// ── 7. cleanup removes exactly the owned tree ──
		await stopNativeTaskTerminal(TASK_ID);
		terminal = null;
		const stopDeadline = Date.now() + 5000;
		while (Date.now() < stopDeadline && (isProcessAlive(hostPid) || isProcessAlive(shellPid))) await delay(50);
		check(!isProcessAlive(hostPid) && !isProcessAlive(shellPid), "cleanup terminated exactly the owned host + shell tree");
		check(readRecord(SESSION_ID) === null && sessionDirCount() === 0, "cleanup removed the owned registry state");
		if (sentinelAlive) {
			check(await tmux.hasSession(sentinelSession, { socket: sentinelSocket }), "the pre-existing tmux sentinel session is still alive after cleanup");
		} else {
			console.log("  SKIP - tmux sentinel check (tmux unavailable on this machine)");
		}

		// ── 8. after cleanup: honest null, and nothing respawns ──
		const gone = await attachNativeTaskTerminal(TASK_ID, { onOutput: () => {}, onClosed: () => {} });
		check(gone === null, "reattaching to a cleaned-up task terminal returns null");
		check(!(await nativeTaskTerminalAlive(TASK_ID)), "the product presence check reports the task terminal gone");
		const lost = runController(marker.expected);
		check(lost.exitCode === 0 && lost.verdict?.attached === false, "a fresh app controller also gets an honest lost session");
		check(sessionDirCount() === 0 && !isProcessAlive(hostPid) && !isProcessAlive(shellPid), "the lost reattach spawned NOTHING");
	} finally {
		try {
			terminal?.detach();
		} catch {
			// best-effort
		}
		try {
			await stopNativeTaskTerminal(TASK_ID);
		} catch {
			// best-effort
		}
		if (sentinelAlive) {
			try {
				await tmux.killSession(sentinelSession, { socket: sentinelSocket });
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
