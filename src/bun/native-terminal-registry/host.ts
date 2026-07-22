/**
 * Detached HOST for the native-session registry (seq 1214).
 *
 * A long-lived, detached Bun process that owns exactly ONE interactive shell
 * (spawned through Bun.Terminal) and exposes it over a loopback-TCP WebSocket
 * guarded by a per-run token. It publishes a versioned record + a private token
 * + an independent journal into its own session directory, then keeps running
 * while short-lived clients attach, input, resize, query, and stop — and freely
 * disconnect/reattach without disturbing the live shell. NO tmux involvement.
 *
 * Imported by NOTHING in the production graph (app entry src/bun/index.ts / CLI
 * entry src/cli/main.ts); it cannot affect existing tmux-backed terminal flows.
 */

import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { spawn, spawnSync } from "../spawn";
import { assertNativeTerminalRuntime, nativeTerminalSpawnError } from "../../shared/native-terminal-runtime";
import { journalFile, sessionDir, streamTapFile } from "./paths";
import { readProcessStartSignature } from "./process-identity-native";
import { JournalWriter } from "./journal";
import { LiveParserPipeline } from "./live-parser";
import { bootFailedParserState, writeParserStateAtomic } from "./parser-state";
import { StreamTapWriter } from "./stream-tap";
import {
	decodeControl,
	decodeHello,
	encodeControl,
	errorMessage,
	evaluateHello,
	exceedsControlFrameLimit,
	exitEvent,
	NATIVE_SESSION_PROTOCOL_VERSION,
	stoppingEvent,
	welcomeMessage,
	type StatusReply,
} from "./protocol";
import {
	NATIVE_SESSION_HOST_ARTIFACT_VERSION,
	NATIVE_SESSION_SCHEMA_VERSION,
	removeSessionState,
	writeRecordAtomic,
	writeToken,
	type NativeSessionRecord,
} from "./record";
import { createWindowsJobContainment } from "./windows-job";

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export interface HostConfig {
	sessionId: string;
	cmd: string[];
	cols: number;
	rows: number;
	cwd: string;
	/** Fixed port for tests; default 0 = OS-assigned ephemeral. */
	port?: number;
}

/** Resolve the host configuration from the environment the launcher set. */
export function resolveHostConfig(): HostConfig {
	const sessionId = process.env.DEV3_NATIVE_SESSION_ID;
	if (!sessionId) throw new Error("DEV3_NATIVE_SESSION_ID is required to run a native-session host");
	return {
		sessionId,
		cmd: resolveShellCommand(),
		cols: parsePositiveInt(process.env.DEV3_NATIVE_SESSION_COLS, 80),
		rows: parsePositiveInt(process.env.DEV3_NATIVE_SESSION_ROWS, 24),
		cwd: process.env.DEV3_NATIVE_SESSION_CWD || process.cwd(),
	};
}

function parsePositiveInt(raw: string | undefined, fallback: number): number {
	const value = Number(raw);
	return Number.isInteger(value) && value > 0 ? value : fallback;
}

export function resolveShellCommand(): string[] {
	const raw = process.env.DEV3_NATIVE_SESSION_CMD;
	if (raw) {
		try {
			const arr = JSON.parse(raw);
			if (Array.isArray(arr) && arr.length > 0 && arr.every((x) => typeof x === "string")) {
				return arr as string[];
			}
		} catch {
			// fall through to default
		}
	}
	if (process.platform === "win32") return ["powershell.exe", "-NoLogo", "-NoProfile"];
	return [process.env.SHELL || "/bin/bash"];
}

export interface RecordFields {
	sessionId: string;
	paneId: string;
	hostPid: number;
	hostExecutable: string;
	hostStartSignature: string;
	shellPid: number;
	shellCommand: string[];
	shellStartSignature: string;
	port: number;
	cols: number;
	rows: number;
	runtimeVersion: string;
	platform: string;
	startedAt: string;
	updatedAt: string;
}

/** Build a versioned record from live host state (pure — no token ever enters it). */
export function buildRecord(fields: RecordFields): NativeSessionRecord {
	return {
		schemaVersion: NATIVE_SESSION_SCHEMA_VERSION,
		sessionId: fields.sessionId,
		paneId: fields.paneId,
		protocolVersion: NATIVE_SESSION_PROTOCOL_VERSION,
		hostArtifactVersion: NATIVE_SESSION_HOST_ARTIFACT_VERSION,
		runtimeVersion: fields.runtimeVersion,
		platform: fields.platform,
		host: { pid: fields.hostPid, executable: fields.hostExecutable, startSignature: fields.hostStartSignature },
		shell: { pid: fields.shellPid, command: fields.shellCommand, startSignature: fields.shellStartSignature },
		endpoint: { transport: "ws", address: "127.0.0.1", port: fields.port },
		ownership: { evidenceKind: fields.platform === "win32" ? "windows-job" : "posix-start-signature" },
		cols: fields.cols,
		rows: fields.rows,
		createdAt: fields.startedAt,
		updatedAt: fields.updatedAt,
	};
}

/** Enumerate every descendant PID of `rootPid` via a single `ps` snapshot (POSIX). */
function collectDescendants(rootPid: number): number[] {
	try {
		const res = spawnSync(["ps", "-eo", "pid=,ppid="]);
		if (!res.success) return [];
		const childrenByParent = new Map<number, number[]>();
		for (const line of new TextDecoder().decode(res.stdout).split("\n")) {
			const m = /^\s*(\d+)\s+(\d+)\s*$/.exec(line);
			if (!m) continue;
			const pid = Number(m[1]);
			const ppid = Number(m[2]);
			const list = childrenByParent.get(ppid);
			if (list) list.push(pid);
			else childrenByParent.set(ppid, [pid]);
		}
		const out: number[] = [];
		const stack = [rootPid];
		while (stack.length > 0) {
			const parent = stack.pop() as number;
			for (const child of childrenByParent.get(parent) ?? []) {
				out.push(child);
				stack.push(child);
			}
		}
		return out;
	} catch {
		return [];
	}
}

function killTree(
	shellPid: number,
	proc: { kill: (signal?: number | NodeJS.Signals) => void },
	signal: NodeJS.Signals,
): void {
	for (const pid of collectDescendants(shellPid)) {
		try {
			process.kill(pid, signal);
		} catch {
			// already gone
		}
	}
	try {
		process.kill(-shellPid, signal); // foreground process group
	} catch {
		// no such group
	}
	try {
		process.kill(shellPid, signal);
	} catch {
		try {
			proc.kill(signal);
		} catch {
			// already gone
		}
	}
}

/**
 * Boot the host. Resolves once shell + transport are up and the record/token are
 * published (the readiness signal the launcher polls). Settling does NOT end the
 * process — the WebSocket server and PTY keep the event loop alive until stop /
 * shell exit.
 */
export async function runHost(config: HostConfig = resolveHostConfig()): Promise<void> {
	const bunVersion = Bun.version;
	assertNativeTerminalRuntime({ platform: process.platform, bunVersion });
	const { sessionId } = config;
	const paneId = `${sessionId}:0`;
	const token = randomBytes(24).toString("hex");

	// Self-enrol BEFORE Bun.spawn so Windows children inherit the non-breakaway
	// job atomically at process creation (no root-shell assignment race).
	const windowsJob = await createWindowsJobContainment(token);
	mkdirSync(sessionDir(sessionId), { recursive: true, mode: 0o700 });

	const clients = new Set<{ send: (data: string | Uint8Array) => number; close: () => void }>();
	const journal = new JournalWriter(journalFile(sessionId));
	journal.start();
	let currentCols = config.cols;
	let currentRows = config.rows;
	let shuttingDown = false;

	// Live-parser proof stage (seq 1228) — opt-in, additive, protocol-v1-neutral.
	// Ghostty is loaded HERE on the boot path, never inside the terminal callback.
	const tap = process.env.DEV3_NATIVE_SESSION_STATE_TAP === "1" ? new StreamTapWriter(streamTapFile(sessionId)) : null;
	tap?.start();
	let terminalRef: { write(data: string | Uint8Array): void } | null = null;
	let pipeline: LiveParserPipeline | null = null;
	if (process.env.DEV3_NATIVE_SESSION_LIVE_PARSER === "1") {
		try {
			pipeline = await LiveParserPipeline.create({
				sessionId,
				cols: config.cols,
				rows: config.rows,
				scrollbackLimit: parsePositiveInt(process.env.DEV3_NATIVE_SESSION_PARSER_SCROLLBACK, 1000),
				snapshotScrollbackCap: parsePositiveInt(process.env.DEV3_NATIVE_SESSION_PARSER_SNAPSHOT_SCROLLBACK, 200),
				queueMaxBytes: parsePositiveInt(process.env.DEV3_NATIVE_SESSION_PARSER_QUEUE_MAX_BYTES, 8 * 1024 * 1024),
				writeReply: (reply) => {
					try {
						terminalRef?.write(reply); // parser replies go back to the SAME PTY
					} catch {
						// terminal already closed
					}
				},
				persistState: (snapshot) => writeParserStateAtomic(sessionId, snapshot),
				fault: process.env.DEV3_NATIVE_SESSION_PARSER_FAULT === "ingest" ? "ingest" : null,
			});
		} catch (err) {
			// Containment: a parser that cannot boot must never take the host down.
			try {
				writeParserStateAtomic(sessionId, bootFailedParserState(sessionId, err));
			} catch {
				// state dir unavailable — raw operation continues regardless
			}
		}
	}

	const proc = (() => {
		try {
			return spawn(config.cmd, {
				terminal: {
					cols: config.cols,
					rows: config.rows,
					data(_terminal: unknown, bytes: Uint8Array) {
						journal.record(bytes, new Date().toISOString());
						// Bounded enqueueing ONLY — parsing happens on a later event-loop task.
						tap?.recordOutput(bytes);
						pipeline?.onOutput(bytes);
						for (const c of clients) {
							try {
								c.send(bytes);
							} catch {
								// dead client — dropped on next close event
							}
						}
					},
				},
				cwd: config.cwd,
				env: { ...process.env, TERM: "xterm-256color" },
			});
		} catch (cause) {
			throw nativeTerminalSpawnError({ platform: process.platform, bunVersion, command: config.cmd[0] ?? "shell", cause });
		}
	})();
	if (!proc.terminal) {
		try {
			proc.kill();
		} catch {
			// process already exited
		}
		throw nativeTerminalSpawnError({
			platform: process.platform,
			bunVersion,
			command: config.cmd[0] ?? "shell",
			cause: new Error("Bun.spawn returned without a terminal handle"),
		});
	}
	terminalRef = proc.terminal;

	const startedAt = new Date().toISOString();
	const shellPid = proc.pid;
	const hostStartSignature = readProcessStartSignature(process.pid);
	const shellStartSignature = readProcessStartSignature(shellPid);

	// One v1 hello must complete per connection before input/commands are honoured.
	const server = Bun.serve<{ helloDone: boolean }>({
		port: config.port ?? 0,
		hostname: "127.0.0.1",
		fetch(req, srv) {
			const url = new URL(req.url);
			// Token gate = the ErrorCode "unauthorized", surfaced as HTTP 401 before upgrade.
			if (url.searchParams.get("token") !== token) {
				return new Response("unauthorized", { status: 401 });
			}
			if (srv.upgrade(req, { data: { helloDone: false } })) return undefined;
			return new Response("dev3 native-session host", { status: 200 });
		},
		websocket: {
			open(ws) {
				clients.add(ws);
			},
			close(ws) {
				clients.delete(ws);
				// Detach boundary: make the reconstructable state current on disk.
				pipeline?.flush();
			},
			message(ws, message) {
				try {
					handleFrame(ws, message);
				} catch (err) {
					// A bad frame must never crash the host, change registry state, or kill the shell.
					try {
						ws.send(encodeControl(errorMessage("internal-error", undefined, err instanceof Error ? err.message : String(err))));
					} catch {
						// dead client
					}
				}
			},
		},
	});

	function handleFrame(ws: Bun.ServerWebSocket<{ helloDone: boolean }>, message: string | Uint8Array): void {
		if (typeof message === "string") {
			if (exceedsControlFrameLimit(message)) {
				ws.send(encodeControl(errorMessage("bad-request", undefined, "control frame too large")));
				return;
			}
			if (!ws.data.helloDone) {
				const verdict = evaluateHello(message, sessionId);
				if (!verdict.ok) {
					ws.send(encodeControl(verdict.error));
					ws.close(); // close ONLY this socket — host, shell, and other clients stay alive
					return;
				}
				ws.data.helloDone = true;
				ws.send(encodeControl(welcomeMessage(verdict.id, sessionId)));
				return;
			}
			const dupHello = decodeHello(message);
			if (dupHello) {
				ws.send(encodeControl(errorMessage("conflict", dupHello.id, "hello already completed")));
				return;
			}
			const msg = decodeControl(message);
			if (!msg) return; // drop unparseable / forward-additive control quietly
			if (msg.type === "resize") {
				currentCols = msg.cols;
				currentRows = msg.rows;
				try {
					proc.terminal?.resize(msg.cols, msg.rows);
				} catch {
					// terminal already closed
				}
				// Record the resize at its real position in the output order.
				tap?.recordResize(msg.cols, msg.rows);
				pipeline?.onResize(msg.cols, msg.rows);
				persist();
			} else if (msg.type === "status") {
				ws.send(encodeControl(currentStatus(msg.id)));
			} else if (msg.type === "stop") {
				for (const c of clients) {
					try {
						c.send(encodeControl(stoppingEvent()));
					} catch {
						// dead client
					}
				}
				void shutdown(0);
			}
			return;
		}
		if (!ws.data.helloDone) return; // ignore PTY input before the handshake completes
		proc.terminal?.write(message);
	}

	function currentStatus(id: number): StatusReply {
		return {
			v: NATIVE_SESSION_PROTOCOL_VERSION,
			type: "status",
			id,
			sessionId,
			paneId,
			hostPid: process.pid,
			shellPid,
			cols: currentCols,
			rows: currentRows,
			alive: proc.terminal ? !proc.terminal.closed : false,
			startedAt,
		};
	}

	function persist(): void {
		writeRecordAtomic(
			buildRecord({
				sessionId,
				paneId,
				hostPid: process.pid,
				hostExecutable: process.execPath,
				hostStartSignature,
				shellPid,
				shellCommand: config.cmd,
				shellStartSignature,
				port: server.port ?? 0,
				cols: currentCols,
				rows: currentRows,
				runtimeVersion: bunVersion,
				platform: process.platform,
				startedAt,
				updatedAt: new Date().toISOString(),
			}),
		);
	}

	async function shutdown(exitCode: number): Promise<void> {
		if (shuttingDown) return;
		shuttingDown = true;
		try {
			server.stop(true);
		} catch {
			// already stopped
		}
		try {
			pipeline?.flush();
			pipeline?.dispose();
		} catch {
			// parser teardown must never block host shutdown
		}
		tap?.stop();
		journal.stop();
		if (windowsJob) {
			try {
				proc.terminal?.write("\x03");
				await delay(75);
				proc.terminal?.write("exit\r");
			} catch {
				// terminal already closed
			}
			await Promise.race([proc.exited, delay(1500)]);
			removeSessionState(sessionId, token);
			windowsJob.closeForTreeTermination();
			process.exit(exitCode);
			return;
		}
		killTree(shellPid, proc, "SIGTERM");
		const exitedGracefully = await Promise.race([proc.exited.then(() => true), delay(1500).then(() => false)]);
		if (!exitedGracefully) {
			killTree(shellPid, proc, "SIGKILL");
			await Promise.race([proc.exited, delay(1000)]);
		}
		try {
			proc.terminal?.close();
		} catch {
			// already closed
		}
		removeSessionState(sessionId, token);
		process.exit(exitCode);
	}

	void proc.exited.then((code) => {
		if (shuttingDown) return;
		for (const c of clients) {
			try {
				c.send(encodeControl(exitEvent(code)));
			} catch {
				// dead client
			}
		}
		void shutdown(0);
	});

	for (const sig of ["SIGTERM", "SIGINT"] as const) {
		process.on(sig, () => void shutdown(0));
	}

	// Readiness signal: publish the private token first, then the discoverable
	// record last, so a reader that sees the record can always read the token.
	writeToken(sessionId, token);
	persist();
}
