const PTY_WS_PORT = 7681;

interface PtySession {
	taskId: string;
	cwd: string;
	tmuxCommand: string;
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
): void {
	sessions.set(taskId, {
		taskId,
		cwd,
		tmuxCommand,
		proc: null,
		ws: null,
	});
}

export function destroySession(taskId: string): void {
	const session = sessions.get(taskId);
	if (!session) return;

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

function shortId(taskId: string): string {
	return taskId.slice(0, 8);
}

function spawnPty(session: PtySession, _ws: any, cols: number, rows: number): void {
	const tmuxSessionName = `dev3-${shortId(session.taskId)}`;
	const tmuxCmd = session.tmuxCommand || "bash";

	const proc = Bun.spawn(
		["tmux", "new-session", "-s", tmuxSessionName, tmuxCmd],
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
						// Send to the current ws reference (may have been reconnected)
						if (session.ws) {
							session.ws.sendText(str);
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
			},
			cwd: session.cwd,
		},
	);

	session.proc = proc;

	proc.exited.then(() => {
		session.proc = null;
		onPtyDiedCallback?.(session.taskId);
	});

	console.log(
		`PTY session started for task ${shortId(session.taskId)} (pid: ${proc.pid})`,
	);
}

Bun.serve({
	port: PTY_WS_PORT,
	fetch(req, server) {
		if (server.upgrade(req, { data: { url: new URL(req.url) } } as any)) return;
		return new Response("PTY WebSocket server", { status: 200 });
	},
	websocket: {
		open(ws) {
			const url = (ws.data as any)?.url as URL | undefined;
			const sessionId = url?.searchParams.get("session");
			if (!sessionId) {
				ws.close(4000, "Missing session parameter");
				return;
			}

			const session = sessions.get(sessionId);
			if (!session) {
				ws.close(4001, "Unknown session");
				return;
			}

			// Update the ws reference for this session
			session.ws = ws as any;
			(ws as any).sessionId = sessionId;

			const cols = 80;
			const rows = 24;

			// If no proc yet, spawn one. If proc exists, just reconnect.
			if (!session.proc) {
				spawnPty(session, ws, cols, rows);
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
			const session = sessions.get(sessionId);
			if (session && session.ws === (ws as any)) {
				// Don't kill the PTY — just detach the WS
				session.ws = null;
			}
		},
	},
});

console.log(`PTY WebSocket server running on ws://localhost:${PTY_WS_PORT}`);
