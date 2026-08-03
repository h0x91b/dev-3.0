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
import { LiveParserPipeline, type LiveParserProjection } from "./live-parser";
import { bootFailedParserState, writeParserStateAtomic, type ParserStateSnapshot } from "./parser-state";
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
	ownershipReply,
	stoppingEvent,
	welcomeMessage,
	type StatusReply,
} from "./protocol";
import {
	ProducerNotReadyError,
	captureContentIdentity,
	captureRecordOf,
	writeCaptureRecordAtomic,
	type CaptureProducer,
} from "./capture-record";
import { NATIVE_CAPTURE_MODE_ENV, captureModePlan, parseCaptureMode } from "./capture-mode";
import {
	NATIVE_SESSION_TEXT_CAPTURE_CAPABILITY,
	NATIVE_SESSION_HOST_ARTIFACT_VERSION,
	NATIVE_SESSION_SCHEMA_VERSION,
	removeSessionState,
	writeRecordAtomic,
	writeToken,
	type NativeSessionCaptureSurface,
	type NativeSessionRecord,
} from "./record";
import { deriveNativeProcessIdentity, PANE_ID_ENV, type NativeProcessIdentity } from "./process-naming";
import { createWindowsJobContainment } from "./windows-job";
import { WriterOwnership } from "./writer-ownership";
import {
	decodeShellLaunchSpec,
	shellCommand,
	NATIVE_SESSION_LAUNCH_ENV,
	type ShellLaunchSpec,
} from "./shell-launch";

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export interface HostConfig {
	sessionId: string;
	launch: ShellLaunchSpec;
	cols: number;
	rows: number;
	/** Fixed port for tests; default 0 = OS-assigned ephemeral. */
	port?: number;
}

/** Resolve the host configuration from the environment the launcher set. */
export function resolveHostConfig(): HostConfig {
	const sessionId = process.env.DEV3_NATIVE_SESSION_ID;
	if (!sessionId) throw new Error("DEV3_NATIVE_SESSION_ID is required to run a native-session host");
	const rawLaunch = process.env[NATIVE_SESSION_LAUNCH_ENV];
	if (!rawLaunch) throw new Error(`${NATIVE_SESSION_LAUNCH_ENV} is required to run a native-session host`);
	return {
		sessionId,
		launch: decodeShellLaunchSpec(rawLaunch),
		cols: parsePositiveInt(process.env.DEV3_NATIVE_SESSION_COLS, 80),
		rows: parsePositiveInt(process.env.DEV3_NATIVE_SESSION_ROWS, 24),
	};
}

function parsePositiveInt(raw: string | undefined, fallback: number): number {
	const value = Number(raw);
	return Number.isInteger(value) && value > 0 ? value : fallback;
}

export interface RecordFields {
	sessionId: string;
	paneId: string;
	identity: NativeProcessIdentity;
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
	/** Capture surfaces this host is actually publishing right now. */
	captureSurfaces?: readonly NativeSessionCaptureSurface[];
	startedAt: string;
	updatedAt: string;
}

/** Build a versioned record from live host state (pure — no token ever enters it). */
export function buildRecord(fields: RecordFields): NativeSessionRecord {
	const identity = {
		...(fields.identity.seq ? { seq: fields.identity.seq } : {}),
		...(fields.identity.paneId ? { paneId: fields.identity.paneId } : {}),
	};
	return {
		schemaVersion: NATIVE_SESSION_SCHEMA_VERSION,
		sessionId: fields.sessionId,
		paneId: fields.paneId,
		// Omitted entirely when nothing is known, so a non-task session's record
		// keeps exactly the shape it had before seq 1383.
		...(identity.seq || identity.paneId ? { identity } : {}),
		// Advertised only for surfaces actually being written, so absence stays the
		// honest "this host publishes nothing" rather than an unset flag.
		...(fields.captureSurfaces?.length ? { capabilities: { capture: [...fields.captureSurfaces] } } : {}),
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

/**
 * Signal the shell tree. `shellSignal` addresses the shell and its foreground
 * group; `descendantSignal` addresses the individually-collected descendants.
 *
 * They differ on the graceful pass because an INTERACTIVE shell on a PTY ignores
 * SIGTERM outright — measured: zsh survives it indefinitely and does not reap its
 * jobs, so every graceful stop burned the full grace window and then SIGKILLed.
 * SIGHUP is the hangup the shell is built to honour: it exits at once and HUPs its
 * own jobs. Descendants keep SIGTERM so a server that traps it still gets the
 * notification it got before.
 */
export interface KillTreeEffects {
	signal: (pid: number, sig: NodeJS.Signals) => void;
	descendants: (rootPid: number) => number[];
}

const defaultKillTreeEffects: KillTreeEffects = {
	signal: (pid, sig) => process.kill(pid, sig),
	descendants: collectDescendants,
};

export function killTree(
	shellPid: number,
	proc: { kill: (signal?: number | NodeJS.Signals) => void },
	shellSignal: NodeJS.Signals,
	descendantSignal: NodeJS.Signals = shellSignal,
	effects: KillTreeEffects = defaultKillTreeEffects,
): void {
	for (const pid of effects.descendants(shellPid)) {
		try {
			effects.signal(pid, descendantSignal);
		} catch {
			// already gone
		}
	}
	try {
		effects.signal(-shellPid, shellSignal); // foreground process group
	} catch {
		// no such group
	}
	try {
		effects.signal(shellPid, shellSignal);
	} catch {
		try {
			proc.kill(shellSignal);
		} catch {
			// already gone
		}
	}
}

/**
 * The signals one graceful stop uses, named so the choice is testable without a
 * real PTY. Reverting `shell` to SIGTERM is the regression this pair guards: an
 * interactive PTY shell ignores it, so the whole grace window is wasted.
 */
export const GRACEFUL_STOP_SIGNALS = { shell: "SIGHUP", descendants: "SIGTERM" } as const;

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
	// Same pure derivation the launcher used for argv0, from the same two inputs,
	// so what a process viewer shows and what the record says cannot drift.
	const identity = deriveNativeProcessIdentity(sessionId, config.launch.env);

	// Self-enrol BEFORE Bun.spawn so Windows children inherit the non-breakaway
	// job atomically at process creation (no root-shell assignment race).
	const windowsJob = await createWindowsJobContainment(token);
	mkdirSync(sessionDir(sessionId), { recursive: true, mode: 0o700 });

	type ClientData = { helloDone: boolean; clientPid?: number };
	type HostClient = Bun.ServerWebSocket<ClientData>;
	const clients = new Set<HostClient>();
	const writerOwnership = new WriterOwnership<HostClient>();
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
	// One exhaustive mode decides which artifacts exist; the two sinks below are
	// independent, so selecting the compact one can never make the per-cell one
	// unreachable.
	const captureMode = parseCaptureMode(process.env[NATIVE_CAPTURE_MODE_ENV]);
	const plan = captureModePlan(captureMode);
	const publishesSemantic = plan.semantic;
	const publishesCompact = plan.compact;
	// A projection write needs the producer's identity, which only exists after the
	// shell is spawned and its signature probed. Until then the sink reports "not
	// ready" so the pipeline keeps the write retryable instead of throwing into a
	// swallowed catch (findings 12 and 14).
	let producerIdentity: CaptureProducer | null = null;
	// The last record actually published, so a forced write of unchanged content can
	// keep its ORIGINAL timestamp. Otherwise a viewer disconnecting from a quiet pane
	// (detach flushes) would reset "when the content last changed" to now.
	let published: { identity: string; updatedAt: string } | null = null;

	function publishCapture(projection: LiveParserProjection): void {
		if (!producerIdentity) throw new ProducerNotReadyError(sessionId);
		const record = captureRecordOf(sessionId, producerIdentity, projection);
		const identity = captureContentIdentity(record);
		const updatedAt = published !== null && published.identity === identity ? published.updatedAt : record.updatedAt;
		// The artifact path is scoped to this producer, so publishing cannot collide
		// with a successor and needs no ownership check to get wrong.
		writeCaptureRecordAtomic({ ...record, updatedAt });
		published = { identity, updatedAt };
	}


	const advertisedSurfaces = (): NativeSessionCaptureSurface[] =>
		plan.surfaces.filter(
			(surface) => surface !== NATIVE_SESSION_TEXT_CAPTURE_CAPABILITY || producerIdentity !== null,
		);
	if (plan.runsParser) {
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
				...(publishesSemantic
					? { persistState: (snapshot: ParserStateSnapshot) => writeParserStateAtomic(sessionId, snapshot) }
					: {}),
				...(publishesCompact
					? { persistProjection: (projection: LiveParserProjection) => publishCapture(projection) }
					: {}),
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
			return spawn(shellCommand(config.launch), {
				terminal: {
					cols: config.cols,
					rows: config.rows,
					data(_terminal: unknown, bytes: Uint8Array) {
						journal.record(bytes, new Date().toISOString());
						// Bounded enqueueing ONLY — parsing happens on a later event-loop task.
						tap?.recordOutput(bytes);
						pipeline?.onOutput(bytes);
						for (const c of clients) {
							if (!c.data.helloDone) continue;
							try {
								c.send(bytes);
							} catch {
								// dead client — dropped on next close event
							}
						}
					},
				},
				cwd: config.launch.cwd,
				// The shell's own argv is left exactly as the launch spec defines it —
				// rewriting argv0 would change `$0` and the leading-dash login-shell
				// convention. Its pane is exported instead (seq 1383).
				env: {
					...process.env,
					TERM: "xterm-256color",
					...config.launch.env,
					...(identity.paneId ? { [PANE_ID_ENV]: identity.paneId } : {}),
				},
			});
		} catch (cause) {
			throw nativeTerminalSpawnError({ platform: process.platform, bunVersion, command: config.launch.executable, cause });
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
			command: config.launch.executable,
			cause: new Error("Bun.spawn returned without a terminal handle"),
		});
	}
	terminalRef = proc.terminal;

	const startedAt = new Date().toISOString();
	const shellPid = proc.pid;
	const [hostStartSignature, shellStartSignature] = await Promise.all([
		readProcessStartSignature(process.pid),
		readProcessStartSignature(shellPid),
	]);

	// One v1 hello must complete per connection before input/commands are honoured.
	const server = Bun.serve<ClientData>({
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
				// Unsolicited (id 0): the writer left, so the lease is free. The role
				// itself does not move — a survivor still has to claim — but it has to
				// LEARN the slot opened, or it stays read-only forever with nobody typing.
				for (const survivor of writerOwnership.detach(ws)) {
					try {
						survivor.send(encodeControl(ownershipReply(0, writerOwnership.roleOf(survivor) ?? "observer", false)));
					} catch { /* that survivor died too */ }
				}
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

	function handleFrame(ws: HostClient, message: string | Uint8Array): void {
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
				ws.data.clientPid = verdict.clientPid;
				const role = writerOwnership.attach(ws);
				ws.send(encodeControl(welcomeMessage(verdict.id, sessionId, role)));
				// Same synchronous turn: replay ends before later PTY callbacks fan out live bytes.
				for (const bytes of journal.replay()) ws.send(bytes);
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
				if (!writerOwnership.canMutatePty(ws)) {
					ws.send(encodeControl(errorMessage("conflict", undefined, "observer cannot resize the PTY")));
					return;
				}
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
				ws.send(encodeControl(currentStatus(ws, msg.id)));
			} else if (msg.type === "ownership" && "action" in msg) {
				const result = writerOwnership.request(ws, msg.action);
				if (!result.ok) {
					const message =
						result.reason === "writer-active"
							? "another client is already the writer"
							: result.reason === "not-writer"
								? "only the writer can release ownership"
								: "client has not completed attach";
					ws.send(encodeControl(errorMessage("conflict", msg.id, message)));
					return;
				}
				ws.send(encodeControl(ownershipReply(msg.id, result.role, result.writerAttached)));
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
		if (!writerOwnership.canMutatePty(ws)) {
			ws.send(encodeControl(errorMessage("conflict", undefined, "observer cannot send PTY input")));
			return;
		}
		proc.terminal?.write(message);
	}

	function currentStatus(ws: HostClient, id: number): StatusReply {
		const writer = writerOwnership.writerClient();
		// Absent (not null) when the writer's client predates `clientPid`: callers
		// must read that as "unknown owner", never as "the slot is free".
		const writerPid = writer ? writer.data.clientPid : null;
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
			clientRole: writerOwnership.roleOf(ws) ?? "observer",
			writerAttached: writerOwnership.hasWriter(),
			...(writerPid !== undefined ? { writerPid } : {}),
		};
	}

	function persist(): void {
		writeRecordAtomic(
			buildRecord({
				sessionId,
				paneId,
				identity,
				hostPid: process.pid,
				hostExecutable: process.execPath,
				hostStartSignature,
				shellPid,
				shellCommand: shellCommand(config.launch),
				shellStartSignature,
				port: server.port ?? 0,
				cols: currentCols,
				rows: currentRows,
				runtimeVersion: bunVersion,
				platform: process.platform,
				// Compact is advertised only once its producer identity exists, so a reader
				// never sees the capability before a record can be written.
				captureSurfaces: pipeline === null ? [] : advertisedSurfaces(),
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
		killTree(shellPid, proc, GRACEFUL_STOP_SIGNALS.shell, GRACEFUL_STOP_SIGNALS.descendants);
		const exitedGracefully = await Promise.race([proc.exited.then(() => true), delay(1500).then(() => false)]);
		if (!exitedGracefully) {
			// Shell traps or ignores SIGHUP — the bounded escalation still applies.
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

	// The producer's identity is complete only here, so this is the first moment a
	// capture record CAN be written. Publish an initial one (blank is fine) before
	// the session record advertises the surface, so a reader never sees a capability
	// with nothing behind it.
	producerIdentity = {
		hostPid: process.pid,
		hostStartSignature,
		shellPid,
		shellStartSignature,
	};
	if (publishesCompact && pipeline) {
		try {
			publishCapture(pipeline.projection());
		} catch {
			// A capture artifact that cannot be written must never take the host down;
			// the pipeline retries on its own cadence.
		}
	}

	// Readiness signal: publish the private token first, then the discoverable
	// record last, so a reader that sees the record can always read the token.
	writeToken(sessionId, token);
	persist();
}
