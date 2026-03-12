import { existsSync, writeFileSync } from "node:fs";
import { createLogger } from "./logger";
import { spawn, spawnSync } from "./spawn";

// --- Bundled tmux configuration -------------------------------------------
// Based on the developer's personal tmux.conf, stripped of locale-specific
// comments and extended with clipboard / bell pass-through settings that
// were previously applied programmatically in configureTmux().

export const TMUX_CONF_PATH = "/tmp/dev3-tmux.conf";

const TMUX_CONFIG = `# Mouse support
setw -g mouse on

# Window/pane numbering starts at 1
set -g base-index 1
setw -g pane-base-index 1

# 256-color terminal
set -g default-terminal "tmux-256color"

# Scrollback buffer
set -g history-limit 50000

# No escape delay (for vim/neovim)
set -sg escape-time 0

# Auto-rename windows by running command
setw -g automatic-rename on

# Renumber windows when one is closed
set -g renumber-windows on

# Intuitive splits (open in same directory)
bind | split-window -h -c "#{pane_current_path}"
bind \\\\ split-window -h -c "#{pane_current_path}"
bind - split-window -v -c "#{pane_current_path}"

# Alt+arrow pane switching (no prefix required)
bind -n M-Left select-pane -L
bind -n M-Right select-pane -R
bind -n M-Up select-pane -U
bind -n M-Down select-pane -D

# Status bar
set -g status-right "#(ps -t #{pane_tty} -o pid=,comm= --sort=-start_time | head -1) | #(cd #{pane_current_path}; git branch --show-current 2>/dev/null || echo '-') | ^b+| split ^b+- hsplit ^b+z zoom"
set -g status-right-length 150

# Clipboard support
set -s set-clipboard on
bind -T copy-mode MouseDragEnd1Pane send-keys -X copy-pipe-and-cancel "pbcopy"
bind -T copy-mode-vi MouseDragEnd1Pane send-keys -X copy-pipe-and-cancel "pbcopy"

# Bell pass-through
set -g visual-bell off
set -g bell-action any
setw -g monitor-bell on

# Allow escape sequence passthrough (for image protocols like Kitty graphics)
set -g allow-passthrough on
set -ga update-environment TERM
set -ga update-environment TERM_PROGRAM

`;

writeFileSync(TMUX_CONF_PATH, TMUX_CONFIG);

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

interface PtySession {
	taskId: string;
	projectId: string;
	cwd: string;
	tmuxCommand: string;
	env: Record<string, string>;
	proc: ReturnType<typeof Bun.spawn> | null;
	ws: any;
	tmuxSocket: string;
	lastOutputTime: number;
	idleNotified: boolean;
	/** Streaming decoder that buffers incomplete multi-byte UTF-8 sequences
	 *  across PTY data chunks, preventing U+FFFD replacement characters. */
	decoder: TextDecoder;
}

const sessions = new Map<string, PtySession>();
let onPtyDiedCallback: ((taskId: string) => void) | null = null;
let onBellCallback: ((taskId: string) => void) | null = null;
let onIdleCallback: ((taskId: string) => void) | null = null;

export function setOnPtyDied(fn: (taskId: string) => void): void {
	onPtyDiedCallback = fn;
}

export function setOnBell(fn: (taskId: string) => void): void {
	onBellCallback = fn;
}

export function setOnIdle(fn: (taskId: string) => void): void {
	onIdleCallback = fn;
}

export function createSession(
	taskId: string,
	projectId: string,
	cwd: string,
	tmuxCommand: string,
	extraEnv: Record<string, string> = {},
	tmuxSocket: string = DEFAULT_TMUX_SOCKET,
): void {
	log.info("Creating PTY session", { taskId: taskId.slice(0, 8), cwd, tmuxCommand, tmuxSocket });
	const session: PtySession = {
		taskId,
		projectId,
		cwd,
		tmuxCommand,
		env: extraEnv,
		proc: null,
		ws: null,
		tmuxSocket,
		lastOutputTime: Date.now(),
		idleNotified: false,
		decoder: new TextDecoder("utf-8", { fatal: false }),
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

	// Kill the tmux session explicitly — proc.kill() only disconnects the
	// attached client, the session itself keeps running on the tmux server.
	// Use spawnSync to ensure the kill completes before we proceed.
	const tmuxSessionName = `dev3-${shortId(taskId)}`;
	try {
		const result = spawnSync(tmuxArgs(socket, "kill-session", "-t", tmuxSessionName));
		if (result.exitCode !== 0) {
			const stderr = new TextDecoder().decode(result.stderr).trim();
			log.warn("tmux kill-session exited non-zero", {
				taskId: taskId.slice(0, 8),
				exitCode: result.exitCode,
				stderr,
			});
		} else {
			log.info("tmux kill-session succeeded", { taskId: taskId.slice(0, 8), tmuxSessionName });
		}
	} catch (err) {
		log.warn("tmux kill-session failed (best-effort)", {
			taskId: taskId.slice(0, 8),
			error: String(err),
		});
	}

	if (session) {
		if (session.proc) {
			session.proc.terminal?.close();
			session.proc.kill();
		}
		if (session.ws) {
			try {
				session.ws.close();
			} catch {
				// already closed
			}
		}
		sessions.delete(taskId);
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

export function capturePane(taskId: string): string | null {
	const session = sessions.get(taskId);
	const socket = session?.tmuxSocket ?? DEFAULT_TMUX_SOCKET;
	const tmuxSessionName = `dev3-${shortId(taskId)}`;
	try {
		const result = spawnSync(
			tmuxArgs(socket, "capture-pane", "-p", "-e", "-t", tmuxSessionName),
		);
		if (result.exitCode === 0 && result.stdout.length > 0) {
			return new TextDecoder().decode(result.stdout);
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

/** Returns sessions where the process is alive and has not gone idle yet. */
export function getActiveBusySessions(): Array<{ taskId: string }> {
	const result: Array<{ taskId: string }> = [];
	for (const session of sessions.values()) {
		if (session.proc && !session.idleNotified) {
			result.push({ taskId: session.taskId });
		}
	}
	return result;
}

/** Close all PTY processes and websockets. Does NOT kill tmux sessions. */
export function destroyAllSessionsGracefully(): void {
	for (const session of sessions.values()) {
		if (session.proc) {
			session.proc.terminal?.close();
			session.proc.kill();
		}
		if (session.ws) {
			try { session.ws.close(); } catch { /* already closed */ }
		}
	}
	sessions.clear();
	log.info("All PTY sessions destroyed gracefully");
}

/**
 * Kill a tmux session's extra panes first, then the main pane last.
 * This ensures the main agent's session file has the most recent timestamp
 * so --continue / resume --last picks up the right one.
 */
export async function killSessionMainPaneLast(taskId: string, socket: string): Promise<void> {
	const tmuxSessionName = `dev3-${shortId(taskId)}`;
	try {
		// List all pane IDs
		const result = spawnSync(
			tmuxArgs(socket, "list-panes", "-t", tmuxSessionName, "-F", "#{pane_id}"),
		);
		if (result.exitCode !== 0) return;

		const panes = new TextDecoder().decode(result.stdout).trim().split("\n").filter(Boolean);
		if (panes.length <= 1) return; // nothing extra to kill

		// Kill all panes except the first (main) one
		for (let i = panes.length - 1; i >= 1; i--) {
			spawnSync(tmuxArgs(socket, "kill-pane", "-t", panes[i]));
		}

		// Wait briefly for agents to write exit state
		await new Promise((resolve) => setTimeout(resolve, 500));
	} catch (err) {
		log.warn("killSessionMainPaneLast failed (best-effort)", {
			taskId: shortId(taskId),
			error: String(err),
		});
	}
}

/** Count panes in a tmux session. Returns 0 if session doesn't exist. */
export function countPanes(taskId: string, socket: string): number {
	const tmuxSessionName = `dev3-${shortId(taskId)}`;
	try {
		const result = spawnSync(
			tmuxArgs(socket, "list-panes", "-t", tmuxSessionName, "-F", "#{pane_id}"),
		);
		if (result.exitCode !== 0) return 0;
		return new TextDecoder().decode(result.stdout).trim().split("\n").filter(Boolean).length;
	} catch {
		return 0;
	}
}

function shortId(taskId: string): string {
	return taskId.slice(0, 8);
}

const OSC52_RE = /\x1b\]52;[^;]*;([A-Za-z0-9+/=]*)(?:\x07|\x1b\\)/g;
// Matches any OSC sequence terminated by BEL or ST — used to strip them
// before checking for standalone BEL (\x07)
const OSC_ANY_RE = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;

function handleOsc52(data: string): string {
	return data.replace(OSC52_RE, (_match, b64: string) => {
		if (b64 && b64 !== "?") {
			try {
				const text = Buffer.from(b64, "base64").toString("utf-8");
				const proc = spawn(["pbcopy"], { stdin: "pipe" });
				const pbcopyStdin = proc.stdin as unknown as import("bun").FileSink;
				pbcopyStdin.write(text);
				pbcopyStdin.end();
				log.info("OSC 52: copied to clipboard", { len: text.length });
			} catch {
				// ignore
			}
		}
		return "";
	});
}

function checkForBell(data: string, taskId: string): void {
	// Strip all OSC sequences (they use \x07 as terminator, not as bell)
	const withoutOsc = data.replace(OSC_ANY_RE, "");
	if (withoutOsc.includes("\x07")) {
		log.info("BEL detected in PTY data stream", { taskId: taskId.slice(0, 8) });
		onBellCallback?.(taskId);
	}
}

function configureTmux(tmuxSessionName: string, socket: string): void {
	// Re-source the config in case the tmux server was already running
	// (the -f flag on new-session only applies when starting a fresh server)
	spawnSync(tmuxArgs(socket, "source-file", TMUX_CONF_PATH));
	log.info("tmux config applied", { tmuxSession: tmuxSessionName, configPath: TMUX_CONF_PATH });
}

function spawnPty(session: PtySession, cols: number, rows: number): void {
	const tmuxSessionName = `dev3-${shortId(session.taskId)}`;
	const tmuxCmd = session.tmuxCommand || "bash";

	if (!existsSync(session.cwd)) {
		log.error("Cannot spawn PTY — cwd does not exist", {
			taskId: shortId(session.taskId),
			cwd: session.cwd,
		});
		onPtyDiedCallback?.(session.taskId);
		return;
	}

	log.info("Spawning PTY process", {
		tmuxSession: tmuxSessionName,
		command: tmuxCmd,
		cwd: session.cwd,
		cols,
		rows,
	});

	// Check if tmux binary is accessible
	try {
		const which = spawnSync(["which", "tmux"]);
		const tmuxPath = new TextDecoder().decode(which.stdout).trim();
		log.info("tmux binary found", {
			taskId: shortId(session.taskId),
			path: tmuxPath,
			exitCode: which.exitCode,
		});
	} catch (err) {
		log.error("tmux binary NOT found — this will crash", {
			taskId: shortId(session.taskId),
			error: String(err),
		});
	}

	let proc: ReturnType<typeof Bun.spawn>;
	try {
		const newSessionArgs = tmuxArgs(session.tmuxSocket, "-f", TMUX_CONF_PATH, "new-session", "-A", "-s", tmuxSessionName, tmuxCmd);
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
							checkForBell(str, session.taskId);
							const cleaned = handleOsc52(str);
							if (cleaned && session.ws) {
								session.ws.sendText(cleaned);
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
		try {
			configureTmux(tmuxSessionName, session.tmuxSocket);
			const envKeys = Object.keys(session.env);
			for (const [key, value] of Object.entries(session.env)) {
				spawn(tmuxArgs(session.tmuxSocket, "set-environment", "-t", tmuxSessionName, key, value));
			}
			if (envKeys.length > 0) {
				log.info("tmux session env vars set", { tmuxSession: tmuxSessionName, keys: envKeys });
			}
		} catch (err) {
			log.error("configureTmux failed", {
				taskId: shortId(session.taskId),
				tmuxSession: tmuxSessionName,
				error: String(err),
				stack: (err as Error)?.stack ?? "no stack",
			});
		}
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

const ptyServer = Bun.serve({
	port: 0,
	fetch(req, server) {
		try {
			log.debug("PTY server fetch", { url: req.url });
			if (server.upgrade(req, { data: { url: new URL(req.url) } } as any)) return;
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

				// Update the ws reference for this session
				session.ws = ws as any;
				(ws as any).sessionId = sessionId;

				const cols = 80;
				const rows = 24;

				// If no proc yet, spawn one. If proc exists, just reconnect
				// and send current screen content for immediate rendering.
				if (!session.proc) {
					log.info("No proc, spawning new PTY", { taskId: shortId(sessionId) });
					spawnPty(session, cols, rows);
				} else {
					// Capture current tmux pane content (with ANSI colors) so the
					// client sees the screen immediately instead of a blank terminal
					// while waiting for the app to redraw after resize.
					log.info("Reconnecting to existing PTY, capturing pane", { taskId: shortId(sessionId) });
					const content = capturePane(sessionId);
					if (content) {
						(ws as any).sendText("\x1b[H" + content);
					}
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
				if (session && session.ws === (ws as any)) {
					// Don't kill the PTY — just detach the WS
					session.ws = null;
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
