/**
 * Detached-PTY prototype HOST (spike — see ./README.md).
 *
 * A long-lived, detached Bun process that owns exactly ONE interactive shell
 * spawned through Bun.Terminal, and exposes it over a loopback-TCP WebSocket
 * with a per-run token. Short-lived clients attach, send input, receive output,
 * resize, query status, and stop — and may disconnect/reattach freely without
 * disturbing the live shell. NO tmux involvement whatsoever.
 *
 * This module is imported by NOTHING in the production graph (app entry
 * src/bun/index.ts / CLI entry src/cli/main.ts). It cannot affect existing
 * tmux-backed terminal flows.
 */

import { randomBytes } from "node:crypto";
import { clearState, stateDir, writeState } from "./state";
import { decodeControl, encodeControl, exitEvent, PROTOCOL_VERSION, stoppingEvent, type StatusReply } from "./protocol";
import { mkdirSync } from "node:fs";

// A StatusReply needs live host state, so it is built inline rather than via a
// static protocol factory.
function makeStatusReply(fields: Omit<StatusReply, "v" | "type">): StatusReply {
	return { v: PROTOCOL_VERSION, type: "status", ...fields };
}

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export interface HostOptions {
	/** argv of the shell to own. Default: DEV3_PTY_PROTO_CMD (JSON array) or [$SHELL]. */
	cmd?: string[];
	cols?: number;
	rows?: number;
	/** Fixed port for tests; default 0 = OS-assigned ephemeral. */
	port?: number;
	cwd?: string;
}

export function resolveShellCommand(): string[] {
	const raw = process.env.DEV3_PTY_PROTO_CMD;
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
	return [process.env.SHELL || "/bin/bash"];
}

/**
 * Enumerate every descendant PID of `rootPid` (recursive) via a single `ps`
 * snapshot. An interactive shell enables job control, so background jobs land in
 * their OWN process groups — a plain `kill(-pgid)` would miss them. Walking the
 * ppid tree catches them regardless. Best-effort: returns [] if `ps` is absent.
 */
function collectDescendants(rootPid: number): number[] {
	try {
		const res = Bun.spawnSync(["ps", "-eo", "pid=,ppid="]);
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
 * Kill the shell's whole process tree. Bun.Terminal makes the shell a session
 * leader (setsid for the PTY). We signal every descendant individually (covers
 * job-control children in separate process groups), then the shell's foreground
 * group, then the shell itself. On Windows there is no process group, so we just
 * terminate the subprocess (a full Windows tree-kill is out of scope for the spike).
 */
function killTree(shellPid: number, proc: { kill: (signal?: number | NodeJS.Signals) => void }, signal: NodeJS.Signals): void {
	if (process.platform === "win32") {
		try {
			proc.kill();
		} catch {
			// already gone
		}
		return;
	}
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
 * Boot the host. Resolves once the shell + transport are up and the discovery
 * metadata is written (the readiness signal the launcher polls for). The
 * returned promise settling does NOT end the process — the WebSocket server and
 * the PTY keep the event loop alive until an explicit stop / shell exit.
 */
export async function runHost(opts: HostOptions = {}): Promise<void> {
	const cols = opts.cols ?? 80;
	const rows = opts.rows ?? 24;
	const cmd = opts.cmd ?? resolveShellCommand();
	const token = randomBytes(24).toString("hex");
	mkdirSync(stateDir(), { recursive: true });

	const clients = new Set<{ send: (data: string | Uint8Array) => number; close: () => void }>();
	let currentCols = cols;
	let currentRows = rows;
	let shuttingDown = false;

	// ── The one real shell, owned by THIS process (Bun.Terminal, no tmux) ──
	const proc = Bun.spawn(cmd, {
		terminal: {
			cols,
			rows,
			data(_terminal, bytes) {
				// Broadcast raw PTY output to every attached client. No client ⇒
				// dropped (no screen snapshot / scrollback replay — out of scope).
				for (const c of clients) {
					try {
						c.send(bytes);
					} catch {
						// dead client — dropped on next close event
					}
				}
			},
		},
		cwd: opts.cwd ?? process.env.DEV3_PTY_PROTO_CWD ?? process.cwd(),
		env: { ...process.env, TERM: "xterm-256color" },
	});

	const startedAt = new Date().toISOString();
	const shellPid = proc.pid;

	// ── Loopback-TCP WebSocket transport with a per-run token ──
	const server = Bun.serve({
		port: opts.port ?? 0,
		hostname: "127.0.0.1",
		fetch(req, srv) {
			const url = new URL(req.url);
			if (url.searchParams.get("token") !== token) {
				return new Response("unauthorized", { status: 401 });
			}
			if (srv.upgrade(req)) return undefined;
			return new Response("dev3 detached-pty prototype host", { status: 200 });
		},
		websocket: {
			open(ws) {
				clients.add(ws);
			},
			close(ws) {
				clients.delete(ws);
			},
			message(ws, message) {
				// Binary frame = PTY input (keystrokes).
				if (typeof message !== "string") {
					proc.terminal?.write(message);
					return;
				}
				// Text frame = JSON control.
				const msg = decodeControl(message);
				if (!msg) return;
				if (msg.type === "resize") {
					currentCols = msg.cols;
					currentRows = msg.rows;
					try {
						proc.terminal?.resize(msg.cols, msg.rows);
					} catch {
						// terminal already closed
					}
					persist();
				} else if (msg.type === "status") {
					ws.send(encodeControl(currentStatus()));
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
			},
		},
	});

	function currentStatus(): StatusReply {
		return makeStatusReply({
			hostPid: process.pid,
			shellPid,
			cols: currentCols,
			rows: currentRows,
			alive: proc.terminal ? !proc.terminal.closed : false,
			startedAt,
		});
	}

	function persist(): void {
		writeState({
			hostPid: process.pid,
			shellPid,
			host: "127.0.0.1",
			port: server.port ?? 0,
			token,
			startedAt,
			cols: currentCols,
			rows: currentRows,
		});
	}

	async function shutdown(exitCode: number): Promise<void> {
		if (shuttingDown) return;
		shuttingDown = true;
		try {
			server.stop(true);
		} catch {
			// already stopped
		}
		killTree(shellPid, proc, "SIGTERM");
		const exitedGracefully = await Promise.race([
			proc.exited.then(() => true),
			delay(1500).then(() => false),
		]);
		if (!exitedGracefully) {
			killTree(shellPid, proc, "SIGKILL");
			await Promise.race([proc.exited, delay(1000)]);
		}
		try {
			proc.terminal?.close();
		} catch {
			// already closed
		}
		clearState();
		process.exit(exitCode);
	}

	// Shell exited on its own (user typed `exit`, crash, …).
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

	// A SIGTERM/SIGINT to the host (e.g. launcher fallback kill) tears down cleanly.
	for (const sig of ["SIGTERM", "SIGINT"] as const) {
		process.on(sig, () => void shutdown(0));
	}

	// Readiness signal: metadata is now discoverable by any client/launcher.
	persist();
}
