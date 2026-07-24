import { access } from "node:fs/promises";
import type { TmuxLayout, TmuxWindowInfo, TmuxPaneInfo } from "../shared/types";
import { ENV_UNSET } from "../shared/agent-accounts";
import { isResizeSequence, parseResizeSequence, smallestClientSize } from "../shared/resize-protocol";
import { createLogger } from "./logger";
import { spawn } from "./spawn";
import { getUserShell } from "./shell-env";
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
	proc: ReturnType<typeof Bun.spawn> | null;
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
		proc: null,
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

export function destroySession(taskId: string, fallbackSocket?: string): void {
	const session = sessions.get(taskId);
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

export function hasSession(taskId: string): boolean {
	return sessions.has(taskId);
}

/** Returns true if the session is registered but its process has exited. */
export function hasDeadSession(taskId: string): boolean {
	const session = sessions.get(taskId);
	return !!session && session.proc === null;
}

export async function capturePane(taskId: string): Promise<string | null> {
	const session = sessions.get(taskId);
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
function applyClientSizes(session: PtySession): void {
	const term = session.proc?.terminal as { resize(cols: number, rows: number): void } | undefined;
	if (!term) return;
	const target = smallestClientSize(
		Array.from(session.clients, (c) => ({ cols: (c as any).ptyCols, rows: (c as any).ptyRows })),
	);
	if (!target) return;
	const { cols: minCols, rows: minRows } = target;

	if (session.appliedCols === minCols && session.appliedRows === minRows) {
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

	session.appliedCols = minCols;
	session.appliedRows = minRows;
	try {
		term.resize(minCols, minRows);
	} catch (err) {
		log.debug("applyClientSizes resize failed", { error: String(err) });
	}
}

/** Flush accumulated PTY data to all connected WebSocket clients in one batch. */
function flushPendingData(session: PtySession): void {
	session.batchTimer = null;
	if (!session.pendingData || session.clients.size === 0) return;
	const data = session.pendingData;
	session.pendingData = "";
	for (const client of session.clients) {
		try { client.sendText(data); } catch { /* dead client */ }
	}
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
						// Use the session's streaming decoder so that
						// multi-byte UTF-8 sequences split across chunks
						// are buffered instead of replaced with U+FFFD.
						const str =
							typeof data === "string"
								? data
								: session.decoder.decode(data, { stream: true });
						session.lastOutputTime = Date.now();
						session.idleNotified = false;
						if (!firstOutputLogged) {
							firstOutputLogged = true;
							log.info("PTY first output", {
								taskId: shortId(session.taskId),
								msSinceSpawn: Date.now() - spawnStartedAt,
								bytes: typeof data === "string" ? data.length : data.byteLength,
							});
						}
							const cleaned = handleOsc52(str, session);
							checkForBell(cleaned, session.taskId);
							if (cleaned && session.clients.size > 0) {
								enqueuePtyData(session, cleaned);
							}
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
		if (!session.proc) continue;
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

				log.info("WS open handler called", {
					hasUrl: !!url,
					sessionId: sessionId?.slice(0, 8) ?? "none",
					totalSessions: sessions.size,
				});

				if (!sessionId) {
					log.warn("WS connection without session param");
					ws.close(4000, "Missing session parameter");
					return;
				}

				const session = sessions.get(sessionId);
				if (!session) {
					log.warn("WS connection to unknown session", {
						sessionId: sessionId.slice(0, 8),
						knownSessions: Array.from(sessions.keys()).map((k) => k.slice(0, 8)),
					});
					ws.close(4001, "Unknown session");
					return;
				}

				log.info("WS connected", {
					taskId: shortId(sessionId),
					hasExistingProc: !!session.proc,
					procPid: session.proc?.pid ?? null,
					cwd: session.cwd,
				});

				// Add this client to the session's broadcast set
				session.clients.add(ws as any);
				(ws as any).sessionId = sessionId;

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
				if (!session.proc) {
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
				if (!session?.proc?.terminal) return;

				const data =
					typeof message === "string"
						? message
						: new TextDecoder().decode(message);

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

				session.proc.terminal.write(data);
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

				log.info("WS disconnected", { taskId: shortId(sessionId) });

				const session = sessions.get(sessionId);
				if (session) {
					// Remove this client — don't kill the PTY
					session.clients.delete(ws as any);
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
