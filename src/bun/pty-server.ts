import { existsSync } from "node:fs";
import { createLogger } from "./logger";

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
}

const sessions = new Map<string, PtySession>();
let onPtyDiedCallback: ((taskId: string) => void) | null = null;
let onBellCallback: ((taskId: string) => void) | null = null;

export function setOnPtyDied(fn: (taskId: string) => void): void {
	onPtyDiedCallback = fn;
}

export function setOnBell(fn: (taskId: string) => void): void {
	onBellCallback = fn;
}

export function createSession(
	taskId: string,
	projectId: string,
	cwd: string,
	tmuxCommand: string,
	extraEnv: Record<string, string> = {},
): void {
	log.info("Creating PTY session", { taskId: taskId.slice(0, 8), cwd, tmuxCommand });
	const session: PtySession = {
		taskId,
		projectId,
		cwd,
		tmuxCommand,
		env: extraEnv,
		proc: null,
		ws: null,
	};
	sessions.set(taskId, session);
	// Spawn immediately in the background — don't wait for WS connection
	spawnPty(session, 220, 50);
}

export function destroySession(taskId: string): void {
	const session = sessions.get(taskId);
	if (!session) {
		log.warn("destroySession: session not found", { taskId: taskId.slice(0, 8) });
		return;
	}

	log.info("Destroying PTY session", { taskId: taskId.slice(0, 8), hasPid: !!session.proc });

	// Kill the tmux session explicitly — proc.kill() only disconnects the
	// attached client, the session itself keeps running on the tmux server.
	const tmuxSessionName = `dev3-${shortId(taskId)}`;
	Bun.spawn(["tmux", "kill-session", "-t", tmuxSessionName]);

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

export function hasSession(taskId: string): boolean {
	return sessions.has(taskId);
}

export function getSessionProjectId(taskId: string): string | null {
	return sessions.get(taskId)?.projectId ?? null;
}

export function getPtyPort(): number {
	return ptyWsPort;
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
				const proc = Bun.spawn(["pbcopy"], { stdin: "pipe" });
				proc.stdin.write(text);
				proc.stdin.end();
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

function configureTmux(tmuxSessionName: string): void {
	// Clipboard
	Bun.spawnSync(["tmux", "set", "-s", "set-clipboard", "on"]);
	for (const table of ["copy-mode", "copy-mode-vi"]) {
		Bun.spawnSync([
			"tmux", "bind", "-T", table,
			"MouseDragEnd1Pane",
			"send-keys", "-X", "copy-pipe-and-cancel", "pbcopy",
		]);
	}
	// Bell: ensure tmux passes BEL through to the parent terminal
	Bun.spawnSync(["tmux", "set", "-t", tmuxSessionName, "visual-bell", "off"]);
	Bun.spawnSync(["tmux", "set", "-t", tmuxSessionName, "bell-action", "any"]);
	Bun.spawnSync(["tmux", "set", "-t", tmuxSessionName, "monitor-bell", "on"]);
	log.info("tmux configured (clipboard + bell pass-through)", { tmuxSession: tmuxSessionName });
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

	const proc = Bun.spawn(
		["tmux", "new-session", "-A", "-s", tmuxSessionName, tmuxCmd],
		{
			terminal: {
				cols,
				rows,
				data(_terminal, data) {
					try {
						const str =
							typeof data === "string"
								? data
								: new TextDecoder().decode(data);
						checkForBell(str, session.taskId);
						const cleaned = handleOsc52(str);
						if (cleaned && session.ws) {
							session.ws.sendText(cleaned);
						}
					} catch {
						// WebSocket already closed
					}
				},
			},
			env: {
				...process.env,
				TERM: "xterm-256color",
				HOME: process.env.HOME || "/",
				...session.env,
			},
			cwd: session.cwd,
		},
	);

	session.proc = proc;

	proc.exited.then((code) => {
		log.info("PTY process exited", { taskId: shortId(session.taskId), exitCode: code });
		session.proc = null;
		onPtyDiedCallback?.(session.taskId);
	});

	log.info("PTY process started", { taskId: shortId(session.taskId), pid: proc.pid });

	// Configure tmux (clipboard + bell pass-through) after session is ready
	setTimeout(() => configureTmux(tmuxSessionName), 200);
}

const ptyServer = Bun.serve({
	port: 0,
	fetch(req, server) {
		if (server.upgrade(req, { data: { url: new URL(req.url) } } as any)) return;
		return new Response("PTY WebSocket server", { status: 200 });
	},
	websocket: {
		open(ws) {
			const url = (ws.data as any)?.url as URL | undefined;
			const sessionId = url?.searchParams.get("session");

			if (!sessionId) {
				log.warn("WS connection without session param");
				ws.close(4000, "Missing session parameter");
				return;
			}

			const session = sessions.get(sessionId);
			if (!session) {
				log.warn("WS connection to unknown session", { sessionId: sessionId.slice(0, 8) });
				ws.close(4001, "Unknown session");
				return;
			}

			log.info("WS connected", {
				taskId: shortId(sessionId),
				hasExistingProc: !!session.proc,
			});

			// Update the ws reference for this session
			session.ws = ws as any;
			(ws as any).sessionId = sessionId;

			const cols = 80;
			const rows = 24;

			// If no proc yet, spawn one. If proc exists, just reconnect
			// and send current screen content for immediate rendering.
			if (!session.proc) {
				spawnPty(session, cols, rows);
			} else {
				// Capture current tmux pane content (with ANSI colors) so the
				// client sees the screen immediately instead of a blank terminal
				// while waiting for the app to redraw after resize.
				const tmuxSessionName = `dev3-${shortId(sessionId)}`;
				try {
					const result = Bun.spawnSync(
						["tmux", "capture-pane", "-p", "-e", "-t", tmuxSessionName],
					);
					if (result.exitCode === 0 && result.stdout.length > 0) {
						const content = new TextDecoder().decode(result.stdout);
						(ws as any).sendText("\x1b[H" + content);
					}
				} catch {
					// Non-critical: client will get content after resize
				}
			}
		},
		message(ws, message) {
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
		},
		close(ws) {
			const sessionId = (ws as any).sessionId as string | undefined;
			if (!sessionId) return;

			log.info("WS disconnected", { taskId: shortId(sessionId) });

			const session = sessions.get(sessionId);
			if (session && session.ws === (ws as any)) {
				// Don't kill the PTY — just detach the WS
				session.ws = null;
			}
		},
	},
});

ptyWsPort = ptyServer.port;
log.info(`PTY WebSocket server running on ws://localhost:${ptyWsPort}`);
