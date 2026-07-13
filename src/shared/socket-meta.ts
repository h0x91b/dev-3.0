/**
 * Sidecar metadata for a dev3 CLI control socket:
 * `~/.dev3.0/sockets/<pid>.sock` → `~/.dev3.0/sockets/<pid>.meta.json`.
 *
 * Written by the app when it binds its control socket. `hostTaskId` records the
 * dev3 task context this instance was launched from (the DEV3_TASK_ID env the
 * app injects into task/dev-server tmux panes): a dev-channel build booted by a
 * devScript, or a headless `dev3 remote` started from an agent pane. Such
 * "guest" instances share the data dir with the primary app, but must not win
 * socket discovery — a stop/restart routed into a guest hosted by the very dev
 * session being stopped kills the guest mid-request, so the reply never arrives
 * ("Empty response from server" / refused reconnects, issues #910/#920).
 *
 * The sidecar is additive and safe across versions: every existing socket-dir
 * scan filters on `.sock`, so older builds ignore it, and a missing or corrupt
 * sidecar simply means "primary instance" (today's behavior).
 */
export interface SocketMeta {
	pid: number;
	/** Full task UUID whose context launched this instance, or null for a primary. */
	hostTaskId: string | null;
	startedAt: string;
}

/** `<dir>/<pid>.sock` → `<dir>/<pid>.meta.json` */
export function socketMetaPathFor(socketPath: string): string {
	return socketPath.replace(/\.sock$/, ".meta.json");
}

export function socketMetaFileName(pid: number): string {
	return `${pid}.meta.json`;
}

/** Parse sidecar content; null on any mismatch (callers treat that as "primary"). */
export function parseSocketMeta(raw: string): SocketMeta | null {
	try {
		const parsed = JSON.parse(raw) as SocketMeta;
		if (typeof parsed !== "object" || parsed === null) return null;
		if (typeof parsed.pid !== "number") return null;
		return {
			pid: parsed.pid,
			hostTaskId: typeof parsed.hostTaskId === "string" && parsed.hostTaskId ? parsed.hostTaskId : null,
			startedAt: typeof parsed.startedAt === "string" ? parsed.startedAt : "",
		};
	} catch {
		return null;
	}
}
