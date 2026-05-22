import { writeFileSync } from "node:fs";
import { createLogger } from "./logger";
import { spawn } from "./spawn";
import { getUserShell } from "./shell-env";
import { CATPPUCCIN_PLUGIN_DIR, writeCatppuccinPlugin } from "./tmux-themes";
import { writeShellInit } from "./shell-init";

// --- Bundled tmux configuration -------------------------------------------
// Two theme-specific configs are written at startup: dark and light.
// Each sets @catppuccin_flavor, sources the Catppuccin plugin for styling,
// then applies our functional settings (keybindings, scrollback, etc.).

export const TMUX_CONF_DARK_PATH = "/tmp/dev3-tmux-dark.conf";
export const TMUX_CONF_LIGHT_PATH = "/tmp/dev3-tmux-light.conf";
/** Path currently loaded — kept for configureTmux() re-source. */
export let TMUX_CONF_PATH = TMUX_CONF_DARK_PATH;

// Shared functional settings (not theme-related)
const TMUX_CONFIG_FUNCTIONAL = String.raw`
# Source system and user tmux configs first, so personal keybindings
# and preferences are preserved. Our settings below override as needed.
if-shell "test -f /etc/tmux.conf" "source-file /etc/tmux.conf"
if-shell "test -f ~/.tmux.conf" "source-file ~/.tmux.conf"
if-shell "test -f ~/.config/tmux/tmux.conf" "source-file ~/.config/tmux/tmux.conf"

# Mouse support
setw -g mouse on

# Window/pane numbering starts at 1
set -g base-index 1
setw -g pane-base-index 1

# 256-color terminal with true-color (RGB) override
set -g default-terminal "tmux-256color"
set -ga terminal-overrides ",xterm-256color:RGB"

# Scrollback buffer — 250k to handle high-output AI agents (Claude Code
# generates 4000+ scroll events/sec; the default 2000 fills in <1 second)
set -g history-limit 250000

# No escape delay — critical for responsiveness. tmux's default 500ms wait
# after Escape makes AI agent TUIs feel sluggish.
set -sg escape-time 0

# Extended keys and focus events — required for proper key handling in
# modern TUI apps (Ink/React-based renderers, neovim, etc.)
set -g extended-keys on
set -as terminal-features 'xterm*:extkeys'
set -g focus-events on

# Synchronized output (DEC mode 2026) — tells the outer terminal to buffer
# all output and render atomically, eliminating screen tearing during rapid
# updates from AI agents. Requires tmux 3.3+.
set -gqa terminal-features ",xterm-256color:Sync"
set -gqa terminal-features ",tmux-256color:Sync"

# Auto-rename windows by running command
setw -g automatic-rename on

# Renumber windows when one is closed
set -g renumber-windows on

# Intuitive splits (open in same directory)
bind | split-window -h -c "#{pane_current_path}"
bind \\ split-window -h -c "#{pane_current_path}"
bind - split-window -v -c "#{pane_current_path}"

# Alt+arrow pane switching (no prefix required)
bind -n M-Left select-pane -L
bind -n M-Right select-pane -R
bind -n M-Up select-pane -U
bind -n M-Down select-pane -D

# Pane border style
set -g pane-border-lines double

# Clipboard support
set -s set-clipboard on

# Bell pass-through
set -g visual-bell off
set -g bell-action any
setw -g monitor-bell on

# Allow escape sequence passthrough (for DEC 2026 synchronized output,
# image protocols like Kitty graphics, etc.)
set -g allow-passthrough on
set -ga update-environment TERM
set -ga update-environment TERM_PROGRAM

# Shell prompt — redirect zsh to dev3 ZDOTDIR for short worktree paths
set-environment -g ZDOTDIR /tmp/dev3-shell
`;

// Status bar setup — references Catppuccin status modules built by the plugin
const TMUX_STATUS_BAR = `
# Status bar — Catppuccin modules
set -g status-right-length 100
set -g status-right "#{E:@catppuccin_status_application}#{E:@catppuccin_status_session}"
set -g status-left ""
`;

function buildThemeConfig(flavor: "mocha" | "latte"): string {
	const pluginDir = CATPPUCCIN_PLUGIN_DIR;
	return [
		`# dev3 tmux config — Catppuccin ${flavor}`,
		`set -g @catppuccin_flavor "${flavor}"`,
		// Source palette DIRECTLY (source -F with #{d:current_file} is unreliable)
		`source "${pluginDir}/themes/catppuccin_${flavor}_tmux.conf"`,
		`source "${pluginDir}/catppuccin_options_tmux.conf"`,
		`source "${pluginDir}/catppuccin_tmux.conf"`,
		TMUX_CONFIG_FUNCTIONAL,
		TMUX_STATUS_BAR,
	].join("\n");
}

// Write Catppuccin plugin files + both themed configs + shell init at startup
writeCatppuccinPlugin();
writeShellInit();
writeFileSync(TMUX_CONF_DARK_PATH, buildThemeConfig("mocha"));
writeFileSync(TMUX_CONF_LIGHT_PATH, buildThemeConfig("latte"));

/**
 * Apply a tmux theme (dark/light) to all active dev3 tmux sessions.
 * Sources the corresponding config file, which re-sets all theme variables
 * and re-applies every setting that depends on them.
 */
export async function applyTmuxTheme(theme: "dark" | "light"): Promise<void> {
	TMUX_CONF_PATH = theme === "light" ? TMUX_CONF_LIGHT_PATH : TMUX_CONF_DARK_PATH;
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
				const proc = spawn(tmuxArgs(socket, "source-file", TMUX_CONF_PATH), { stdout: "pipe", stderr: "pipe" });
				await proc.exited;
				log.info("tmux theme applied", { theme, socket, configPath: TMUX_CONF_PATH });
			} catch (err) {
				log.warn("Failed to apply tmux theme", { theme, socket, error: String(err) });
			}
		}),
	);
}

// Default tmux socket name — all dev3 sessions live here.
export const DEFAULT_TMUX_SOCKET = "dev3";

// Resolved tmux binary path. Defaults to "tmux" (relies on PATH).
// Updated by setTmuxBinary() after requirements check finds a custom or fallback path.
let tmuxBinary = "tmux";

export function setTmuxBinary(path: string) {
	tmuxBinary = path;
}

export function getTmuxBinary(): string {
	return tmuxBinary;
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

/**
 * Build a tmux command array with our custom socket.
 * All tmux invocations in the app MUST use this helper to ensure
 * session isolation from the user's personal tmux server.
 */
export function tmuxArgs(socket: string, ...args: string[]): string[] {
	return [tmuxBinary, "-L", socket, ...args];
}

const log = createLogger("pty");

let ptyWsPort = 0;

// ── PTY data batching ──────────────────────────────────────────────
// AI agents (Claude Code, Codex) generate 4,000–6,700 scroll events/sec.
// Forwarding every PTY byte chunk individually to WebSocket causes massive
// rendering overhead in the frontend terminal emulator. Instead, we batch
// data and flush at ~60fps (16ms intervals). This reduces WS message count
// by 10-100x while maintaining perceptual smoothness.
const PTY_BATCH_INTERVAL_MS = 16;

export type PtySessionType = "task" | "project" | "home";

export const HOME_TERMINAL_SESSION_KEY = "home";
export const HOME_TERMINAL_TMUX_NAME = "dev3-home";

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
	/** Partial OSC 52 clipboard sequence buffered across PTY chunks. */
	osc52Buffer: string;
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
		return `dev3-pt-${projectId.slice(0, 8)}`;
	}
	if (type === "home") {
		return HOME_TERMINAL_TMUX_NAME;
	}
	return `dev3-${shortId(key)}`;
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
		osc52Buffer: "",
	};
	sessions.set(taskId, session);
	// Spawn immediately in the background — don't wait for WS connection
	spawnPty(session, 220, 50);
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
	try {
		const proc = spawn(tmuxArgs(socket, "kill-session", "-t", tmuxSessionName), {
			stdout: "pipe",
			stderr: "pipe",
		});
		proc.exited
			.then(async (code) => {
				if (code !== 0) {
					const stderr = (await new Response(proc.stderr).text()).trim();
					log.warn("tmux kill-session exited non-zero", {
						taskId: taskId.slice(0, 8),
						exitCode: code,
						stderr,
					});
				} else {
					log.info("tmux kill-session succeeded", { taskId: taskId.slice(0, 8), tmuxSessionName });
				}
			})
			.catch((err) => {
				log.warn("tmux kill-session promise rejected", {
					taskId: taskId.slice(0, 8),
					error: String(err),
				});
			});
	} catch (err) {
		log.warn("tmux kill-session spawn failed (best-effort)", {
			taskId: taskId.slice(0, 8),
			error: String(err),
		});
	}
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
		const proc = spawn(
			tmuxArgs(socket, "capture-pane", "-p", "-e", "-t", tmuxSessionName),
			{ stdout: "pipe", stderr: "pipe" },
		);
		const stdout = await new Response(proc.stdout).text();
		const exitCode = await proc.exited;
		if (exitCode === 0 && stdout.length > 0) {
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
	const tmuxSessionName = `dev3-${shortId(taskId)}`;
	try {
		const splitProc = spawn(
			tmuxArgs(socket, "split-window", "-v", "-t", tmuxSessionName, "-c", cwd, "-P", "-F", "#{pane_id}", command),
			{ stdout: "pipe", stderr: "pipe" },
		);
		const stdout = await new Response(splitProc.stdout).text();
		const exitCode = await splitProc.exited;
		if (exitCode !== 0) {
			log.warn("splitAndRunCommand failed", { taskId: shortId(taskId), exitCode });
			return null;
		}
		const paneId = stdout.trim();
		const layoutProc = spawn(tmuxArgs(socket, "select-layout", "-t", tmuxSessionName, "tiled"), { stdout: "pipe", stderr: "pipe" });
		await layoutProc.exited;
		return paneId || null;
	} catch (err) {
		log.warn("splitAndRunCommand error", { taskId: shortId(taskId), error: String(err) });
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
		const proc = spawn(
			tmuxArgs(socket, "list-panes", "-t", tmuxSessionName, "-F", "#{pane_id}"),
			{ stdout: "pipe", stderr: "pipe" },
		);
		const stdout = await new Response(proc.stdout).text();
		const exitCode = await proc.exited;
		if (exitCode !== 0) return [];
		return stdout.trim().split("\n").filter(Boolean);
	} catch {
		return [];
	}
}

/**
 * Check if a tmux session exists on the given socket.
 */
export async function tmuxSessionExists(taskId: string, socket: string = DEFAULT_TMUX_SOCKET): Promise<boolean> {
	const tmuxSessionName = computeTmuxSessionName(taskId, "task");
	try {
		const proc = spawn(tmuxArgs(socket, "has-session", "-t", tmuxSessionName), { stdout: "pipe", stderr: "pipe" });
		const exitCode = await proc.exited;
		return exitCode === 0;
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
		const sourceProc = spawn(tmuxArgs(socket, "source-file", TMUX_CONF_PATH), { stdout: "pipe", stderr: "pipe" });
		await sourceProc.exited;
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
		const hookProc = spawn(tmuxArgs(socket, "set-hook", "-wt", tmuxSessionName, "pane-exited",
			`run-shell "curl -s 'http://localhost:${ptyWsPort}/pane-exited?session=${tmuxSessionName}&pane=#{hook_pane}' || true"`,
		), { stdout: "pipe", stderr: "pipe" });
		await hookProc.exited;
	} catch (err) {
		log.warn("Failed to set pane-exited hook (non-fatal)", { tmuxSession: tmuxSessionName, error: String(err) });
	}

	log.info("tmux config applied", { tmuxSession: tmuxSessionName, configPath: TMUX_CONF_PATH });
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
		const listProc = spawn(tmuxArgs(sock, "list-panes", "-t", s), { stdout: "pipe", stderr: "pipe" });
		const listStdout = await new Response(listProc.stdout).text();
		await listProc.exited;
		const paneCount = listStdout.trim().split("\n").filter(Boolean).length;
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
			const splitProc = spawn(tmuxArgs(sock, "split-window", "-v", "-t", s, "-c", session.cwd), { stdout: "pipe", stderr: "pipe" });
			await splitProc.exited;
		}
		// tiled layout arranges 4 panes as a 2×2 grid automatically
		const layoutProc = spawn(tmuxArgs(sock, "select-layout", "-t", s, "tiled"), { stdout: "pipe", stderr: "pipe" });
		await layoutProc.exited;
		// Return focus to pane 1 (base-index 1 in tmux config)
		const selectProc = spawn(tmuxArgs(sock, "select-pane", "-t", `${s}:1.1`), { stdout: "pipe", stderr: "pipe" });
		await selectProc.exited;
		log.info("Tiled 2×2 layout created", { tmuxSession: s, sessionType: session.sessionType });
	} catch (err) {
		log.error("Failed to create tiled terminal layout", {
			tmuxSession: s,
			error: String(err),
		});
	}
}

function spawnPty(session: PtySession, cols: number, rows: number): void {
	const tmuxSessionName = session.tmuxSessionName;
	const tmuxCmd = session.tmuxCommand || getUserShell();

	// cwd existence is checked asynchronously (best-effort log) — if cwd is
	// missing, the child fork will fail and `proc.exited` will fire with a
	// non-zero exit, triggering onPtyDiedCallback. We do NOT block here.
	Bun.file(session.cwd).exists().then((exists) => {
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
		const newSessionArgs = tmuxArgs(session.tmuxSocket, "-f", TMUX_CONF_PATH, "new-session", "-A", "-s", tmuxSessionName, tmuxCmd);
		log.debug("PTY: calling Bun.spawn", { taskId: shortId(session.taskId), tmuxSession: tmuxSessionName });
		proc = spawn(
			newSessionArgs,
			{
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
				env: {
					TERM: "xterm-256color",
					// Ensure tmux knows the client supports UTF-8.
					// macOS .app bundles inherit a minimal env without LANG;
					// without it tmux replaces non-ASCII chars with underscores.
					LANG: process.env.LANG || "en_US.UTF-8",
					HOME: process.env.HOME || "/",
					...session.env,
				},
				cwd: session.cwd,
			},
		);
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
		onPtyDiedCallback?.(session.taskId);
		return;
	}

	session.proc = proc;

	proc.exited.then((code) => {
		log.info("PTY process exited", { taskId: shortId(session.taskId), exitCode: code });
		session.proc = null;
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
	// Propagate ALL custom env vars to the tmux session so that new panes
	// (split windows) inherit them — the env passed to Bun.spawn only
	// affects the initial tmux client, not the tmux server's stored env.
	setTimeout(() => {
		(async () => {
			try {
				await configureTmux(tmuxSessionName, session.tmuxSocket);
				// Set DEV3_WORKTREE_ROOT so the shell prompt shows short paths
				spawn(tmuxArgs(session.tmuxSocket, "set-environment", "-t", tmuxSessionName, "DEV3_WORKTREE_ROOT", session.cwd));
				const envKeys = Object.keys(session.env);
				for (const [key, value] of Object.entries(session.env)) {
					spawn(tmuxArgs(session.tmuxSocket, "set-environment", "-t", tmuxSessionName, key, value));
				}
				if (envKeys.length > 0) {
					log.info("tmux session env vars set", { tmuxSession: tmuxSessionName, keys: envKeys });
				}
				if (session.sessionType === "project" || session.sessionType === "home") {
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

				// Handle resize messages
				if (data.startsWith("\x1b]resize;")) {
					const match = data.match(/\x1b\]resize;(\d+);(\d+)\x07/);
					if (match) {
						session.proc.terminal.resize(
							Number(match[1]),
							Number(match[2]),
						);
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
