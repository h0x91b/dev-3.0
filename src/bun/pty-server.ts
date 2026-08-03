import { access } from "node:fs/promises";
import type { TmuxLayout, TmuxWindowInfo, TmuxPaneInfo } from "../shared/types";
import { ENV_UNSET } from "../shared/agent-accounts";
import type { TerminalBackendIdentity } from "../shared/terminal-backend-identity";
import { isResizeSequence, parseResizeSequence, smallestClientSize } from "../shared/resize-protocol";
import {
	attachMessage,
	decodeNativeStreamMessage,
	outputMessage,
	parseSinceParam,
	roleMessage,
	NATIVE_STREAM_SINCE_PARAM,
} from "../shared/native-terminal-stream";
import type { NativeStreamRole } from "../shared/native-terminal-stream";
import { NativeBridgeJournal, NativeClientLease } from "./native-terminal-bridge";
import { createLogger } from "./logger";
import { spawn } from "./spawn";
import { getUserShell } from "./shell-env";
import {
	bindNativeTaskPane,
	type NativeTaskTerminal,
} from "./native-task-terminal";
import {
	startNativeTaskPanes,
	recoverNativeTaskPanes,
	stopNativeTaskPanes,
} from "./native-task-panes";
import { paneSessionKey, parsePaneSessionKey } from "../shared/pane-session-key";
import { PTY_WS_CLOSE } from "../shared/pty-ws-close-codes";
import { nativeTaskSessionId, type TerminalLaunchSpec } from "./task-terminal-backend";
import {
	tmux,
	DEFAULT_TMUX_SOCKET,
	TmuxError,
	taskSessionName,
	projectTerminalSessionName,
	activeTmuxConfigPath,
	setActiveTmuxTheme,
	parseWindowLayout,
	PANE_ID_FORMAT,
	WINDOW_OVERVIEW_FORMAT,
	PANE_GEOMETRY_FORMAT,
	STATUS_GEOMETRY_FORMAT,
} from "./tmux";

const log = createLogger("pty");

// All tmux mechanics (binary/shim selection, config generation, session
// naming, format parsing) live in ./tmux — this module owns PTY sessions:
// spawning attached tmux clients, the renderer WebSocket bridge, and
// per-session lifecycle state.

/**
 * Apply a tmux theme (dark/light) to all active dev3 tmux sessions.
 * Sources the corresponding config file, which re-sets all theme variables
 * and re-applies every setting that depends on them.
 */
export async function applyTmuxTheme(theme: "dark" | "light"): Promise<void> {
	const configPath = setActiveTmuxTheme(theme);
	// Source the themed config on every known socket (typically just "dev3")
	const sockets = new Set<string>();
	for (const session of sessions.values()) {
		sockets.add(session.tmuxSocket);
	}
	// Always include the default socket even if no sessions exist yet
	sockets.add(DEFAULT_TMUX_SOCKET);
	await Promise.all(
		Array.from(sockets).map(async (socket) => {
			try {
				await tmux.sourceFile(configPath, { socket, bestEffort: true });
				log.info("tmux theme applied", { theme, socket, configPath });
			} catch (err) {
				log.warn("Failed to apply tmux theme", { theme, socket, error: String(err) });
			}
		}),
	);
}

let tmuxBinaryLogged = false;

export function _resetTmuxBinaryLoggedForTests(): void {
	tmuxBinaryLogged = false;
}

function logTmuxBinaryOnce(taskId: string): void {
	if (tmuxBinaryLogged) return;
	tmuxBinaryLogged = true;
	// Fire-and-forget — purely diagnostic, never block the spawn path on it.
	(async () => {
		try {
			const proc = spawn(["which", "tmux"], { stdout: "pipe", stderr: "pipe" });
			const stdout = await new Response(proc.stdout).text();
			const exitCode = await proc.exited;
			log.info("tmux binary found", {
				taskId: shortId(taskId),
				path: stdout.trim(),
				exitCode,
			});
		} catch (err) {
			log.error("tmux binary NOT found — this will crash", {
				taskId: shortId(taskId),
				error: String(err),
			});
		}
	})();
}

let ptyWsPort = 0;

// ── PTY data batching ──────────────────────────────────────────────
// AI agents (Claude Code, Codex) generate 4,000–6,700 scroll events/sec.
// Forwarding every PTY byte chunk individually to WebSocket causes massive
// rendering overhead in the frontend terminal emulator. Instead, we batch
// data and flush at ~60fps (16ms intervals). This reduces WS message count
// by 10-100x while maintaining perceptual smoothness.
const PTY_BATCH_INTERVAL_MS = 16;

export type PtySessionType = "task" | "project";

interface PtySession {
	taskId: string;
	projectId: string;
	cwd: string;
	tmuxCommand: string;
	env: Record<string, string>;
	/** Which backend owns this session's shell. `tmux` uses `proc`, `native` uses `native`. */
	backend: TerminalBackendIdentity;
	proc: ReturnType<typeof Bun.spawn> | null;
	/** The app's single writer binding to a native host, when `backend` is native. */
	native: NativeTaskTerminal | null;
	/**
	 * The key this session is registered under. Auxiliary panes use `taskId~paneId`, so
	 * anything that unregisters a session MUST use this rather than the bare taskId —
	 * deleting `taskId` for pane 2 would drop pane 1 instead.
	 */
	registryKey: string;
	/** Guards against two concurrent reattach attempts for one native session. */
	nativeAttaching: boolean;
	/** The host binding is being replaced; no viewer may be told it is the writer. */
	nativeRecovering: boolean;
	/** Bounded mirror of broadcast output, so a late/reconnecting viewer sees the screen. */
	nativeStream: NativeBridgeJournal | null;
	/** Which viewer may type into the shell. Native only — tmux arbitrates its own clients. */
	nativeLease: NativeClientLease<any> | null;
	/** All currently connected WebSocket clients. PTY output is broadcast to all. */
	clients: Set<any>;
	tmuxSocket: string;
	tmuxSessionName: string;
	sessionType: PtySessionType;
	lastOutputTime: number;
	idleNotified: boolean;
	/** Streaming decoder that buffers incomplete multi-byte UTF-8 sequences
	 *  across PTY data chunks, preventing U+FFFD replacement characters. */
	decoder: TextDecoder;
	/** Accumulator for PTY data batching — flushed at PTY_BATCH_INTERVAL_MS. */
	pendingData: string;
	/** Timer handle for the batch flush interval. */
	batchTimer: ReturnType<typeof setTimeout> | null;
	/** Timer handle for the deferred post-spawn configureTmux() call.
	 *  Cleared on destroy so a torn-down session never sources its tmux
	 *  config 200ms later (also prevents stale spawns leaking across tests). */
	configureTimer: ReturnType<typeof setTimeout> | null;
	/** Partial OSC 52 clipboard sequence buffered across PTY chunks. */
	osc52Buffer: string;
	/** Size last applied to the shared PTY (min across all clients). Used to
	 *  detect same-size resizes that need a forced redraw — see applyClientSizes. */
	appliedCols?: number;
	appliedRows?: number;
}

const sessions = new Map<string, PtySession>();
let onPtyDiedCallback: ((taskId: string) => void) | null = null;
let onBellCallback: ((taskId: string) => void) | null = null;
let onIdleCallback: ((taskId: string) => void) | null = null;
let onPaneExitedCallback: ((taskId: string, paneId: string) => void) | null = null;
let onOsc52CopyCallback: ((payload: { taskId: string; text: string; len: number }) => void) | null = null;

export function setOnPtyDied(fn: (taskId: string) => void): void {
	onPtyDiedCallback = fn;
}

export function setOnBell(fn: (taskId: string) => void): void {
	onBellCallback = fn;
}

export function setOnIdle(fn: (taskId: string) => void): void {
	onIdleCallback = fn;
}

export function setOnPaneExited(fn: (taskId: string, paneId: string) => void): void {
	onPaneExitedCallback = fn;
}

export function setOnOsc52Copy(fn: (payload: { taskId: string; text: string; len: number }) => void): void {
	onOsc52CopyCallback = fn;
}


/** Compute the tmux session name for a given session key and type. */
function computeTmuxSessionName(key: string, type: PtySessionType): string {
	if (type === "project") {
		const projectId = key.startsWith("project-") ? key.slice(8) : key;
		return projectTerminalSessionName(projectId);
	}
	return taskSessionName(key);
}

export function createSession(
	taskId: string,
	projectId: string,
	cwd: string,
	tmuxCommand: string,
	extraEnv: Record<string, string> = {},
	tmuxSocket: string = DEFAULT_TMUX_SOCKET,
	sessionType: PtySessionType = "task",
): void {
	log.info("Creating PTY session", { taskId: taskId.slice(0, 8), cwd, tmuxCommand, tmuxSocket, sessionType });
	const tmuxSessionName = computeTmuxSessionName(taskId, sessionType);
	const session: PtySession = {
		taskId,
		projectId,
		cwd,
		tmuxCommand,
		env: extraEnv,
		backend: "tmux",
		proc: null,
		native: null,
		registryKey: taskId,
		nativeAttaching: false,
		nativeRecovering: false,
		nativeStream: null,
		nativeLease: null,
		clients: new Set(),
		tmuxSocket,
		tmuxSessionName,
		sessionType,
		lastOutputTime: Date.now(),
		idleNotified: false,
		decoder: new TextDecoder("utf-8", { fatal: false }),
		pendingData: "",
		batchTimer: null,
		configureTimer: null,
		osc52Buffer: "",
	};
	sessions.set(taskId, session);
	// Spawn immediately in the background — don't wait for WS connection
	try {
		spawnPty(session, 220, 50);
	} catch (err) {
		// A session that never spawned must not look recoverable/alive to callers.
		// Propagate the launch failure so task preparation can revert to To Do and
		// surface the actual cause instead of silently emitting only `ptyDied`.
		sessions.delete(taskId);
		throw err;
	}
}

/** Feed one chunk of PTY bytes through the same pipeline both backends share. */
function ingestPtyOutput(session: PtySession, data: string | Uint8Array): void {
	const str = typeof data === "string" ? data : session.decoder.decode(data, { stream: true });
	session.lastOutputTime = Date.now();
	session.idleNotified = false;
	const cleaned = handleOsc52(str, session);
	checkForBell(cleaned, session.taskId);
	if (!cleaned) return;
	// A native session always enqueues: the batch lands in its bounded journal even
	// with no viewer attached, which is what lets a remote tab attach to a running
	// shell and see the screen. tmux replays its own pane, so it stays as it was.
	if (session.backend === "native" || session.clients.size > 0) enqueuePtyData(session, cleaned);
}

/** One death path for both create and reattach, so their bookkeeping cannot drift. */
function markNativeClosed(session: PtySession): void {
	session.native = null;
	session.appliedCols = undefined;
	session.appliedRows = undefined;
	log.info("Native PTY session closed", { taskId: shortId(session.taskId) });
	onPtyDiedCallback?.(session.taskId);
}

/**
 * True while a native session is being created or reattached. Callers that probe
 * the backend for liveness must treat this as alive: the host has not written its
 * record yet, so a probe would report "gone" and tear down a session that is
 * still coming up — and the relaunch that follows would race the real one.
 */
export function isNativeSessionSettling(taskId: string): boolean {
	return sessions.get(taskId)?.nativeAttaching === true;
}

/**
 * Create the task's PRIMARY terminal on the native backend.
 *
 * Deliberately not a branch inside {@link createSession}: this path creates no
 * tmux session, never probes one, and takes a structured launch instead of a
 * shell string, so keeping it separate makes "tmux was not involved" checkable by
 * reading the call sites. Only a task marked `terminalBackend: "native"` reaches
 * it (see `task-terminal-backend.ts`).
 */
export async function createNativeTaskSession(
	taskId: string,
	projectId: string,
	cwd: string,
	launch: TerminalLaunchSpec,
	extraEnv: Record<string, string> = {},
	size: { cols: number; rows: number } = { cols: 220, rows: 50 },
): Promise<void> {
	log.info("Creating native PTY session", {
		taskId: taskId.slice(0, 8),
		cwd,
		executable: launch.executable,
		argv: launch.argv.length,
	});
	const session: PtySession = {
		taskId,
		projectId,
		cwd,
		tmuxCommand: "",
		env: extraEnv,
		backend: "native",
		proc: null,
		native: null,
		registryKey: taskId,
		nativeAttaching: false,
		nativeRecovering: false,
		nativeStream: new NativeBridgeJournal(),
		nativeLease: new NativeClientLease(),
		clients: new Set(),
		tmuxSocket: "",
		tmuxSessionName: "",
		sessionType: "task",
		lastOutputTime: Date.now(),
		idleNotified: false,
		decoder: new TextDecoder("utf-8", { fatal: false }),
		pendingData: "",
		batchTimer: null,
		configureTimer: null,
		osc52Buffer: "",
		appliedCols: size.cols,
		appliedRows: size.rows,
	};
	session.nativeAttaching = true;
	sessions.set(taskId, session);
	try {
		const env = Object.fromEntries(
			Object.entries(extraEnv).filter(([, value]) => value !== ENV_UNSET),
		);
		const panesState = await startNativeTaskPanes({
			taskId,
			cwd,
			env,
			launch,
			cols: size.cols,
			rows: size.rows,
		});
		// Bind pane-1 under the bare taskId key (all existing paths stay unchanged).
		const firstPane = panesState.panes[0];
		if (!firstPane) throw new Error("coordinator created zero panes");
		session.native = await bindNativeTaskPane(
			firstPane.sessionId,
			{
				onOutput: (bytes) => ingestPtyOutput(session, bytes),
				onClosed: () => markNativeClosed(session),
				onRoleChange: () => broadcastNativeRoles(session),
				onGeometry: (size) => applyNativeGeometry(session, size),
			},
			firstPane.paneId,
		);
		if (!session.native) throw new Error(`pane ${firstPane.paneId} vanished right after creation`);
	} catch (err) {
		sessions.delete(taskId);
		// Anything that failed AFTER the coordinator spawned panes would otherwise leak
		// a detached host and shell that no caller has a handle to: this function either
		// returns a bound session or leaves nothing running (seq 1407).
		await stopNativeTaskPanes(taskId).catch((cleanupErr) =>
			log.error("Native session rollback failed — a host may have leaked", {
				taskId: taskId.slice(0, 8),
				error: String(cleanupErr),
			}),
		);
		throw err;
	} finally {
		session.nativeAttaching = false;
	}
	log.info("Native PTY session ready", {
		taskId: shortId(taskId),
		hostPid: session.native.hostPid,
		shellPid: session.native.shellPid,
	});
}

/**
 * Rebind a native session that this app process did not create — the app
 * restarted while the host and shell kept running. Returns false when there is
 * no owned session to reattach to; never spawns a replacement.
 */
export async function reattachNativeTaskSession(taskId: string, projectId: string, cwd: string): Promise<boolean> {
	const existing = sessions.get(taskId);
	if (existing?.native) return true;
	const session: PtySession = existing ?? {
		taskId,
		projectId,
		cwd,
		tmuxCommand: "",
		env: {},
		backend: "native",
		proc: null,
		native: null,
		registryKey: taskId,
		nativeAttaching: false,
		nativeRecovering: false,
		nativeStream: new NativeBridgeJournal(),
		nativeLease: new NativeClientLease(),
		clients: new Set(),
		tmuxSocket: "",
		tmuxSessionName: "",
		sessionType: "task",
		lastOutputTime: Date.now(),
		idleNotified: false,
		decoder: new TextDecoder("utf-8", { fatal: false }),
		pendingData: "",
		batchTimer: null,
		configureTimer: null,
		osc52Buffer: "",
	};
	if (session.nativeAttaching) return true;
	session.nativeAttaching = true;
	sessions.set(taskId, session);
	try {
		const panesState = await recoverNativeTaskPanes(taskId);
		if (!panesState) {
			if (!existing) sessions.delete(taskId);
			return false;
		}
		const firstPane = panesState.panes[0];
		if (!firstPane) {
			if (!existing) sessions.delete(taskId);
			return false;
		}
		const native = await bindNativeTaskPane(
			firstPane.sessionId,
			{
				onOutput: (bytes) => ingestPtyOutput(session, bytes),
				onClosed: () => markNativeClosed(session),
				onRoleChange: () => broadcastNativeRoles(session),
				onGeometry: (size) => applyNativeGeometry(session, size),
			},
			firstPane.paneId,
		);
		if (!native) {
			if (!existing) sessions.delete(taskId);
			return false;
		}
		// The session may have been torn down while we were attaching.
		if (sessions.get(taskId) !== session) {
			native.detach();
			log.info("Native reattach landed on a torn-down session; released the client", {
				taskId: shortId(taskId),
			});
			return false;
		}
		session.native = native;
		applyClientSizes(session);
		// The host has now ruled on who may type; viewers attached during the bind
		// were told the optimistic role and need the real one.
		broadcastNativeRoles(session);
		return true;
	} finally {
		session.nativeAttaching = false;
	}
}

/**
 * Register (or reuse) a PtySession for a NON-first native pane under its
 * composite key (`${taskId}~${paneId}`). Each additional pane gets its own
 * NativeBridgeJournal and NativeClientLease so writer isolation holds per-pane.
 * The task's pane set must already be live (created or recovered) before calling.
 */
export async function ensureNativePanePtySession(
	taskId: string,
	paneId: string,
	paneSessionId: string,
	projectId: string,
	cwd: string,
): Promise<void> {
	const key = paneSessionKey(taskId, paneId);
	const existing = sessions.get(key);
	if (existing) return; // already registered

	const session: PtySession = {
		taskId,
		projectId,
		cwd,
		tmuxCommand: "",
		env: {},
		backend: "native",
		proc: null,
		native: null,
		registryKey: key,
		nativeAttaching: false,
		nativeRecovering: false,
		nativeStream: new NativeBridgeJournal(),
		nativeLease: new NativeClientLease(),
		clients: new Set(),
		tmuxSocket: "",
		tmuxSessionName: "",
		sessionType: "task",
		lastOutputTime: Date.now(),
		idleNotified: false,
		decoder: new TextDecoder("utf-8", { fatal: false }),
		pendingData: "",
		batchTimer: null,
		configureTimer: null,
		osc52Buffer: "",
	};
	session.nativeAttaching = true;
	sessions.set(key, session);
	try {
		session.native = await bindNativeTaskPane(
			paneSessionId,
			{
				onOutput: (bytes) => ingestPtyOutput(session, bytes),
				onRoleChange: () => broadcastNativeRoles(session),
				onGeometry: (size) => applyNativeGeometry(session, size),
				onClosed: () => {
					session.native = null;
					session.appliedCols = undefined;
					session.appliedRows = undefined;
					log.info("Native pane session closed", { taskId: shortId(taskId), paneId });
					// Fire ptyDied only for the FIRST pane (bare key) — additional panes
					// closing don't signal task death.
				},
			},
			paneId,
		);
		if (!session.native) sessions.delete(key);
		else broadcastNativeRoles(session);
	} finally {
		session.nativeAttaching = false;
	}
}

export function destroySession(taskId: string, fallbackSocket?: string): void {
	const session = sessions.get(taskId);

	// A native session owns a host + shell tree instead of a tmux session; tearing
	// it down must not touch tmux at all, and must leave every other session alone.
	if (session?.backend === "native") {
		destroyNativeSession(session);
		return;
	}

	const socket = session?.tmuxSocket ?? fallbackSocket ?? DEFAULT_TMUX_SOCKET;

	log.info("Destroying PTY session", {
		taskId: taskId.slice(0, 8),
		hasPid: !!session?.proc,
		inMap: !!session,
		socket,
	});

	const tmuxSessionName = session?.tmuxSessionName ?? computeTmuxSessionName(taskId, "task");

	// Clean up local state synchronously FIRST so callers (e.g. hasSession,
	// reconnect logic) see a consistent empty slot immediately. The tmux
	// server cleanup happens in the background — blocking the event loop on
	// `tmux kill-session` was the cause of UI freezes when moving tasks to
	// done (see fix/dev3-unblock-task-lifecycle).
	if (session) {
		if (session.batchTimer) {
			clearTimeout(session.batchTimer);
			session.batchTimer = null;
		}
		if (session.configureTimer) {
			clearTimeout(session.configureTimer);
			session.configureTimer = null;
		}
		session.pendingData = "";
		if (session.proc) {
			session.proc.terminal?.close();
			session.proc.kill();
		}
		for (const client of session.clients) {
			try {
				client.close();
			} catch {
				// already closed
			}
		}
		session.clients.clear();
		sessions.delete(taskId);
	}

	// Kill the tmux session asynchronously — proc.kill() above only closes
	// our attached client; the tmux server keeps the session alive until
	// `kill-session` lands. Fire-and-forget with logging.
	tmux.killSession(tmuxSessionName, { socket })
		.then(() => {
			log.info("tmux kill-session succeeded", { taskId: taskId.slice(0, 8), tmuxSessionName });
		})
		.catch((err) => {
			if (err instanceof TmuxError) {
				log.warn("tmux kill-session exited non-zero", {
					taskId: taskId.slice(0, 8),
					exitCode: err.exitCode,
					stderr: err.stderr,
				});
			} else {
				log.warn("tmux kill-session spawn failed (best-effort)", {
					taskId: taskId.slice(0, 8),
					error: String(err),
				});
			}
		});
}

/** Drop OUR side of a native session: timers, writer client, renderer clients. */
function releaseNativeSession(session: PtySession): void {
	log.info("Destroying native PTY session", {
		taskId: shortId(session.taskId),
		attached: !!session.native,
	});
	if (session.batchTimer) {
		clearTimeout(session.batchTimer);
		session.batchTimer = null;
	}
	session.pendingData = "";
	session.native?.detach();
	session.native = null;
	for (const client of session.clients) {
		try {
			client.close();
		} catch {
			// already closed
		}
	}
	session.clients.clear();
	sessions.delete(session.taskId);
	// Release all composite-keyed PtySession entries for additional panes of this task.
	sweepNativePaneSessions(session.taskId);
}

/** Remove all composite-keyed PtySession entries for non-first panes of a task. */
function sweepNativePaneSessions(taskId: string): void {
	for (const [key, s] of sessions) {
		const parsed = parsePaneSessionKey(key);
		if (parsed?.taskId === taskId) {
			if (s.batchTimer) clearTimeout(s.batchTimer);
			s.pendingData = "";
			s.native?.detach();
			s.native = null;
			for (const client of s.clients) {
				try { client.close(); } catch { /* already closed */ }
			}
			s.clients.clear();
			sessions.delete(key);
		}
	}
}

/** Tear down a native session's own tree — never tmux, never a sibling session. */
function destroyNativeSession(session: PtySession): Promise<void> {
	releaseNativeSession(session);
	// Stopping the host tree is I/O; like tmux kill-session it must not block the
	// lifecycle event loop. Callers that relaunch the same task await the outcome
	// via destroySessionAwaited instead.
	return stopNativeTaskPanes(session.taskId).catch((err) => {
		log.warn("Native session teardown failed (best-effort)", {
			taskId: shortId(session.taskId),
			error: String(err),
		});
	});
}

/**
 * Tear down a task's native session and WAIT for its owned tree, even when this
 * app process never attached to it (an app restart between launch and
 * completion). Routed by the task's persisted identity, so a native task never
 * reaches the tmux teardown path.
 *
 * Our own client state is released immediately, but the promise settles only once
 * the host/shell/descendant tree is verified gone: the lifecycle must not run a
 * cleanup script or remove the worktree under a still-live process tree. An
 * unconfirmed teardown rejects; a missing or already-stopped session is a success
 * that spawns and adopts nothing, so retries stay idempotent.
 */
export async function destroyNativeTaskSession(taskId: string): Promise<void> {
	const session = sessions.get(taskId);
	if (session?.backend === "native") {
		releaseNativeSession(session);
	} else if (session) {
		// The record says native but memory holds a tmux session — an inconsistent
		// state we tear down on BOTH sides rather than leaving half a session behind.
		log.warn("Native teardown found a tmux session in memory; tearing down both", {
			taskId: shortId(taskId),
		});
		destroySession(taskId);
	} else {
		log.info("Destroying unattached native session", { taskId: shortId(taskId) });
		sweepNativePaneSessions(taskId);
	}
	await stopNativeTaskPanes(taskId);
}

/**
 * Destroy a session and, for the native backend, WAIT until its owned tree is
 * gone. Relaunching a native task must not race its own teardown: the session id
 * is deterministic, so a still-dying host would make the fresh `openSession` fail
 * with `session-exists`. The tmux path keeps its exact fire-and-forget timing.
 */
export async function destroySessionAwaited(taskId: string, fallbackSocket?: string): Promise<void> {
	const session = sessions.get(taskId);
	if (session?.backend !== "native") {
		destroySession(taskId, fallbackSocket);
		return;
	}
	releaseNativeSession(session);
	// Unconfirmed teardown propagates on purpose: the caller is about to relaunch
	// this exact session id, and failing here beats a confusing `session-exists`.
	await stopNativeTaskPanes(taskId);
}

export function hasSession(taskId: string): boolean {
	return sessions.has(taskId);
}

/**
 * This process's live binding to one native pane, or null when it holds none.
 *
 * A binding is NOT permission to write — the host grants the writer lease to a
 * single client across all app processes. Pass the result to
 * `resolvePaneOwner` (native-pane-owner.ts) before delivering anything.
 *
 * The task's first pane lives under the bare task key and the rest under
 * composite keys, so both are checked and the pane identity is verified rather
 * than assumed from the key.
 */
export function nativePaneTerminal(taskId: string, paneId?: string): NativeTaskTerminal | null {
	const keys = paneId ? [paneSessionKey(taskId, paneId), taskId] : [taskId];
	for (const key of keys) {
		const session = sessions.get(key);
		if (session?.backend !== "native" || !session.native) continue;
		if (paneId && session.native.paneId !== paneId) continue;
		return session.native;
	}
	return null;
}

/** Which backend owns a registered session, or null when there is none. */
export function getSessionBackend(taskId: string): TerminalBackendIdentity | null {
	return sessions.get(taskId)?.backend ?? null;
}

/** Returns true if the session is registered but its shell is gone. */
export function hasDeadSession(taskId: string): boolean {
	const session = sessions.get(taskId);
	if (!session) return false;
	if (session.backend === "native") return session.native === null && !session.nativeAttaching;
	return session.proc === null;
}

export async function capturePane(taskId: string): Promise<string | null> {
	const session = sessions.get(taskId);
	// A native session has no tmux pane to capture; callers already treat null as
	// "no capture available".
	if (session?.backend === "native") return null;
	const socket = session?.tmuxSocket ?? DEFAULT_TMUX_SOCKET;
	const tmuxSessionName = session?.tmuxSessionName ?? computeTmuxSessionName(taskId, "task");
	try {
		const stdout = await tmux.capturePane({ target: tmuxSessionName, escapes: true, socket });
		if (stdout.length > 0) {
			return stdout;
		}
	} catch {
		// Non-critical
	}
	return null;
}

export function getSessionProjectId(taskId: string): string | null {
	return sessions.get(taskId)?.projectId ?? null;
}

export function getSessionSocket(taskId: string): string {
	return sessions.get(taskId)?.tmuxSocket ?? DEFAULT_TMUX_SOCKET;
}

export function getPtyPort(): number {
	return ptyWsPort;
}

/** Returns active session info for port scanning. */
export function getActiveSessionIds(): Array<{ taskId: string; tmuxSocket: string }> {
	const result: Array<{ taskId: string; tmuxSocket: string }> = [];
	for (const session of sessions.values()) {
		if (session.proc) {
			result.push({ taskId: session.taskId, tmuxSocket: session.tmuxSocket });
		}
	}
	return result;
}

export function getSessionTmuxName(key: string): string {
	return sessions.get(key)?.tmuxSessionName ?? computeTmuxSessionName(key, "task");
}

export function getSessionType(key: string): PtySessionType | null {
	return sessions.get(key)?.sessionType ?? null;
}

function shortId(taskId: string): string {
	return taskId.slice(0, 8);
}

/**
 * Which pane a WS session key belongs to. `shortId` truncates a composite key to
 * its task prefix, so a line carrying only `taskId` cannot tell two panes of one
 * task apart — which is what made a connect/disconnect imbalance unreadable in the
 * logs (seq 1407). Log it next to the task id on every native viewer transition.
 */
function paneIdOfSessionKey(key: string): string {
	return parsePaneSessionKey(key)?.paneId ?? "pane-1";
}

// ── Pane helpers ─────────────────────────────────────────────────────

/**
 * Create an additional pane in an existing tmux session by splitting, and run a command in it.
 * Returns the new pane ID, or null on failure.
 */
export async function splitAndRunCommand(taskId: string, socket: string, command: string, cwd: string): Promise<string | null> {
	const tmuxSessionName = taskSessionName(taskId);
	try {
		const { paneId } = await tmux.splitWindow({
			target: tmuxSessionName,
			orientation: "vertical",
			cwd,
			printPaneId: true,
			command,
			socket,
		});
		await tmux.selectLayout(tmuxSessionName, "tiled", { socket, bestEffort: true });
		return paneId;
	} catch (err) {
		if (err instanceof TmuxError) {
			log.warn("splitAndRunCommand failed", { taskId: shortId(taskId), exitCode: err.exitCode });
		} else {
			log.warn("splitAndRunCommand error", { taskId: shortId(taskId), error: String(err) });
		}
		return null;
	}
}

/**
 * List all pane IDs in a tmux session.
 * Returns an array of pane IDs (e.g. ["%0", "%5"]), or empty on failure / session gone.
 */
export async function listPaneIds(taskId: string, socket: string = DEFAULT_TMUX_SOCKET): Promise<string[]> {
	const tmuxSessionName = computeTmuxSessionName(taskId, "task");
	try {
		const rows = await tmux.listPanes(PANE_ID_FORMAT, { target: tmuxSessionName, socket });
		return rows.map((row) => row.paneId).filter(Boolean);
	} catch {
		return [];
	}
}

/**
 * Snapshot the tmux layout for a task's session: its windows and every pane's
 * geometry/command. Used by `dev3 ui state` to render an ASCII map for agents
 * and by the narrow-viewport pane-map sheet. Pane geometry comes from each
 * window's zoom-independent `window_layout` (see {@link parseWindowLayout}), so
 * the map stays correct even while the carousel keeps the window zoomed.
 * Returns `exists: false` (empty windows/panes) when the session is gone.
 */
export async function getTmuxLayout(taskId: string, socket: string = DEFAULT_TMUX_SOCKET): Promise<TmuxLayout> {
	const sessionName = computeTmuxSessionName(taskId, "task");
	const empty: TmuxLayout = { sessionName, exists: false, windows: [], panes: [] };

	// Per-window true geometry, keyed by pane id — used to override the zoom-
	// collapsed per-pane fields below.
	const geomByWindow = new Map<number, ReturnType<typeof parseWindowLayout>>();
	let windows: TmuxWindowInfo[];
	try {
		const windowRows = await tmux.listWindows(WINDOW_OVERVIEW_FORMAT, { target: sessionName, socket });
		windows = windowRows.map((row) => {
			geomByWindow.set(row.index, parseWindowLayout(row.layout));
			return {
				index: row.index,
				name: row.name,
				active: row.active,
				panes: row.panes,
				zoomed: row.zoomed,
			};
		});
	} catch {
		return empty;
	}

	let panes: TmuxPaneInfo[] = [];
	try {
		const paneRows = await tmux.listPanes(PANE_GEOMETRY_FORMAT, { target: sessionName, scope: "session", socket });
		panes = paneRows.map((row) => {
			// Prefer the zoom-independent layout geometry; fall back to the per-pane
			// fields if the layout could not be parsed for this pane.
			const geom = geomByWindow.get(row.windowIndex)?.get(row.paneId);
			return {
				windowIndex: row.windowIndex,
				paneId: row.paneId,
				active: row.active,
				left: geom?.left ?? row.left,
				top: geom?.top ?? row.top,
				width: geom?.width ?? row.width,
				height: geom?.height ?? row.height,
				command: row.command,
				title: row.title,
			};
		});
	} catch {
		panes = [];
	}

	// Status-bar reservation: pane geometry above is the WINDOW (excludes the tmux
	// status bar), but the rendered canvas includes it. Measure the reserved rows so
	// the frontend overlay can line up vertically. `client_height - window_height`
	// is the total reserved rows (robust to multi-line status); fall back to the
	// `status` option (off → 0, numeric → that many, on → 1) when no client is
	// attached to read a height from.
	let statusLines = 0;
	let statusAtTop = false;
	try {
		const status = await tmux.displayMessage(STATUS_GEOMETRY_FORMAT, { target: sessionName, socket });
		if (status) {
			statusAtTop = status.statusPosition.trim() === "top";
			const statusOpt = status.status.trim();
			if (statusOpt === "off") {
				statusLines = 0;
			} else if (status.clientHeight > status.windowHeight) {
				statusLines = status.clientHeight - status.windowHeight;
			} else {
				const n = Number(statusOpt);
				statusLines = Number.isFinite(n) && n > 0 ? n : 1;
			}
		}
	} catch {
		// Session vanished mid-read — keep the zero status reservation.
	}

	return { sessionName, exists: windows.length > 0, windows, panes, statusLines, statusAtTop };
}

/**
 * Check if a tmux session exists on the given socket.
 */
export async function tmuxSessionExists(taskId: string, socket: string = DEFAULT_TMUX_SOCKET): Promise<boolean> {
	const tmuxSessionName = computeTmuxSessionName(taskId, "task");
	try {
		return await tmux.hasSession(tmuxSessionName, { socket });
	} catch {
		return false;
	}
}

const OSC52_PREFIX = "\x1b]52;";
const OSC52_RE = /^\x1b\]52;[^;]*;([A-Za-z0-9+/=]*|\?)(?:\x07|\x1b\\)$/;
// Matches any OSC sequence terminated by BEL or ST — used to strip them
// before checking for standalone BEL (\x07)
const OSC_ANY_RE = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;

function findOscTerminator(data: string, start: number): { index: number; length: number } | null {
	const bel = data.indexOf("\x07", start);
	const st = data.indexOf("\x1b\\", start);
	if (bel === -1 && st === -1) return null;
	if (bel !== -1 && (st === -1 || bel < st)) return { index: bel, length: 1 };
	return { index: st, length: 2 };
}

function trailingOsc52PrefixLength(data: string): number {
	const max = Math.min(OSC52_PREFIX.length - 1, data.length);
	for (let len = max; len > 0; len--) {
		if (data.endsWith(OSC52_PREFIX.slice(0, len))) return len;
	}
	return 0;
}

function emitOsc52(seq: string, taskId: string): void {
	const match = OSC52_RE.exec(seq);
	const b64 = match?.[1];
	if (!b64 || b64 === "?") return;
	try {
		const text = Buffer.from(b64, "base64").toString("utf-8");
		onOsc52CopyCallback?.({ taskId, text, len: text.length });
		log.info("OSC 52: forwarded clipboard payload to client", {
			taskId: shortId(taskId),
			len: text.length,
		});
	} catch {
		// ignore malformed clipboard payloads
	}
}

function handleOsc52(data: string, session: PtySession): string {
	let input = session.osc52Buffer + data;
	session.osc52Buffer = "";
	let output = "";

	while (input.length > 0) {
		const start = input.indexOf(OSC52_PREFIX);
		if (start === -1) {
			const trailing = trailingOsc52PrefixLength(input);
			if (trailing > 0) {
				output += input.slice(0, -trailing);
				session.osc52Buffer = input.slice(-trailing);
			} else {
				output += input;
			}
			break;
		}

		output += input.slice(0, start);
		const terminator = findOscTerminator(input, start + OSC52_PREFIX.length);
		if (!terminator) {
			session.osc52Buffer = input.slice(start);
			break;
		}

		const end = terminator.index + terminator.length;
		emitOsc52(input.slice(start, end), session.taskId);
		input = input.slice(end);
	}

	return output;
}

function checkForBell(data: string, taskId: string): void {
	// Strip all OSC sequences (they use \x07 as terminator, not as bell)
	const withoutOsc = data.replace(OSC_ANY_RE, "");
	if (withoutOsc.includes("\x07")) {
		log.info("BEL detected in PTY data stream", { taskId: taskId.slice(0, 8) });
		onBellCallback?.(taskId);
	}
}

/**
 * Resize the single shared PTY to the SMALLEST size requested across all
 * currently connected clients.
 *
 * One PTY (one tmux attach client) is shared by every viewer of a session —
 * multiple app windows on the same task, plus any remote/browser clients. The
 * PTY can only be one size, so if two windows of different sizes each sent
 * their own size we'd flip-flop (last write wins) and every window except the
 * most recent one would render against the wrong geometry.
 *
 * Instead we clamp to the min cols and min rows independently — exactly how
 * tmux negotiates a session shared by multiple real clients. The smallest
 * viewer gets a perfect fit; larger viewers letterbox the content (blank
 * margin on the right / bottom) which is the correct, stable behaviour.
 *
 * Each client's last requested size lives on the WS object (`ptyCols`/
 * `ptyRows`); clients that haven't reported a size yet are ignored so a
 * freshly-connected window doesn't shrink everyone to the 80x24 default before
 * its real size arrives.
 */
/**
 * The session's live write/resize surface, whichever backend owns it. Both are
 * the SAME shape on purpose: the WebSocket bridge, geometry negotiation, and
 * batching above this line stay backend-agnostic.
 */
function sessionShell(session: PtySession): { write(data: string): void; resize(cols: number, rows: number): void } | null {
	if (session.backend === "native") {
		const native = session.native;
		return native ? { write: (data) => native.write(data), resize: (cols, rows) => native.resize(cols, rows) } : null;
	}
	const term = session.proc?.terminal as { write(data: string): void; resize(cols: number, rows: number): void } | undefined;
	return term ?? null;
}

function sendToClient(client: any, text: string): void {
	try {
		client.sendText(text);
	} catch {
		// dead client — dropped on its close event
	}
}

/**
 * Hand a newly connected viewer its role and the screen, before it joins the
 * live broadcast. `since` is the watermark it last applied (null on a first
 * attach), so a reconnect replays only the missing tail; a watermark that fell
 * off the bounded journal is answered with the whole tail and an explicit reset
 * rather than a silently corrupt screen.
 */
/**
 * The role a viewer really has: our own lease decides which of THIS app's
 * viewers may type, but the host decides whether this app process may type at
 * all. Another dev3 instance holding the lease makes every local viewer an
 * observer, and saying otherwise produces a terminal that looks live and
 * silently eats keystrokes.
 */
/**
 * What the host granted THIS app process, or null while that is not yet known —
 * no binding, or a binding that predates the role being reported. Callers stay
 * optimistic on null: the usual case is that we own the pane, and every viewer
 * is corrected by broadcastNativeRoles once the bind lands. Forcing "read-only"
 * on an unknown would flash the strip on every launch.
 */
function nativeHostRole(session: PtySession): NativeStreamRole | null {
	const native = session.native;
	if (!native || typeof native.hostRole !== "function") return null;
	return native.hostRole();
}

function effectiveNativeRole(session: PtySession, ws: any): NativeStreamRole {
	const lease = session.nativeLease;
	if (!lease) return "observer";
	if (lease.roleOf(ws) !== "writer") return "observer";
	// Recovery is never optimistic: the binding is being replaced, so no viewer may be
	// told it can type until authoritative state is back.
	if (session.nativeRecovering) return "observer";
	const hostRole = nativeHostRole(session);
	if (hostRole === "writer") return "writer";
	// `null` means two opposite things and must not be collapsed. While a bind is in
	// FLIGHT it means "not known yet", and optimism avoids flashing the strip on every
	// launch (decision 191). Once no bind is pending it means "no binding at all" — a
	// detached or dead host — and claiming `writer` there promises a shell that is gone.
	if (hostRole === null) return session.nativeAttaching ? "writer" : "observer";
	return "observer";
}

/**
 * The PTY's current size, which an observer renders at instead of its own —
 * the bytes are laid out for the writer's width, so reflowing them locally
 * mangles every line that reaches the right edge.
 */
function nativePtyGeometry(session: PtySession): { cols?: number; rows?: number; writerAttached?: boolean } {
	const attached = session.native?.hostWriterAttached?.();
	// Whose number is the truth depends on who owns the lease. We own it → our applied
	// size IS the PTY's, and the host's cache may lag our newest resize because the host
	// skips the sender when it broadcasts. We do NOT own it → the resize happened in
	// another process, so only the host's number is real; `appliedCols` here is just
	// whatever our own local viewer asked for and would reflow the stream at our width.
	const host = session.native?.hostPtyGeometry?.();
	const ownsLease = nativeHostRole(session) === "writer";
	const cols = (ownsLease ? session.appliedCols ?? host?.cols : host?.cols ?? session.appliedCols);
	const rows = (ownsLease ? session.appliedRows ?? host?.rows : host?.rows ?? session.appliedRows);
	return {
		...(cols && rows ? { cols, rows } : {}),
		...(typeof attached === "boolean" ? { writerAttached: attached } : {}),
	};
}

/**
 * The writer — in this process or another one — published a new canonical grid.
 * Every local viewer has to be told: an observer renders AT that grid, and a stale
 * one wraps every line the writer's bytes push past its own right edge.
 */
function applyNativeGeometry(session: PtySession, size: { cols: number; rows: number }): void {
	if (session.appliedCols === size.cols && session.appliedRows === size.rows) return;
	session.appliedCols = size.cols;
	session.appliedRows = size.rows;
	broadcastNativeRoles(session);
}

/** Re-issue every viewer's role after the host's verdict becomes known. */
function broadcastNativeRoles(session: PtySession): void {
	const extra = nativePtyGeometry(session);
	for (const client of session.clients) {
		sendToClient(client, roleMessage(effectiveNativeRole(session, client), false, extra));
	}
}

function attachNativeClient(session: PtySession, ws: any, since: number | null): void {
	const journal = session.nativeStream;
	const lease = session.nativeLease;
	if (!journal || !lease) return;
	settleNativeStream(session);
	lease.attach(ws);
	const role = effectiveNativeRole(session, ws);
	const replay = journal.replayFrom(since);
	// sessionId always identifies the TASK coordinator (no -pane-N suffix);
	// paneId carries the logical pane identity so callers can distinguish panes.
	const sessionId = nativeTaskSessionId(session.taskId);
	sendToClient(
		ws,
		attachMessage(
			{
				seq: replay.seq,
				role,
				sessionId,
				paneId: session.native?.paneId ?? "pane-1",
				hostPid: session.native?.hostPid ?? -1,
				shellPid: session.native?.shellPid ?? -1,
				resumed: replay.resumed,
				...(replay.reset ? { reset: replay.reset } : {}),
				...nativePtyGeometry(session),
			},
			replay.data,
		),
	);
	log.info("Native viewer attached", {
		taskId: shortId(session.taskId),
		paneId: session.native?.paneId ?? "pane-1",
		sessionId,
		role,
		since,
		seq: replay.seq,
		resumed: replay.resumed,
		reset: replay.reset ?? "none",
		viewers: lease.size,
	});
}

/** Move the writer lease between viewers and tell both sides, in one step. */
function handleNativeOwnership(session: PtySession, ws: any, action: "claim" | "release", hostSettled = false): void {
	const lease = session.nativeLease;
	if (!lease) return;
	// Taking control inside this app is worthless while the host's lease belongs to
	// another dev3 process, so move that one first. `Take control` is an explicit
	// user gesture, so it TAKES OVER rather than claiming a vacant slot: the host
	// swaps the lease atomically and tells the displaced process it is now an
	// observer. Ordinary attachment still only claims, and so never steals.
	// EVERY explicit gesture asks the host — even when our own cache says we are already
	// the writer. That cache can be stale (another process may have taken the lease and
	// our demotion frame may still be in flight), and skipping the request would make an
	// explicit click silently do nothing. The host's takeover is idempotent for the true
	// current writer, so asking always is free.
	if (action === "claim" && !hostSettled && session.native?.takeoverHostWriter) {
		const paneKey = nativePaneKey(session);
		if (nativeTakeoverInFlight.has(paneKey)) {
			log.debug("A host takeover is already in flight for this pane; not starting another", {
				taskId: shortId(session.taskId),
			});
			return;
		}
		nativeTakeoverInFlight.add(paneKey);
		// The key is released only AFTER the continuation finishes. Releasing it first (a
		// `.finally` chained BEFORE `.then`) would let the continuation re-enter and the
		// bound would be no bound at all.
		void session.native.takeoverHostWriter().then(async (result) => {
			// Branch on the DISCRIMINANT, never on a role: a cached role can say `writer`
			// while the host has already moved the lease, which read as success and skipped
			// compensation altogether.
			if (!result.ok) {
				log.warn("Take control did not transfer the host lease", {
					taskId: shortId(session.taskId),
					reason: result.refusal,
				});
				// A TIMEOUT is ambiguous in a way a refusal is not: the host may still commit
				// the takeover after we gave up. Compensation is AWAITED, so the pane's
				// in-flight guard is still held while it releases, detaches and rebinds —
				// otherwise a second gesture could overlap the recovery. The refusal is
				// published by compensation's final verdict, not before it.
				if (result.timedOut) {
					await compensateHostOwnership(session, "request-timed-out", ws, result.refusal);
					return;
				}
				if (session.clients.has(ws)) {
					sendToClient(ws, roleMessage("observer", true, { refusedReason: result.refusal }));
				}
				return;
			}
			// The host round trip is async, so the viewer that asked may have closed its
			// tab meanwhile. We now hold the host lease on its behalf: giving it to a
			// detached socket would leave every surviving viewer a local observer with the
			// lease stranded in this process, and nobody able to type anywhere.
			// `hostSettled` — the host lease is already ours, so this pass only moves the
			// LOCAL lease. Without it the continuation re-enters this same branch and asks
			// the host again forever, never reaching the local move.
			if (session.clients.has(ws)) {
				handleNativeOwnership(session, ws, "claim", true);
				// A vacant-slot takeover changes `writerAttached` for everyone without changing
				// anyone's role, so a role-change-driven publish reaches nobody and other local
				// viewers keep showing the slot as free. Publish the full snapshot to ALL of them
				// after every settlement, not only to the requester.
				broadcastNativeRoles(session);
				return;
			}
			const survivor = session.clients.values().next().value;
			if (survivor) {
				log.info("Take control requester left; handing the lease to a surviving viewer", {
					taskId: shortId(session.taskId),
				});
				promoteLocalWriter(session, survivor);
				return;
			}
			// Nobody left to receive it: hand it back rather than hold a lease this process
			// cannot use, which locks every other dev3 window out. Awaited, so the pane's
			// in-flight guard covers release, detach and rebind and no second gesture overlaps.
			await compensateHostOwnership(session, "requester-gone", null);
		}).finally(() => nativeTakeoverInFlight.delete(paneKey));
		return;
	}
	const change = action === "claim" ? lease.claim(ws) : lease.release(ws);
	if (!change) {
		// Already the local writer and now the host writer too: confirm the upgrade.
		if (action === "claim" && effectiveNativeRole(session, ws) === "writer") {
			sendToClient(ws, roleMessage("writer"));
		}
		return;
	}
	if (change.previous) sendToClient(change.previous, roleMessage(effectiveNativeRole(session, change.previous)));
	if (change.writer) sendToClient(change.writer, roleMessage(effectiveNativeRole(session, change.writer)));
	if (action === "release") sendToClient(ws, roleMessage(effectiveNativeRole(session, ws)));
	// The new writer's viewport now owns the PTY geometry.
	applyClientSizes(session);
	log.info("Native writer lease moved", { taskId: shortId(session.taskId), action, viewers: lease.size });
}

/**
 * Give the local lease to `client` and publish the result. Always publishes the
 * EFFECTIVE role: announcing a raw `writer` while this process is only a host observer
 * would tell a viewer it can type when the host will drop everything it sends.
 */
function promoteLocalWriter(session: PtySession, client: any): void {
	session.nativeLease?.claim(client);
	// One FULL snapshot to every viewer: a per-viewer reply would omit `writerAttached` and
	// geometry from the others, leaving them stale about a slot that is no longer free.
	broadcastNativeRoles(session);
	applyClientSizes(session);
}

/**
 * Compensate for an ownership request we can no longer complete honestly.
 *
 * Two entries, one exit: the requester vanished mid-round-trip, or its request timed out
 * while the host may still commit it. Either way this process may hold — or be about to
 * hold — a lease with no viewer able to use it. Holding it locks every other dev3 window
 * out of the pane; guessing is worse, because a late commit would arrive unobserved.
 *
 * The ambiguous connection is closed and immediately REBOUND, so authoritative state is
 * obtained by construction rather than inferred. `retainedContext` is the local viewer
 * that initiated the gesture: if the rebind lands as writer, that success is published to
 * THAT viewer, never silently handed to whoever happens to be first in the lease.
 */
async function compensateHostOwnership(
	session: PtySession,
	reason: "requester-gone" | "request-timed-out",
	retainedContext: any | null,
	/** Told to the retained viewer once recovery settles — never before its verdict. */
	pendingRefusal?: "host-too-old" | "transfer-failed",
): Promise<void> {
	const paneSessionId = session.native?.sessionId ?? null;
	const paneId = session.native?.paneId ?? "pane-1";
	log.info("Compensating an ambiguous host ownership request", {
		taskId: shortId(session.taskId),
		reason,
		hasRetainedContext: retainedContext !== null,
	});

	// DEMOTE FIRST. From here the binding is about to be replaced, so nobody may hold a
	// writer role: input accepted against a doomed connection would vanish silently. A
	// viewer arriving mid-recovery gets the same honest observer snapshot, because
	// `nativeRecovering` blocks the optimistic-writer path in effectiveNativeRole.
	session.nativeRecovering = true;
	session.nativeLease?.release(retainedContext ?? session.clients.values().next().value);
	broadcastNativeRoles(session);

	// A timed-out request is ambiguous whatever our cached role says, so the release is
	// ALWAYS attempted and its outcome decides whether the socket must go.
	const released = await session.native?.releaseHostWriter?.();
	if (released !== false) {
		session.nativeRecovering = false;
		publishCompensationVerdict(session, retainedContext, pendingRefusal);
		return;
	}

	log.warn("Host never confirmed the release; dropping the connection so the lease cannot stay stranded", {
		taskId: shortId(session.taskId),
	});
	try {
		session.native?.detach();
	} catch { /* already gone */ }
	session.native = null;

	// NO viewers left: stop here. Rebinding would re-acquire a lease nobody is watching,
	// which is the hidden ownership acquisition this must not perform.
	if (!paneSessionId || session.clients.size === 0) {
		session.nativeRecovering = false;
		log.info("Compensation finished with no viewers; no rebind and no claim performed", {
			taskId: shortId(session.taskId),
		});
		// A registered session with no binding can never be rebound by a later WS open, so
		// drop it: the next open then rebuilds the session through the normal path.
		if (session.clients.size === 0) {
			// The EXACT registered key: an auxiliary pane lives under `taskId~paneId`, and
			// deleting the bare taskId here would unregister pane 1 while leaving pane 2's
			// dead entry in place.
			sessions.delete(session.registryKey);
			log.info("Dropped the bindingless session so a later viewer rebuilds it", {
				taskId: shortId(session.taskId),
				registryKey: session.registryKey,
			});
		}
		return;
	}

	// Viewers remain, so rebind BEFORE publishing any role — otherwise a viewer would be
	// told `writer` off a null binding, promising a shell that is not there.
	session.nativeAttaching = true;
	try {
		session.native = await bindNativeTaskPane(
			paneSessionId,
			{
				onOutput: (bytes) => ingestPtyOutput(session, bytes),
				onClosed: () => markNativeClosed(session),
				onRoleChange: () => broadcastNativeRoles(session),
				onGeometry: (size) => applyNativeGeometry(session, size),
			},
			paneId,
			// The bridge journal survived the detach, so the host's replay is a duplicate.
			{ discardReplay: true },
		);
	} catch (err) {
		log.error("Rebind after compensation failed; the pane has no binding", {
			taskId: shortId(session.taskId),
			error: String(err),
		});
	} finally {
		session.nativeAttaching = false;
	}

	// Authoritative status, then ONE full snapshot to every viewer. A rebind may have
	// legitimately taken a vacant slot; that success belongs to the viewer that asked for
	// control, never to whoever the local lease happens to point at.
	session.nativeRecovering = false;
	const ownsAfterRebind = session.native?.hostRole?.() === "writer";
	if (ownsAfterRebind && retainedContext && session.clients.has(retainedContext)) {
		promoteLocalWriter(session, retainedContext);
		return;
	}
	publishCompensationVerdict(session, retainedContext, pendingRefusal);
}

/**
 * One snapshot to everyone, and the refusal only now. Publishing it before recovery ran
 * told the viewer why it failed and then immediately cleared that with the next snapshot.
 */
function publishCompensationVerdict(
	session: PtySession,
	retainedContext: any | null,
	pendingRefusal?: "host-too-old" | "transfer-failed",
): void {
	broadcastNativeRoles(session);
	if (!pendingRefusal || !retainedContext || !session.clients.has(retainedContext)) return;
	sendToClient(
		retainedContext,
		roleMessage(effectiveNativeRole(session, retainedContext), true, {
			...nativePtyGeometry(session),
			refusedReason: pendingRefusal,
		}),
	);
}

/** The native writer's last reported viewport, or null while it has not sent one. */
function writerClientSize(session: PtySession): { cols: number; rows: number } | null {
	const writer = session.nativeLease?.writer as { ptyCols?: number; ptyRows?: number } | null | undefined;
	if (!writer?.ptyCols || !writer.ptyRows) return null;
	return { cols: writer.ptyCols, rows: writer.ptyRows };
}

/** The geometry each native pane has asked the host for and not yet heard back on. */
const nativeResizeInFlight = new Map<string, string>();

/**
 * Panes with a host takeover already in flight.
 *
 * The `hostSettled` parameter stops the success continuation re-entering the request, but
 * it is one boolean an edit can drop — and when it was dropped the loop ran at ~12k
 * takeovers/second and buried the log under 540k lines in three minutes. This makes the
 * bound structural: a second gesture for the same pane cannot start another round trip
 * while one is outstanding, which also absorbs a user clicking the button repeatedly.
 */
const nativeTakeoverInFlight = new Set<string>();

/** Identifies a pane INCARNATION, so two panes of one task never share a key. */
function nativePaneKey(session: PtySession): string {
	return `${session.taskId}::${session.native?.sessionId ?? "unbound"}::${session.native?.paneId ?? "pane-1"}`;
}

/** How many takeovers are outstanding — the invariant tests assert on this. */
export function _nativeTakeoversInFlightForTests(): number {
	return nativeTakeoverInFlight.size;
}

function applyClientSizes(session: PtySession): void {
	const term = sessionShell(session);
	if (!term) return;
	// Only the process holding the HOST lease may size the shared PTY. Without this a
	// non-owning process both fired a resize the host refuses AND recorded its own
	// viewer's width in `appliedCols`, which every local viewer then rendered at.
	if (session.backend === "native" && nativeHostRole(session) !== "writer") return;
	// Native: the WRITER alone sizes the PTY. A native host has no client-size
	// negotiation of its own, so clamping to the smallest viewer would let any
	// remote tab (a phone in portrait, say) shrink the writer's shell out from
	// under it. Observers letterbox instead — their zoom stays client-local.
	const target = session.backend === "native"
		? writerClientSize(session)
		: smallestClientSize(
			Array.from(session.clients, (c) => ({ cols: (c as any).ptyCols, rows: (c as any).ptyRows })),
		);
	if (!target) return;
	const { cols: minCols, rows: minRows } = target;

	if (session.appliedCols === minCols && session.appliedRows === minRows) {
		// A native viewer is repainted from the journal on attach, so it never needs
		// the redraw jiggle below — and jiggling would resize a live shell for a
		// client that merely reconnected.
		if (session.backend === "native") return;
		// Target size is unchanged — typically a new, equal-or-larger viewer just
		// connected. tmux does NOT emit a SIGWINCH / redraw for a same-size
		// resize, so that viewer's freshly-mounted blank terminal would never get
		// its initial paint. Force a full redraw with a one-row jiggle (same trick
		// as the WKWebView resize nudge in window-manager.ts).
		try {
			term.resize(minCols, Math.max(1, minRows - 1));
			setTimeout(() => {
				try { term.resize(minCols, minRows); } catch { /* ignore */ }
			}, 16);
		} catch (err) {
			log.debug("applyClientSizes jiggle failed", { error: String(err) });
		}
		return;
	}

	// Native: the host is the authority, and its verdict is asynchronous. Publishing the
	// size we merely ASKED for would broadcast a refused or stale-generation resize as
	// canonical — the exact poisoning the ack exists to prevent. tmux keeps the direct
	// path: it has no ack and resizes synchronously.
	if (session.backend === "native") {
		const native = session.native;
		if (!native?.resizeAwaited) return;
		// The applied size is now written by the ACK callback, so the dedup guard above no
		// longer sees an in-flight request and every repeat would fire another host round
		// trip for a size already on its way. Track the target we are asking for.
		const target = `${minCols}x${minRows}`;
		// Keyed by pane INCARNATION: keying by taskId let two panes of one task collide, so
		// an equal-size resize on the second pane was silently dropped.
		const resizeKey = nativePaneKey(session);
		if (nativeResizeInFlight.get(resizeKey) === target) return;
		nativeResizeInFlight.set(resizeKey, target);
		void native.resizeAwaited(minCols, minRows).then(
			(applied) => {
				if (nativeResizeInFlight.get(resizeKey) === target) nativeResizeInFlight.delete(resizeKey);
				session.appliedCols = applied.cols;
				session.appliedRows = applied.rows;
				broadcastNativeRoles(session);
			},
			(err) => {
				if (nativeResizeInFlight.get(resizeKey) === target) nativeResizeInFlight.delete(resizeKey);
				// Refused or unanswered: the old canonical size stands, and viewers keep
				// rendering at a grid the PTY actually has.
				log.debug("Native resize was not applied; canonical geometry unchanged", {
					taskId: shortId(session.taskId),
					error: String(err),
				});
			},
		);
		return;
	}

	session.appliedCols = minCols;
	session.appliedRows = minRows;
	try {
		term.resize(minCols, minRows);
	} catch (err) {
		log.debug("applyClientSizes resize failed", { error: String(err) });
	}
}

/**
 * Flush accumulated PTY data to all connected WebSocket clients in one batch.
 *
 * A native session records the batch into its bounded journal first and tags the
 * message with the resulting watermark, so a viewer that drops can resume from
 * exactly where it stopped. tmux sessions send the bare text they always have.
 */
function flushPendingData(session: PtySession): void {
	session.batchTimer = null;
	if (!session.pendingData) return;
	if (session.backend !== "native") {
		if (session.clients.size === 0) return;
		const data = session.pendingData;
		session.pendingData = "";
		for (const client of session.clients) {
			try { client.sendText(data); } catch { /* dead client */ }
		}
		return;
	}
	const data = session.pendingData;
	session.pendingData = "";
	// Journal FIRST and unconditionally: with no viewer attached (remote-only use,
	// or every tab closed) this tail is the entire screen the next one will get.
	const seq = session.nativeStream?.push(data) ?? 0;
	if (session.clients.size === 0) return;
	const framed = outputMessage(seq, data);
	for (const client of session.clients) {
		try { client.sendText(framed); } catch { /* dead client */ }
	}
}

/**
 * Bring the journal level with everything already broadcast, so a client
 * attaching right now replays a tail that ends exactly where the live stream
 * resumes. Called before an attach — the ordering guarantee, not an optimisation.
 */
function settleNativeStream(session: PtySession): void {
	if (session.backend !== "native" || !session.pendingData) return;
	if (session.batchTimer) {
		clearTimeout(session.batchTimer);
		session.batchTimer = null;
	}
	flushPendingData(session);
}

/**
 * Enqueue PTY data for batched delivery to the WebSocket.
 * Instead of sending every chunk immediately (which for Claude Code means
 * thousands of tiny WS messages per second), we accumulate data and flush
 * at ~60fps. The first chunk in a batch is sent immediately for latency,
 * subsequent chunks within the batch window are coalesced.
 */
function enqueuePtyData(session: PtySession, data: string): void {
	session.pendingData += data;
	if (!session.batchTimer) {
		// First chunk — schedule flush. If only one chunk arrives within
		// the interval, the delay is at most PTY_BATCH_INTERVAL_MS (16ms),
		// which is imperceptible. For bursty output, all intermediate
		// chunks are coalesced into a single WS message.
		session.batchTimer = setTimeout(() => flushPendingData(session), PTY_BATCH_INTERVAL_MS);
	}
}

async function configureTmux(tmuxSessionName: string, socket: string): Promise<void> {
	// Re-source the config in case the tmux server was already running
	// (the -f flag on new-session only applies when starting a fresh server)
	try {
		await tmux.sourceFile(activeTmuxConfigPath(), { socket, bestEffort: true });
	} catch (err) {
		log.warn("tmux source-file failed (non-fatal)", { tmuxSession: tmuxSessionName, error: String(err) });
	}

	// Set pane-exited hook — when any pane in this session exits, notify the app
	// via HTTP so the dead pane entry can be removed from sessionState.
	// pane-exited is a window-level hook (-w flag required).
	// #{hook_pane} expands to the pane that triggered the hook (the exited one).
	// #{pane_id} would give the *active* pane instead — wrong target.
	// Single quotes around the URL prevent shell interpretation of &.
	// || true prevents errors if the app isn't running (e.g. during shutdown).
	try {
		await tmux.setWindowHook(tmuxSessionName, "pane-exited",
			`run-shell "curl -s 'http://localhost:${ptyWsPort}/pane-exited?session=${tmuxSessionName}&pane=#{hook_pane}' || true"`,
			{ socket, bestEffort: true },
		);
	} catch (err) {
		log.warn("Failed to set pane-exited hook (non-fatal)", { tmuxSession: tmuxSessionName, error: String(err) });
	}

	log.info("tmux config applied", { tmuxSession: tmuxSessionName, configPath: activeTmuxConfigPath() });
}

/**
 * Create a 2×2 pane grid for project and home terminals.
 * Only runs if the session currently has exactly one pane (i.e. freshly created).
 * Uses `select-layout tiled` to avoid pane-index arithmetic.
 */
async function setupTiledLayout(session: PtySession): Promise<void> {
	const s = session.tmuxSessionName;
	const sock = session.tmuxSocket;
	try {
		const paneCount = (await tmux.listPanes(PANE_ID_FORMAT, { target: s, socket: sock })).length;
		if (paneCount !== 1) {
			log.info("Tiled layout: session already has multiple panes, skipping", { tmuxSession: s, paneCount });
			return;
		}
		// Create 3 more panes (4 total), then apply tiled layout for 2×2 grid.
		// We always split the active pane — no pane-index arithmetic needed,
		// so pane-base-index setting doesn't matter.
		// -c sets the working directory — without it, new panes inherit the
		// tmux server's start dir (e.g. /Applications/dev-3.0.app/Contents/MacOS/).
		for (let i = 0; i < 3; i++) {
			// A single failed split is ignored (as before) — the layout below
			// still tiles whatever panes were created.
			try {
				await tmux.splitWindow({ target: s, orientation: "vertical", cwd: session.cwd, socket: sock });
			} catch (err) {
				if (!(err instanceof TmuxError)) throw err;
			}
		}
		// tiled layout arranges 4 panes as a 2×2 grid automatically
		await tmux.selectLayout(s, "tiled", { socket: sock, bestEffort: true });
		// Return focus to pane 1 (base-index 1 in tmux config)
		await tmux.selectPane(`${s}:1.1`, { socket: sock, bestEffort: true });
		log.info("Tiled 2×2 layout created", { tmuxSession: s, sessionType: session.sessionType });
	} catch (err) {
		log.error("Failed to create tiled terminal layout", {
			tmuxSession: s,
			error: String(err),
		});
	}
}

/**
 * True when `cwd` exists and is reachable. A PTY's cwd is always a DIRECTORY
 * (worktree / project path / ops work dir). Do NOT use `Bun.file(cwd).exists()`
 * here: Bun.file has file semantics and returns `false` for directories, so it
 * reported a bogus "PTY cwd missing" for every valid dir. `fs.access` resolves
 * directories correctly. See decisions/081-pty-cwd-exists-fs-access.md.
 */
export async function cwdExists(cwd: string): Promise<boolean> {
	try {
		await access(cwd);
		return true;
	} catch {
		return false;
	}
}

function spawnPty(session: PtySession, cols: number, rows: number): void {
	const tmuxSessionName = session.tmuxSessionName;
	const tmuxCmd = session.tmuxCommand || getUserShell();

	// cwd existence is checked asynchronously (best-effort log) — if cwd is
	// missing, the child fork will fail and `proc.exited` will fire with a
	// non-zero exit, triggering onPtyDiedCallback. We do NOT block here.
	cwdExists(session.cwd).then((exists) => {
		if (!exists) {
			log.error("PTY cwd missing", { taskId: shortId(session.taskId), cwd: session.cwd });
		}
	}).catch(() => {});

	log.info("Spawning PTY process", {
		tmuxSession: tmuxSessionName,
		command: tmuxCmd,
		cwd: session.cwd,
		cols,
		rows,
	});

	// Diagnostic: log the resolved tmux binary path once per app run.
	logTmuxBinaryOnce(session.taskId);

	let proc: ReturnType<typeof Bun.spawn>;
	const spawnStartedAt = Date.now();
	let firstOutputLogged = false;
	try {
		// Pass session env vars to tmux via `-e KEY=VAL` so they land in
		// session-environment atomically at new-session time. Without this,
		// the tmux server's global env (set by whichever task started the
		// server first) leaks into new panes/windows of unrelated sessions
		// — most visibly, DEV3_TASK_ID from task A appearing in task B's
		// split-windows. The post-spawn `set-environment` loop below stays
		// as a fallback for the `-A` (attach to existing) path.
		const envFlags: Record<string, string> = {};
		for (const [key, value] of Object.entries(session.env)) {
			// ENV_UNSET entries can't ride on `-e` (it only sets); they are removed
			// via `set-environment -r` below plus `unset` lines in the cmd script.
			if (value === ENV_UNSET) continue;
			envFlags[key] = value;
		}
		envFlags.DEV3_WORKTREE_ROOT = session.cwd;
		log.debug("PTY: calling Bun.spawn", { taskId: shortId(session.taskId), tmuxSession: tmuxSessionName });
		// The pane cwd MUST be an explicit `-c` — it cannot ride on the client
		// process cwd, because the client is deliberately spawned from DEV3_HOME
		// (see tmuxClientCwd) so a task worktree never becomes the tmux server's
		// permanent working directory.
		proc = tmux.spawnAttachedSession({
			socket: session.tmuxSocket,
			configFile: activeTmuxConfigPath(),
			sessionName: tmuxSessionName,
			cwd: session.cwd,
			attachIfExists: true,
			envFlags,
			command: tmuxCmd,
			terminal: {
				cols,
				rows,
				data(_terminal: unknown, data: string | Uint8Array) {
					try {
						if (!firstOutputLogged) {
							firstOutputLogged = true;
							log.info("PTY first output", {
								taskId: shortId(session.taskId),
								msSinceSpawn: Date.now() - spawnStartedAt,
								bytes: typeof data === "string" ? data.length : data.byteLength,
							});
						}
						ingestPtyOutput(session, data);
					} catch (err) {
						log.error("PTY data callback error", {
							taskId: shortId(session.taskId),
							error: String(err),
							stack: (err as Error)?.stack ?? "no stack",
						});
					}
				},
			},
			processEnv: {
				TERM: "xterm-256color",
				// Ensure tmux knows the client supports UTF-8.
				// macOS .app bundles inherit a minimal env without LANG;
				// without it tmux replaces non-ASCII chars with underscores.
				LANG: process.env.LANG || "en_US.UTF-8",
				HOME: process.env.HOME || "/",
				// ENV_UNSET sentinels must never reach a real process env.
				...Object.fromEntries(Object.entries(session.env).filter(([, v]) => v !== ENV_UNSET)),
			},
		});
		log.debug("PTY: Bun.spawn returned", { taskId: shortId(session.taskId), pid: proc.pid, msSinceSpawn: Date.now() - spawnStartedAt });
	} catch (err) {
		log.error("Bun.spawn FAILED for tmux", {
			taskId: shortId(session.taskId),
			tmuxSession: tmuxSessionName,
			command: tmuxCmd,
			cwd: session.cwd,
			error: String(err),
			stack: (err as Error)?.stack ?? "no stack",
		});
		// spawnAttachedSession already wraps launch failures in TmuxSpawnError.
		throw err;
	}

	session.proc = proc;
	// Track the geometry the PTY was spawned with so applyClientSizes can tell a
	// real size change from a same-size resize (which needs a forced redraw).
	session.appliedCols = cols;
	session.appliedRows = rows;

	proc.exited.then((code) => {
		log.info("PTY process exited", { taskId: shortId(session.taskId), exitCode: code });
		session.proc = null;
		session.appliedCols = undefined;
		session.appliedRows = undefined;
		onPtyDiedCallback?.(session.taskId);
	}).catch((err) => {
		log.error("PTY process .exited promise rejected", {
			taskId: shortId(session.taskId),
			error: String(err),
			stack: (err as Error)?.stack ?? "no stack",
		});
		session.proc = null;
		onPtyDiedCallback?.(session.taskId);
	});

	log.info("PTY process started", { taskId: shortId(session.taskId), pid: proc.pid });

	// Configure tmux (clipboard + bell pass-through) after session is ready.
	// Session env vars are now passed atomically via `-e KEY=VAL` flags on
	// new-session above. The set-environment loop below stays as a safety
	// net for the `-A` (attach to existing session) path, where `-e` is
	// ignored by tmux.
	if (session.configureTimer) clearTimeout(session.configureTimer);
	session.configureTimer = setTimeout(() => {
		session.configureTimer = null;
		(async () => {
			try {
				await configureTmux(tmuxSessionName, session.tmuxSocket);
				const sessionSocket = session.tmuxSocket;
				tmux.setEnvironment(tmuxSessionName, "DEV3_WORKTREE_ROOT", session.cwd, { socket: sessionSocket }).catch(() => {});
				const envKeys = Object.keys(session.env);
				for (const [key, value] of Object.entries(session.env)) {
					if (value === ENV_UNSET) {
						// `-r` marks the var as removed in the session env, hiding a
						// stale server-global value from new panes/windows.
						tmux.removeEnvironment(tmuxSessionName, key, { socket: sessionSocket }).catch(() => {});
					} else {
						tmux.setEnvironment(tmuxSessionName, key, value, { socket: sessionSocket }).catch(() => {});
					}
				}
				if (envKeys.length > 0) {
					log.info("tmux session env vars set (post-spawn safety net)", { tmuxSession: tmuxSessionName, keys: envKeys });
				}
				if (session.sessionType === "project") {
					await setupTiledLayout(session);
				}
			} catch (err) {
				log.error("configureTmux failed", {
					taskId: shortId(session.taskId),
					tmuxSession: tmuxSessionName,
					error: String(err),
					stack: (err as Error)?.stack ?? "no stack",
				});
			}
		})();
	}, 200);
}

// ── Idle detection ──────────────────────────────────────────────────
// If a PTY session produces no output for IDLE_THRESHOLD_MS, fire the
// idle callback once.  The flag resets as soon as new output arrives.
const IDLE_THRESHOLD_MS = 15_000;
const IDLE_CHECK_INTERVAL_MS = 5_000;

setInterval(() => {
	const now = Date.now();
	for (const session of sessions.values()) {
		if (!sessionShell(session)) continue;
		if (session.idleNotified) continue;
		if (now - session.lastOutputTime >= IDLE_THRESHOLD_MS) {
			session.idleNotified = true;
			log.info("Terminal idle detected", { taskId: shortId(session.taskId) });
			onIdleCallback?.(session.taskId);
		}
	}
}, IDLE_CHECK_INTERVAL_MS);

/** Reverse lookup: find the taskId that owns a given tmux session name. */
function findTaskIdByTmuxSession(tmuxSessionName: string): string | null {
	for (const session of sessions.values()) {
		if (session.tmuxSessionName === tmuxSessionName) return session.taskId;
	}
	return null;
}

const ptyServer = Bun.serve({
	port: 0,
	fetch(req, server) {
		try {
			const url = new URL(req.url, "http://localhost");

			// Handle pane-exited notifications from tmux hook
			if (url.pathname === "/pane-exited") {
				const sessionName = url.searchParams.get("session");
				const paneId = url.searchParams.get("pane");
				if (sessionName && paneId) {
					const taskId = findTaskIdByTmuxSession(sessionName);
					if (taskId) {
						log.info("Pane exited", { taskId: shortId(taskId), paneId, sessionName });
						onPaneExitedCallback?.(taskId, paneId);
					} else {
						log.debug("Pane exited for unknown session", { sessionName, paneId });
					}
				}
				return new Response("ok");
			}

			log.debug("PTY server fetch", { url: req.url });
			if (server.upgrade(req, { data: { url } } as any)) return;
			return new Response("PTY WebSocket server", { status: 200 });
		} catch (err) {
			log.error("PTY server fetch handler error", {
				url: req.url,
				error: String(err),
				stack: (err as Error)?.stack ?? "no stack",
			});
			return new Response("Internal error", { status: 500 });
		}
	},
	websocket: {
		open(ws) {
			try {
				const url = (ws.data as any)?.url as URL | undefined;
				const sessionId = url?.searchParams.get("session");

				log.debug("WS open handler called", {
					hasUrl: !!url,
					sessionId: sessionId?.slice(0, 8) ?? "none",
					totalSessions: sessions.size,
				});

				if (!sessionId) {
					log.warn("WS connection without session param");
					ws.close(PTY_WS_CLOSE.MISSING_SESSION, "Missing session parameter");
					return;
				}

				const session = sessions.get(sessionId);
				if (!session) {
					log.warn("WS connection to unknown session", {
						sessionId: sessionId.slice(0, 8),
						knownSessions: Array.from(sessions.keys()).map((k) => k.slice(0, 8)),
					});
					ws.close(PTY_WS_CLOSE.UNKNOWN_SESSION, "Unknown session");
					return;
				}

				log.info("WS connected", {
					taskId: shortId(sessionId),
					paneId: paneIdOfSessionKey(sessionId),
					hasExistingProc: !!session.proc,
					procPid: session.proc?.pid ?? null,
					cwd: session.cwd,
				});

				(ws as any).sessionId = sessionId;

				// Native attaches BEFORE joining the broadcast set: the replay tail must
				// end exactly where this client's live stream begins, or the screen it
				// rebuilds is missing (or double-printing) the frames in between.
				if (session.backend === "native") {
					attachNativeClient(session, ws, parseSinceParam(url?.searchParams.get(NATIVE_STREAM_SINCE_PARAM)));
				}

				// Add this client to the session's broadcast set
				session.clients.add(ws as any);

				const cols = 80;
				const rows = 24;

				// If no proc yet, spawn one. If proc exists, just attach
				// the WS — the freshly-mounted ghostty-web terminal on the
				// client is already blank, and the client's resize dance
				// will force tmux to SIGWINCH and emit a full pane redraw
				// via the natural PTY data path. Any explicit clear or
				// capture-pane replay here races that redraw and causes
				// visible flicker on every task switch; sending nothing
				// is the clean path. See fix: task cb75af7b.
				if (session.backend === "native") {
					// Never spawn from here: a native session's host is created by the
					// launch path and rediscovered by reattach. A missing one means the
					// shell is gone, which the ptyDied path already reports.
					if (!session.native && !session.nativeAttaching) {
						// For composite keys (non-first panes), use ensureNativePanePtySession.
						// For the bare task key (first pane), use the normal reattach path.
						const parsed = parsePaneSessionKey(sessionId);
						if (parsed) {
							// Non-first pane: bind by session id (already in sessions map from ensureNativePanePtySession).
							// If it's not bound yet, log a warning — the renderer opened the pane before the
							// backend had a chance to register it.
							log.warn("Non-first pane session missing native binding on WS open", {
								taskId: shortId(parsed.taskId),
								paneId: parsed.paneId,
							});
						} else {
							void reattachNativeTaskSession(sessionId, session.projectId, session.cwd).then((ok) => {
								if (!ok) log.warn("Native session is gone; nothing to reattach", { taskId: shortId(sessionId) });
							}).catch((err) => {
								log.error("Native session reattach failed", { taskId: shortId(sessionId), error: String(err) });
							});
						}
					}
				} else if (!session.proc) {
					log.info("No proc, spawning new PTY", { taskId: shortId(sessionId) });
					spawnPty(session, cols, rows);
				} else {
					log.info("Reconnecting to existing PTY, tmux will redraw on resize", {
						taskId: shortId(sessionId),
					});
				}
			} catch (err) {
				log.error("WS open handler CRASHED", {
					error: String(err),
					stack: (err as Error)?.stack ?? "no stack",
				});
			}
		},
		message(ws, message) {
			try {
				const sessionId = (ws as any).sessionId as string | undefined;
				if (!sessionId) return;
				const session = sessions.get(sessionId);
				if (!session) return;
				const shell = sessionShell(session);
				if (!shell) return;

				const data =
					typeof message === "string"
						? message
						: new TextDecoder().decode(message);

				if (session.backend === "native") {
					const control = decodeNativeStreamMessage(data);
					if (control) {
						if (control.header.t === "claim" || control.header.t === "release") {
							handleNativeOwnership(session, ws, control.header.t);
						}
						return;
					}
					// Every viewer reports its own viewport; only the writer's reaches the
					// PTY (see applyClientSizes), so an observer's zoom stays client-local.
					if (isResizeSequence(data)) {
						const size = parseResizeSequence(data);
						if (size) {
							(ws as any).ptyCols = size.cols;
							(ws as any).ptyRows = size.rows;
							applyClientSizes(session);
						}
						return;
					}
					// Both leases must agree: ours picks the viewer, the host's decides
					// whether this app process may type at all. Say so explicitly —
					// silently swallowed keystrokes read as a hung shell.
					if (effectiveNativeRole(session, ws) !== "writer") {
						sendToClient(ws, roleMessage("observer", true));
						return;
					}
					shell.write(data);
					return;
				}

				// Handle resize messages. Record this client's requested size and
				// resize the shared PTY to the smallest across all clients, so
				// multiple windows on the same task don't fight over the geometry.
				if (isResizeSequence(data)) {
					const size = parseResizeSequence(data);
					if (size) {
						(ws as any).ptyCols = size.cols;
						(ws as any).ptyRows = size.rows;
						applyClientSizes(session);
					}
					return;
				}

				shell.write(data);
			} catch (err) {
				log.error("WS message handler error", {
					error: String(err),
					stack: (err as Error)?.stack ?? "no stack",
				});
			}
		},
		close(ws) {
			try {
				const sessionId = (ws as any).sessionId as string | undefined;
				if (!sessionId) return;

				log.info("WS disconnected", {
					taskId: shortId(sessionId),
					paneId: paneIdOfSessionKey(sessionId),
				});

				const session = sessions.get(sessionId);
				if (session) {
					// Remove this client — don't kill the PTY. For native that also means
					// the host, shell, and every sibling viewer keep running; a browser tab
					// closing only releases its own lease.
					const promoted = session.nativeLease?.detach(ws as any) ?? null;
					session.clients.delete(ws as any);
					// EFFECTIVE role, never a raw `writer`: another app process may hold the host
					// lease, and telling this viewer it can type means it discovers otherwise
					// only when its first keystroke is refused.
					if (promoted?.writer) {
						sendToClient(
							promoted.writer,
							roleMessage(effectiveNativeRole(session, promoted.writer), false, nativePtyGeometry(session)),
						);
					}
					// A viewer left: the smallest-size constraint may have relaxed,
					// so grow the PTY back to the smallest of the remaining clients.
					applyClientSizes(session);
				}
			} catch (err) {
				log.error("WS close handler error", {
					error: String(err),
					stack: (err as Error)?.stack ?? "no stack",
				});
			}
		},
	},
});

ptyWsPort = ptyServer.port ?? 0;
log.info(`PTY WebSocket server running on ws://localhost:${ptyWsPort}`);
