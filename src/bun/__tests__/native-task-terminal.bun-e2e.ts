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
 *   8. after cleanup, reattach returns null and nothing respawns;
 *   9. the RENDERER transport: a SECOND task driven exactly as `TerminalView.tsx`
 *      drives it — `pty.createNativeTaskSession` plus real WebSocket clients on the
 *      pty-server bridge — proving native bytes reach a renderer socket under the
 *      writer/observer contract (seq 1300): the second renderer attaches as a
 *      replayed OBSERVER whose input is refused, an explicit `claim` moves the lease
 *      atomically, the new writer reaches the SAME shell while both viewers receive
 *      its output, geometry follows the WRITER only, a reconnect resumes at its
 *      watermark, and `destroySessionAwaited` kills the tree;
 *  11. CROSS-INSTANCE `Take control`: a SECOND real app process attaches
 *      to the SAME host as an observer and clicks Take control through the product
 *      frame — the lease transfers, the first process is demoted authoritatively by
 *      the host, the peer's input reaches the same shell EXACTLY once, PTY geometry
 *      follows the new writer, host/shell pids never change, and the lease comes
 *      back to the first process once the peer lets go;
 *  10. LIFECYCLE teardown (seq 1298): `pty.destroyNativeTaskSession` on a task with
 *      NO in-memory session (the app-restart shape) resolves only after its host,
 *      shell and NESTED CHILD are gone, leaves a sibling native session and the tmux
 *      sentinel alive, and repeats idempotently.
 *
 * Isolation: registry state, host images, and logs are redirected into a tmpdir
 * (DEV3_NATIVE_SESSIONS_DIR / DEV3_NATIVE_HOST_IMAGES_DIR / DEV3_LOG_DIR), so the
 * user's `~/.dev3.0/` is never touched. Test-only: no production file changes.
 *
 * `pty-server` owns a Bun.serve listener and an idle-detection interval, so this
 * script always ends in an explicit process.exit — after every check and the
 * tmpdir removal, non-zero when any check failed.
 */

import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "../spawn";
import { bindNativeTaskPane, type NativeTaskTerminal } from "../native-task-terminal";
import {
	startNativeTaskPanes,
	recoverNativeTaskPanes,
	nativeTaskPanesAlive,
	stopNativeTaskPanes,
} from "../native-task-panes";
import { NATIVE_MULTIPANE_DIR_ENV } from "../native-terminal-multipane/paths";
import { nativeTaskSessionId, type TerminalLaunchSpec } from "../task-terminal-backend";
import { encodeResizeSequence } from "../../shared/resize-protocol";
import {
	claimMessage,
	decodeNativeStreamMessage,
	ptyUrlWithSince,
	type NativeStreamAttachHeader,
	type NativeStreamHeader,
	type NativeStreamRole,
} from "../../shared/native-terminal-stream";
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
const takeoverPeerEntry = fileURLToPath(new URL("./native-takeover-peer.ts", import.meta.url));
const JSON_SENTINEL = "__TASK_TERMINAL_JSON__";
const TAKEOVER_SENTINEL = "__NATIVE_TAKEOVER_JSON__";

// A fixed task id keeps the session id deterministic across runs, which is the
// property the reattach path depends on.
const TASK_ID = "00000000-0000-4000-8000-0000000e2e12";
const SESSION_ID = nativeTaskSessionId(TASK_ID);       // coordinator id
const FIRST_PANE_SESSION_ID = `${SESSION_ID}-pane-1`;  // registry session id for pane-1
// The renderer-transport section owns its OWN task so the two halves stay independent.
const WS_TASK_ID = "00000000-0000-4000-8000-0000000e2e34";
const WS_SESSION_ID = nativeTaskSessionId(WS_TASK_ID);
const WS_FIRST_PANE_SESSION_ID = `${WS_SESSION_ID}-pane-1`;
// The lifecycle-teardown section: one task torn down with no in-memory pty-server
// session (the app-restart shape) plus a sibling that must survive it untouched.
const LC_TASK_ID = "00000000-0000-4000-8000-0000000e2e56";
const LC_SESSION_ID = nativeTaskSessionId(LC_TASK_ID);
const LC_FIRST_PANE_SESSION_ID = `${LC_SESSION_ID}-pane-1`;
const SIB_TASK_ID = "00000000-0000-4000-8000-0000000e2e78";
const SIB_SESSION_ID = nativeTaskSessionId(SIB_TASK_ID);
const SIB_FIRST_PANE_SESSION_ID = `${SIB_SESSION_ID}-pane-1`;
// The cross-instance Take-control section: ONE host, two real app processes.
const XP_TASK_ID = "00000000-0000-4000-8000-0000000e2e9a";
const XP_SESSION_ID = nativeTaskSessionId(XP_TASK_ID);
const XP_FIRST_PANE_SESSION_ID = `${XP_SESSION_ID}-pane-1`;

interface Sink {
	text: () => string;
	waitFor: (needle: string, timeoutMs?: number) => Promise<boolean>;
}

function makeSink(): { sink: Sink; onOutput: (bytes: Uint8Array) => void; push: (text: string) => void } {
	let buf = "";
	const decoder = new TextDecoder();
	return {
		onOutput: (bytes) => {
			buf += decoder.decode(bytes, { stream: true });
		},
		push: (text) => {
			buf += text;
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
	// `-i` keeps COLUMNS/LINES maintained by the shell, which the renderer-transport
	// geometry probe reads.
	return { executable: "/bin/bash", argv: ["--norc", "--noprofile", "-i"] };
}

/**
 * One renderer: a raw WebSocket on the pty-server bridge, exactly like
 * TerminalView. A native session frames every message with the in-band APC
 * header (seq 1300), so this client decodes the frames: `sink` holds the raw
 * terminal payload only, while the headers drive the role/resume assertions.
 */
interface RendererClient {
	sink: Sink;
	/** The first frame of the attach, which must precede any live output. */
	attach: () => NativeStreamAttachHeader | null;
	/** Watermark of the last applied frame — what a reconnect resumes from. */
	lastSeq: () => number;
	role: () => NativeStreamRole;
	/** How many times the server told this client its input was refused. */
	refusals: () => number;
	/** Messages that were NOT native-stream frames; must stay 0 on a native session. */
	unframed: () => number;
	awaitHeader: (predicate: (header: NativeStreamHeader) => boolean, timeoutMs?: number) => Promise<boolean>;
	send: (data: string) => void;
	close: () => void;
}

async function openRenderer(port: number, taskId: string, since: number | null = null): Promise<RendererClient> {
	const url = ptyUrlWithSince(`ws://localhost:${port}?session=${encodeURIComponent(taskId)}`, since);
	const ws = new WebSocket(url);
	const { sink, push } = makeSink();
	const headers: NativeStreamHeader[] = [];
	let attach: NativeStreamAttachHeader | null = null;
	let seq = 0;
	let role: NativeStreamRole = "observer";
	let refusals = 0;
	let unframed = 0;
	ws.addEventListener("message", (ev) => {
		const data = (ev as MessageEvent).data;
		const text = typeof data === "string" ? data : new TextDecoder().decode(data as ArrayBuffer);
		const frame = decodeNativeStreamMessage(text);
		if (!frame) {
			unframed++;
			push(text);
			return;
		}
		headers.push(frame.header);
		switch (frame.header.t) {
			case "attach":
				attach = frame.header;
				seq = frame.header.seq;
				role = frame.header.role;
				break;
			case "o":
				seq = frame.header.seq;
				break;
			case "role":
				role = frame.header.role;
				if (frame.header.refused) refusals++;
				break;
		}
		if (frame.payload) push(frame.payload);
	});
	await new Promise<void>((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error("renderer websocket open timeout")), 5000);
		ws.addEventListener("open", () => {
			clearTimeout(timer);
			resolve();
		}, { once: true });
		ws.addEventListener("error", () => {
			clearTimeout(timer);
			reject(new Error("renderer websocket error"));
		}, { once: true });
	});
	const client: RendererClient = {
		sink,
		attach: () => attach,
		lastSeq: () => seq,
		role: () => role,
		refusals: () => refusals,
		unframed: () => unframed,
		async awaitHeader(predicate, timeoutMs = 5000) {
			const deadline = Date.now() + timeoutMs;
			while (Date.now() < deadline) {
				if (headers.some(predicate)) return true;
				await delay(20);
			}
			return false;
		},
		send: (data) => ws.send(data),
		close: () => ws.close(),
	};
	// The attach frame carries the role and the replayed screen; every later
	// assertion reads it, so a renderer is not "open" until it has landed.
	await client.awaitHeader((header) => header.t === "attach");
	return client;
}

/** Geometry as the SHELL reports it to a renderer — the coordinator's $COLUMNS/$LINES form. */
function rendererGeometryProbe(cols: number, rows: number): { command: string; expected: string } {
	if (isWindows) {
		return {
			command: 'Write-Output "GEOM-$($Host.UI.RawUI.WindowSize.Width)-$($Host.UI.RawUI.WindowSize.Height)"',
			expected: `GEOM-${cols}-${rows}`,
		};
	}
	return { command: "echo GEOM-$COLUMNS-$LINES", expected: `GEOM-${cols}-${rows}` };
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

/**
 * Start a long-lived NESTED child inside the shell and report its pid through a
 * FILE, not the byte stream — the pid must be readable even if an interactive
 * shell mangles or delays the echo.
 */
function nestedChildProbe(pidFile: string): { command: string; read: () => number } {
	const read = (): number => {
		try {
			// Digits only: PowerShell's Set-Content encoding (BOM, UTF-16, CRLF) varies
			// by host version and must not decide whether this probe works.
			const digits = /(\d+)/.exec(readFileSync(pidFile, "utf8").replace(/\0/g, ""));
			const pid = digits ? Number(digits[1]) : Number.NaN;
			return Number.isInteger(pid) && pid > 0 ? pid : Number.NaN;
		} catch {
			return Number.NaN;
		}
	};
	if (isWindows) {
		return {
			command: `$c = Start-Process powershell -ArgumentList '-NoProfile','-Command','Start-Sleep 600' -PassThru; Set-Content -Path '${pidFile}' -Value $c.Id`,
			read,
		};
	}
	return { command: `sleep 600 & echo $! > '${pidFile}'`, read };
}

/**
 * Every gesture in this file is deliberate and countable. A generous ceiling still fails
 * loudly on a livelock, which is the failure mode this guards: three orders of magnitude
 * of headroom, and the observed regression was five.
 */
const MAX_EXPECTED_TAKEOVERS = 50;

/** Count matching lines across a log tree, so an invariant can assert on log VOLUME. */
function countLogLines(logDir: string, needle: string): number {
	let total = 0;
	const walk = (dir: string): void => {
		let entries: Array<{ name: string; isDirectory: () => boolean }>;
		try {
			entries = readdirSync(dir, { withFileTypes: true }) as unknown as typeof entries;
		} catch {
			return;
		}
		for (const entry of entries) {
			const full = join(dir, entry.name);
			if (entry.isDirectory()) {
				walk(full);
				continue;
			}
			if (!entry.name.endsWith(".log")) continue;
			try {
				for (const line of readFileSync(full, "utf8").split("\n")) {
					if (line.includes(needle)) total++;
				}
			} catch {
				// unreadable mid-write; the ceiling is generous enough to absorb it
			}
		}
	};
	walk(logDir);
	return total;
}

function sessionDirCount(): number {
	try {
		return readdirSync(sessionsRootDir(), { withFileTypes: true }).filter((entry) => entry.isDirectory()).length;
	} catch {
		return 0;
	}
}

/**
 * Await ONE sentinel-prefixed JSON line from a live stream, leaving the process running.
 * Deliberately not `new Response(stream).text()`: that waits for EOF, i.e. for the child
 * to exit, which destroys the very state a cross-process assertion needs.
 */
async function readSentinelLine(
	child: { stdout: ReadableStream<Uint8Array>; kill: (signal?: NodeJS.Signals) => void },
	sentinel: string,
	timeoutMs: number,
): Promise<Record<string, unknown> | null> {
	const reader = child.stdout.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	const deadline = Date.now() + timeoutMs;
	let found: Record<string, unknown> | null = null;
	try {
		while (Date.now() < deadline) {
			// Race EVERY read: a bare `await reader.read()` on a silent child hangs past the
			// deadline, so the loop condition alone does not bound this.
			const step = await Promise.race([
				reader.read(),
				new Promise<"timeout">((r) => setTimeout(() => r("timeout"), Math.max(1, deadline - Date.now()))),
			]);
			if (step === "timeout") break;
			if (step.done) break;
			buffer += decoder.decode(step.value, { stream: true });
			for (const line of buffer.split("\n")) {
				if (!line.startsWith(sentinel)) continue;
				try {
					found = JSON.parse(line.slice(sentinel.length)) as Record<string, unknown>;
				} catch {
					found = null;
				}
				return found;
			}
		}
		return null;
	} finally {
		reader.releaseLock();
		// Never leave the child running when we gave up on it — an orphan peer keeps the
		// writer lease and poisons every later assertion in this file.
		if (!found) {
			try {
				child.kill("SIGKILL");
			} catch { /* already gone */ }
		}
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

/** Create a task pane set and bind the first pane, wrapping the two-step API. */
async function startAndBind(
	taskId: string,
	cwd: string,
	env: Record<string, string>,
	launch: TerminalLaunchSpec,
	cols: number,
	rows: number,
	onOutput: (bytes: Uint8Array) => void,
	onClosed: () => void,
): Promise<NativeTaskTerminal> {
	const panesState = await startNativeTaskPanes({ taskId, cwd, env, launch, cols, rows });
	const firstPane = panesState.panes[0];
	if (!firstPane) throw new Error("no pane in created pane set");
	const terminal = await bindNativeTaskPane(firstPane.sessionId, { onOutput, onClosed }, firstPane.paneId);
	if (!terminal) throw new Error(`pane ${firstPane.sessionId} vanished immediately after creation`);
	return terminal;
}

/** Reattach to an existing task's first pane. */
async function reattachAndBind(
	taskId: string,
	onOutput: (bytes: Uint8Array) => void,
	onClosed: () => void,
): Promise<NativeTaskTerminal | null> {
	const panesState = await recoverNativeTaskPanes(taskId);
	const firstPane = panesState?.panes[0];
	if (!firstPane) return null;
	return bindNativeTaskPane(firstPane.sessionId, { onOutput, onClosed }, firstPane.paneId);
}

async function run(): Promise<void> {
	const root = mkdtempSync(join(tmpdir(), "dev3-native-task-terminal-e2e-"));
	const metaDir = join(root, "native-sessions");
	const multipaneDir = join(root, "native-multipane");
	const work = join(root, "work");
	mkdirSync(metaDir, { recursive: true });
	mkdirSync(multipaneDir, { recursive: true });
	mkdirSync(work, { recursive: true });
	process.env.DEV3_NATIVE_SESSIONS_DIR = metaDir;
	process.env[NATIVE_MULTIPANE_DIR_ENV] = multipaneDir;
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
	const renderers: RendererClient[] = [];
	try {
		// ── 1. explicit native create through the product path ──
		const first = makeSink();
		let closedEvents = 0;
		terminal = await startAndBind(TASK_ID, work, {}, taskLaunch(work), 100, 30, first.onOutput, () => { closedEvents++; });
		const hostPid = terminal.hostPid;
		const shellPid = terminal.shellPid;
		check(terminal.sessionId === FIRST_PANE_SESSION_ID, "the task's terminal addresses the deterministic pane session id");
		check(sessionDirCount() === 1, "exactly ONE native session exists after the explicit create");
		check(await nativeTaskPanesAlive(TASK_ID), "the product presence check reports the task terminal alive");
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
		const resized = readRecord(FIRST_PANE_SESSION_ID);
		check(resized?.cols === cols && resized?.rows === rows, "the host persisted the new geometry in the session record");

		// ── 4. detach: the app-side client goes, the terminal does not ──
		terminal.detach();
		terminal = null;
		await delay(400);
		check(closedEvents === 0, "an intentional detach is not reported as a terminal death");
		const afterDetach = readRecord(FIRST_PANE_SESSION_ID);
		check(
			afterDetach?.host.pid === hostPid && afterDetach?.shell.pid === shellPid,
			"the session record still names the same host + shell after detach",
		);
		check(isProcessAlive(hostPid) && isProcessAlive(shellPid), "host + shell survive the app-side detach");
		check(await nativeTaskPanesAlive(TASK_ID), "the task terminal is still present after detach");

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
		terminal = await reattachAndBind(TASK_ID, second.onOutput, () => {});
		check(terminal !== null, "the app reattached to the task terminal after the controller left");
		if (!terminal) throw new Error("reattach returned null while the session is alive");
		const writer = terminal;

		const observer = await NativeSessionClient.discover(FIRST_PANE_SESSION_ID);
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
		await stopNativeTaskPanes(TASK_ID);
		terminal = null;
		const stopDeadline = Date.now() + 5000;
		while (Date.now() < stopDeadline && (isProcessAlive(hostPid) || isProcessAlive(shellPid))) await delay(50);
		check(!isProcessAlive(hostPid) && !isProcessAlive(shellPid), "cleanup terminated exactly the owned host + shell tree");
		check(readRecord(FIRST_PANE_SESSION_ID) === null && sessionDirCount() === 0, "cleanup removed the owned registry state");
		if (sentinelAlive) {
			check(await tmux.hasSession(sentinelSession, { socket: sentinelSocket }), "the pre-existing tmux sentinel session is still alive after cleanup");
		} else {
			console.log("  SKIP - tmux sentinel check (tmux unavailable on this machine)");
		}

		// ── 8. after cleanup: honest null, and nothing respawns ──
		const gone = await reattachAndBind(TASK_ID, () => {}, () => {});
		check(gone === null, "reattaching to a cleaned-up task terminal returns null");
		check(!(await nativeTaskPanesAlive(TASK_ID)), "the product presence check reports the task terminal gone");
		const lost = runController(marker.expected);
		check(lost.exitCode === 0 && lost.verdict?.attached === false, "a fresh app controller also gets an honest lost session");
		check(sessionDirCount() === 0 && !isProcessAlive(hostPid) && !isProcessAlive(shellPid), "the lost reattach spawned NOTHING");

		// ── 9. renderer transport: the pty-server WebSocket bridge over a native session ──
		// Imported HERE, not at module load: importing pty-server starts its Bun.serve
		// listener and idle timer, and it must see this run's isolated env.
		const pty = await import("../pty-server");
		await pty.createNativeTaskSession(WS_TASK_ID, "e2e-project", work, taskLaunch(work), {}, { cols: 100, rows: 30 });
		check(pty.getSessionBackend(WS_TASK_ID) === "native", "pty-server registered the task session on the native backend");
		check(pty.hasDeadSession(WS_TASK_ID) === false, "the native pty-server session is live, not dead");
		const wsRecord = readRecord(WS_FIRST_PANE_SESSION_ID);
		const wsHostPid = wsRecord?.host.pid ?? -1;
		const wsShellPid = wsRecord?.shell.pid ?? -1;
		check(isProcessAlive(wsHostPid) && isProcessAlive(wsShellPid), "the renderer-transport session has its own live host + shell");
		const port = pty.getPtyPort();
		check(port > 0, "the pty-server WebSocket bridge is listening");

		const rendererA = await openRenderer(port, WS_TASK_ID);
		renderers.push(rendererA);
		check(rendererA.attach()?.role === "writer", "the first renderer attaches as the session's writer");
		check(
			rendererA.attach()?.sessionId === WS_SESSION_ID &&
				rendererA.attach()?.hostPid === wsHostPid &&
				rendererA.attach()?.shellPid === wsShellPid,
			"the attach frame names the same native session, host and shell",
		);
		const wsMarker = markerProbe(`${nonce}a`, wsShellPid);
		for (const line of wsMarker.setup) rendererA.send(`${line}${lineEnd}`);
		const seenByA = await sendUntilObserved({
			send: () => rendererA.send(`${wsMarker.command}${lineEnd}`),
			observe: () => (rendererA.sink.text().includes(wsMarker.expected) ? wsMarker.expected : null),
			...SHELL_WARMUP_PROBE,
		});
		check(seenByA !== null, "a command sent over the renderer WebSocket came back on the same socket");

		// A second renderer is an OBSERVER (seq 1300): it sees the screen and every
		// live frame, but its keystrokes must not reach the shell until it says so.
		const rendererB = await openRenderer(port, WS_TASK_ID);
		renderers.push(rendererB);
		check(rendererB.attach()?.role === "observer", "a second renderer attaching to the same session is an observer");
		check(
			(rendererB.attach()?.seq ?? 0) > 0 && rendererB.sink.text().includes(wsMarker.expected),
			"the observer was replayed the screen the writer had already produced",
		);

		const wsRejected = `WSREJECT[${nonce}]`;
		rendererB.send(`${isWindows ? `Write-Output "${wsRejected}"` : `echo "${wsRejected}"`}${lineEnd}`);
		const refusalTold = await rendererB.awaitHeader((h) => h.t === "role" && h.refused === true, 4000);
		// The shell is asked to speak AFTER the refused input: if the rejected text
		// were queued anywhere, it would have surfaced ahead of this barrier.
		const wsBarrier = `WSBARRIER[${nonce}]`;
		const barrierSeen = await sendUntilObserved({
			send: () => rendererA.send(`${isWindows ? `Write-Output "${wsBarrier}"` : `echo "${wsBarrier}"`}${lineEnd}`),
			observe: () =>
				rendererA.sink.text().includes(wsBarrier) && rendererB.sink.text().includes(wsBarrier) ? wsBarrier : null,
			...SHELL_WARMUP_PROBE,
		});
		check(barrierSeen !== null, "the writer keeps driving the shell while an observer is attached");
		check(
			refusalTold && rendererB.refusals() > 0 && !rendererA.sink.text().includes(wsRejected) && !rendererB.sink.text().includes(wsRejected),
			"the observer's input never reached the shell and it was told so explicitly",
		);

		// Explicit takeover over the real wire: one claim frame, both sides re-roled.
		rendererB.send(claimMessage());
		const bPromoted = await rendererB.awaitHeader((h) => h.t === "role" && h.role === "writer", 4000);
		const aDemoted = await rendererA.awaitHeader((h) => h.t === "role" && h.role === "observer", 4000);
		check(
			bPromoted && aDemoted && rendererB.role() === "writer" && rendererA.role() === "observer",
			"an explicit claim moves the writer lease atomically — B is promoted and A demoted",
		);

		// The new writer must land on the SAME shell: the probe echoes the shell's own
		// pid, so a second shell (or a stale one) could not produce this line.
		const fanout = markerProbe(`${nonce}b`, wsShellPid);
		for (const line of fanout.setup) rendererB.send(`${line}${lineEnd}`);
		const fanoutSeen = await sendUntilObserved({
			send: () => rendererB.send(`${fanout.command}${lineEnd}`),
			observe: () =>
				rendererB.sink.text().includes(fanout.expected) && rendererA.sink.text().includes(fanout.expected)
					? fanout.expected
					: null,
			...SHELL_WARMUP_PROBE,
		});
		check(fanoutSeen !== null, "after the takeover B's input reaches the SAME shell and both renderers receive its output");

		const aRefusalsBefore = rendererA.refusals();
		rendererA.send(`${isWindows ? `Write-Output "AREJECT[${nonce}]"` : `echo "AREJECT[${nonce}]"`}${lineEnd}`);
		const aRefused = await rendererA.awaitHeader((h) => h.t === "role" && h.refused === true, 4000);
		check(
			aRefused && rendererA.refusals() > aRefusalsBefore && !rendererB.sink.text().includes(`AREJECT[${nonce}]`),
			"the demoted renderer is refused in turn — never two writers on one PTY",
		);

		// Native geometry is WRITER-only: the observer's viewport stays client-local,
		// so A reports a deliberately different size and B's 120x40 must win.
		const wsCols = 120;
		const wsRows = 40;
		rendererA.send(encodeResizeSequence(wsCols + 80, wsRows + 20));
		rendererB.send(encodeResizeSequence(wsCols, wsRows));
		const wsGeo = rendererGeometryProbe(wsCols, wsRows);
		const wsGeoSeen = await sendUntilObserved({
			send: () => rendererB.send(`${wsGeo.command}${lineEnd}`),
			observe: () => (rendererB.sink.text().includes(wsGeo.expected) ? wsGeo.expected : null),
			...SHELL_WARMUP_PROBE,
		});
		check(wsGeoSeen !== null, `the shell reports the WRITER's geometry (${wsCols}x${wsRows}, not the observer's)`);

		// Reconnect at the watermark: a resumed viewer continues its stream instead of
		// being handed the whole screen again.
		const resumeSeq = rendererA.lastSeq();
		rendererA.close();
		const rendererC = await openRenderer(port, WS_TASK_ID, resumeSeq);
		renderers.push(rendererC);
		check(
			rendererC.attach()?.resumed === true && !rendererC.sink.text().includes(wsMarker.expected),
			"a renderer reconnecting at its watermark resumes instead of replaying the whole screen",
		);
		check(
			rendererB.unframed() === 0 && rendererC.unframed() === 0,
			"every message on a native session is APC-framed — no bare terminal text on this wire",
		);

		await pty.destroySessionAwaited(WS_TASK_ID);
		check(!pty.hasSession(WS_TASK_ID), "pty-server dropped the session after destroySessionAwaited");
		const wsStopDeadline = Date.now() + 5000;
		while (Date.now() < wsStopDeadline && (isProcessAlive(wsHostPid) || isProcessAlive(wsShellPid))) await delay(50);
		check(!isProcessAlive(wsHostPid) && !isProcessAlive(wsShellPid), "the renderer-transport host + shell tree is dead");
		check(readRecord(WS_FIRST_PANE_SESSION_ID) === null && sessionDirCount() === 0, "the renderer-transport registry state is gone");
		if (sentinelAlive) {
			check(await tmux.hasSession(sentinelSession, { socket: sentinelSocket }), "the tmux sentinel session survived the renderer-transport teardown too");
		}

		// ── 11. cross-instance Take control: ONE host, TWO real app processes ──
		// The bug this section exists for: the host grants its single writer lease to
		// the FIRST client across every app process, so a viewer in any other dev3
		// instance was permanently read-only — `Take control` reached the host and came
		// back refused. Two viewers inside one process cannot show this at all, which
		// is why the second half runs in a genuinely separate OS process.
		await pty.createNativeTaskSession(XP_TASK_ID, "e2e-project", work, taskLaunch(work), {}, { cols: 100, rows: 30 });
		const xpRecord = readRecord(XP_FIRST_PANE_SESSION_ID);
		const xpHostPid = xpRecord?.host.pid ?? -1;
		const xpShellPid = xpRecord?.shell.pid ?? -1;
		check(isProcessAlive(xpHostPid) && isProcessAlive(xpShellPid), "the cross-instance session has its own live host + shell");

		const rendererX = await openRenderer(port, XP_TASK_ID);
		renderers.push(rendererX);
		check(rendererX.attach()?.role === "writer", "the FIRST app process holds the writer lease");
		check(
			pty.nativePaneTerminal(XP_TASK_ID)?.hostRole() === "writer",
			"the first process holds the HOST's lease, not merely its own local one",
		);
		// A deliberately different geometry, so "the peer's size won" cannot be a
		// coincidence of both processes asking for the same thing.
		rendererX.send(encodeResizeSequence(100, 30));
		const xpWarmup = markerProbe(`${nonce}x`, xpShellPid);
		for (const line of xpWarmup.setup) rendererX.send(`${line}${lineEnd}`);
		const xpWarmupSeen = await sendUntilObserved({
			send: () => rendererX.send(`${xpWarmup.command}${lineEnd}`),
			observe: () => (rendererX.sink.text().includes(xpWarmup.expected) ? xpWarmup.expected : null),
			...SHELL_WARMUP_PROBE,
		});
		check(xpWarmupSeen !== null, "the first process drives the shell before the peer arrives");

		// A second viewer in the SAME process as the writer. It is a local observer, so it
		// must follow the canonical grid through the whole A→B→A transfer — its own
		// process never performs B's resize, so nothing local can tell it the new size.
		const rendererX2 = await openRenderer(port, XP_TASK_ID);
		renderers.push(rendererX2);
		check(rendererX2.attach()?.role === "observer", "a second viewer in the owning process is a local observer");
		check(
			rendererX2.attach()?.cols === 100 && rendererX2.attach()?.rows === 30,
			"the second local viewer is handed the canonical grid on attach, before any transfer",
		);

		const xpPeerCols = 132;
		const xpPeerRows = 43;
		const peerProbe = markerProbe(`${nonce}p`, xpShellPid);
		const xpTextBefore = rendererX.sink.text();
		const peer = spawn([process.execPath, takeoverPeerEntry, XP_TASK_ID, work], {
			env: {
				...process.env,
				DEV3_TAKEOVER_SETUP: JSON.stringify(peerProbe.setup),
				DEV3_TAKEOVER_COMMAND: peerProbe.command,
				DEV3_TAKEOVER_EXPECTED: peerProbe.expected,
				DEV3_TAKEOVER_COLS: String(xpPeerCols),
				DEV3_TAKEOVER_ROWS: String(xpPeerRows),
				// Generous hold: every live-peer assertion below must land while the peer
				// still owns the lease, or a disconnect vacancy could satisfy them instead.
				DEV3_TAKEOVER_HOLD_MS: "20000",
			},
			stdout: "pipe",
			stderr: "pipe",
		});
		// Read the verdict line WITHOUT waiting for EOF. Consuming the whole stream would
		// block until the peer EXITS, and then every demotion assertion below could have
		// been satisfied by the peer's disconnect-vacancy notice rather than by the
		// takeover — which is the bug this section exists to prove.
		const peerVerdict = await readSentinelLine(peer, TAKEOVER_SENTINEL, 60_000);
		check(peerVerdict !== null, "the peer app process produced a verdict");
		const peerPid = num(peerVerdict, "peerPid");
		// Everything from here until the explicit `await peer.exited` runs against a LIVE
		// peer that still holds the lease.
		check(isProcessAlive(peerPid), "the peer is still alive and holding the lease while its takeover is asserted");
		check(peerPid !== process.pid, `the peer was a genuinely separate OS process (pid ${peerPid})`);
		check(
			peerVerdict?.hostRoleBefore === "observer" && peerVerdict?.attachedRole === "observer",
			"attaching from a second instance does NOT steal the lease — it observes",
		);
		check(
			peerVerdict?.promoted === true && peerVerdict?.roleAfterTakeControl === "writer",
			"an explicit Take control from a second app process TRANSFERS the writer lease",
		);
		check(peerVerdict?.refused !== true, `Take control was not refused (reason: ${String(peerVerdict?.refusedReason ?? "none")})`);
		check(
			num(peerVerdict, "hostPid") === xpHostPid && num(peerVerdict, "shellPid") === xpShellPid,
			"the peer took over the SAME host and shell — nothing respawned",
		);
		check(peerVerdict?.echoedThroughShell === true, "the new writer's input reached the shell");
		check(
			num(peerVerdict, "countedCommandSends") === 1,
			"the peer sent the counted command EXACTLY once, so the parent's occurrence count is meaningful",
		);

		// The displaced process learns its new role FROM THE HOST, not from a guess — and
		// the frame must be a TAKEOVER demotion, not the vacancy notice a disconnect would
		// send. The two are distinguishable without any ack or epoch: a takeover says
		// someone else holds the lease (`writerAttached: true`), a vacancy says nobody does.
		const xDemoted = await rendererX.awaitHeader(
			(h) => h.t === "role" && h.role === "observer" && "writerAttached" in h && h.writerAttached === true,
			8000,
		);
		check(
			xDemoted && isProcessAlive(peerPid),
			"the displaced process was demoted BY THE TAKEOVER while the new writer was still alive — not by its exit",
		);
		check(
			pty.nativePaneTerminal(XP_TASK_ID)?.hostRole() === "observer",
			"the displaced process's HOST role followed the transfer, so it stops pretending it can type",
		);
		const xpOccurrences = rendererX.sink.text().split(peerProbe.expected).length - 1;
		check(
			!xpTextBefore.includes(peerProbe.expected) && xpOccurrences === 1,
			`the peer's input landed on the shared shell EXACTLY once (saw ${xpOccurrences})`,
		);
		// The displaced viewer must be TOLD the new canonical geometry, not left rendering
		// the stream at its own width — those bytes are laid out for the new writer now.
		const xGeometryTold = await rendererX.awaitHeader(
			(h) => h.t === "role" && "cols" in h && h.cols === xpPeerCols && h.rows === xpPeerRows,
			8000,
		);
		check(xGeometryTold, "the displaced viewer was handed the NEW writer's PTY geometry to render at");
		const x2FollowedB = await rendererX2.awaitHeader(
			(h) => h.t === "role" && "cols" in h && h.cols === xpPeerCols && h.rows === xpPeerRows,
			8000,
		);
		check(x2FollowedB, "a SECOND local viewer in the displaced process also follows the new owner's grid");
		const peerStderr = await new Response(peer.stderr).text();
		await peer.exited;
		if (peerStderr.trim()) console.log(`       [peer stderr] ${peerStderr.trim().split("\n").slice(-3).join(" | ")}`);
		const xpAfterRecord = readRecord(XP_FIRST_PANE_SESSION_ID);
		check(
			xpAfterRecord?.cols === xpPeerCols && xpAfterRecord?.rows === xpPeerRows,
			`PTY geometry followed the NEW writer (${xpPeerCols}x${xpPeerRows}, not the displaced 100x30)`,
		);
		check(
			isProcessAlive(xpHostPid) && isProcessAlive(xpShellPid) && !isProcessAlive(peerPid),
			"host and shell survived the transfer with the same pids, and the peer is gone",
		);
		if (sentinelAlive) {
			check(await tmux.hasSession(sentinelSession, { socket: sentinelSocket }), "the tmux sentinel session is untouched by the writer transfer");
		}

		// The lease comes BACK: with the peer gone the slot is vacant, and the same
		// production frame recovers it — a transfer must not be one-way.
		rendererX.send(claimMessage());
		const xRegained = await rendererX.awaitHeader((h) => h.t === "role" && h.role === "writer", 8000);
		check(xRegained, "the first process takes control back once the peer lets go");
		// Geometry follows the lease back too: A owns it again, so A's size is canonical
		// and the second local viewer must be told, not left on B's grid.
		const backCols = 118;
		const backRows = 36;
		rendererX.send(encodeResizeSequence(backCols, backRows));
		const x2FollowedBack = await rendererX2.awaitHeader(
			(h) => h.t === "role" && "cols" in h && h.cols === backCols && h.rows === backRows,
			8000,
		);
		const backRecord = readRecord(XP_FIRST_PANE_SESSION_ID);
		check(
			x2FollowedBack && backRecord?.cols === backCols && backRecord?.rows === backRows,
			`geometry follows the lease BACK to the first process (${backCols}x${backRows})`,
		);

		const xpBack = markerProbe(`${nonce}r`, xpShellPid);
		for (const line of xpBack.setup) rendererX.send(`${line}${lineEnd}`);
		const xpBackSeen = await sendUntilObserved({
			send: () => rendererX.send(`${xpBack.command}${lineEnd}`),
			observe: () => (rendererX.sink.text().includes(xpBack.expected) ? xpBack.expected : null),
			...SHELL_WARMUP_PROBE,
		});
		check(xpBackSeen !== null, "after taking control back the first process drives the SAME shell again");

		// This whole section performs a handful of
		// deliberate gestures. A re-entrant takeover once turned that into ~12k/second and
		// 540k log lines, so the COUNT is asserted, not just the outcome.
		const takeoverLogLines = countLogLines(join(root, "logs"), "Took over the native writer lease");
		check(
			takeoverLogLines <= MAX_EXPECTED_TAKEOVERS,
			`the whole run performed at most ${MAX_EXPECTED_TAKEOVERS} host takeovers (saw ${takeoverLogLines})`,
		);

		await pty.destroySessionAwaited(XP_TASK_ID);
		const xpStopDeadline = Date.now() + 5000;
		while (Date.now() < xpStopDeadline && (isProcessAlive(xpHostPid) || isProcessAlive(xpShellPid))) await delay(50);
		check(!isProcessAlive(xpHostPid) && !isProcessAlive(xpShellPid), "the cross-instance host + shell tree is dead");

		// ── 10. lifecycle teardown: an AWAITED stop of an unattached tree with a nested child ──
		// Both sessions are created through the product path but never registered with
		// pty-server, which is exactly the state after an app restart: the lifecycle has
		// a native task record and no in-memory session to detach from.
		const lifecycle = await startAndBind(LC_TASK_ID, work, {}, taskLaunch(work), 100, 30, () => {}, () => {});
		const sibling = await startAndBind(SIB_TASK_ID, work, {}, taskLaunch(work), 100, 30, () => {}, () => {});
		const child = nestedChildProbe(join(work, "nested-child.pid"));
		const childSeen = await sendUntilObserved({
			send: () => lifecycle.write(`${child.command}${lineEnd}`),
			observe: () => (Number.isNaN(child.read()) ? null : "child"),
			...SHELL_WARMUP_PROBE,
		});
		const childPid = child.read();
		check(childSeen !== null && isProcessAlive(childPid), `the task shell owns a live nested child (pid ${childPid})`);
		// Drop our clients: from here nothing in this process holds either session.
		lifecycle.detach();
		sibling.detach();
		check(!pty.hasSession(LC_TASK_ID), "pty-server holds NO in-memory session for the task about to be torn down");

		await pty.destroyNativeTaskSession(LC_TASK_ID);
		// No polling on purpose: the promise resolving IS the claim that the owned tree
		// is already gone, which is what the lifecycle relies on before cleanup.
		check(
			!isProcessAlive(lifecycle.hostPid) && !isProcessAlive(lifecycle.shellPid) && !isProcessAlive(childPid),
			"the awaited teardown resolved only after host, shell and nested child were all gone",
		);
		check(readRecord(LC_FIRST_PANE_SESSION_ID) === null, "the torn-down task's registry state is gone");
		check(
			isProcessAlive(sibling.hostPid) && isProcessAlive(sibling.shellPid) && readRecord(SIB_FIRST_PANE_SESSION_ID) !== null,
			"the sibling native session is untouched by the other task's teardown",
		);
		if (sentinelAlive) {
			check(await tmux.hasSession(sentinelSession, { socket: sentinelSocket }), "the tmux sentinel session survived the lifecycle teardown");
		}

		const dirsBeforeRepeat = sessionDirCount();
		await pty.destroyNativeTaskSession(LC_TASK_ID);
		check(
			sessionDirCount() === dirsBeforeRepeat && readRecord(SIB_FIRST_PANE_SESSION_ID) !== null,
			"repeating the teardown of an already-stopped task succeeds and spawns nothing",
		);

		await pty.destroyNativeTaskSession(SIB_TASK_ID);
		check(
			!isProcessAlive(sibling.hostPid) && !isProcessAlive(sibling.shellPid) && sessionDirCount() === 0,
			"tearing the sibling down afterwards leaves no native session behind",
		);
	} finally {
		try {
			terminal?.detach();
		} catch {
			// best-effort
		}
		for (const renderer of renderers) {
			try {
				renderer.close();
			} catch {
				// best-effort
			}
		}
		try {
			await stopNativeTaskPanes(TASK_ID);
			await stopNativeTaskPanes(WS_TASK_ID);
			await stopNativeTaskPanes(LC_TASK_ID);
			await stopNativeTaskPanes(SIB_TASK_ID);
			await stopNativeTaskPanes(XP_TASK_ID);
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
