import { createLogger } from "./logger";

const log = createLogger("pty");

let ptyWsPort = 0;

interface PtySession {
	taskId: string;
	cwd: string;
	tmuxCommand: string;
	env: Record<string, string>;
	proc: ReturnType<typeof Bun.spawn> | null;
	ws: any;
}

const sessions = new Map<string, PtySession>();
let onPtyDiedCallback: ((taskId: string) => void) | null = null;

export function setOnPtyDied(fn: (taskId: string) => void): void {
	onPtyDiedCallback = fn;
}

export function createSession(
	taskId: string,
	cwd: string,
	tmuxCommand: string,
	extraEnv: Record<string, string> = {},
): void {
	log.info("Creating PTY session", { taskId: taskId.slice(0, 8), cwd, tmuxCommand });
	const session: PtySession = {
		taskId,
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

export function getPtyPort(): number {
	return ptyWsPort;
}

function shortId(taskId: string): string {
	return taskId.slice(0, 8);
}

const OSC52_RE = /\x1b\]52;[^;]*;([A-Za-z0-9+/=]*)(?:\x07|\x1b\\)/g;

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

function configureTmuxClipboard(): void {
	Bun.spawnSync(["tmux", "set", "-s", "set-clipboard", "on"]);
	for (const table of ["copy-mode", "copy-mode-vi"]) {
		Bun.spawnSync([
			"tmux", "bind", "-T", table,
			"MouseDragEnd1Pane",
			"send-keys", "-X", "copy-pipe-and-cancel", "pbcopy",
		]);
	}
	log.info("tmux clipboard configured (set-clipboard on + pbcopy bindings)");
}

function spawnPty(session: PtySession, cols: number, rows: number): void {
	const tmuxSessionName = `dev3-${shortId(session.taskId)}`;
	const tmuxCmd = session.tmuxCommand || "bash";

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

	// Configure tmux clipboard after server is running
	setTimeout(() => configureTmuxClipboard(), 200);
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
