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
 *
 * `ownerKey` identifies the logical renderer owner independently of one process
 * lifetime when the endpoint is stable. Desktop and random-port headless keys
 * remain process-scoped; explicitly port-bound headless keys survive restarts.
 * A separate additive `sockets/task-owners/<task UUID>.json` claim points at
 * this key so a long-lived agent can route renderer-coupled requests back to
 * native clients.
 */
export interface SocketMeta {
	pid: number;
	/** Full task UUID whose context launched this instance, or null for a primary. */
	hostTaskId: string | null;
	startedAt: string;
	ownerKey: string;
}

export interface TaskSocketOwner {
	taskId: string;
	ownerKey: string;
	claimedAt: number;
	/** Process generation that wrote the claim; discovery ignores it, release does not. */
	claimantPid: number | null;
}

const FULL_TASK_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SAFE_OWNER_KEY = /^[a-z0-9._:-]{1,128}$/i;

/** `<dir>/<pid>.sock` → `<dir>/<pid>.meta.json` */
export function socketMetaPathFor(socketPath: string): string {
	return socketPath.replace(/\.sock$/, ".meta.json");
}

export function socketMetaFileName(pid: number): string {
	return `${pid}.meta.json`;
}

export function socketOwnerKey(
	pid: number,
	env: NodeJS.ProcessEnv = process.env,
): string {
	if (env.DEV3_HEADLESS === "1") {
		const rawPort = Number(env.DEV3_REMOTE_PORT);
		if (Number.isInteger(rawPort) && rawPort > 0 && rawPort <= 65535) {
			return `remote:${rawPort}`;
		}
	}
	return `process:${pid}`;
}

export function isFullTaskUUID(taskId: string): boolean {
	return FULL_TASK_UUID.test(taskId);
}

export function taskSocketOwnerPath(socketsDir: string, taskId: string): string | null {
	return isFullTaskUUID(taskId) ? `${socketsDir}/task-owners/${taskId}.json` : null;
}

/** Parse sidecar content; null on any mismatch (callers treat that as "primary"). */
export function parseSocketMeta(raw: string): SocketMeta | null {
	try {
		const parsed = JSON.parse(raw) as SocketMeta;
		if (typeof parsed !== "object" || parsed === null) return null;
		if (typeof parsed.pid !== "number") return null;
		const ownerKey = typeof parsed.ownerKey === "string" && SAFE_OWNER_KEY.test(parsed.ownerKey)
			? parsed.ownerKey
			: `process:${parsed.pid}`;
		return {
			pid: parsed.pid,
			hostTaskId: typeof parsed.hostTaskId === "string" && parsed.hostTaskId ? parsed.hostTaskId : null,
			startedAt: typeof parsed.startedAt === "string" ? parsed.startedAt : "",
			ownerKey,
		};
	} catch {
		return null;
	}
}

export function parseTaskSocketOwner(raw: string): TaskSocketOwner | null {
	try {
		const parsed = JSON.parse(raw) as TaskSocketOwner;
		if (typeof parsed !== "object" || parsed === null) return null;
		if (typeof parsed.taskId !== "string" || !isFullTaskUUID(parsed.taskId)) return null;
		if (typeof parsed.ownerKey !== "string" || !SAFE_OWNER_KEY.test(parsed.ownerKey)) return null;
		if (typeof parsed.claimedAt !== "number" || !Number.isFinite(parsed.claimedAt) || parsed.claimedAt < 0) return null;
		const claimantPid = typeof parsed.claimantPid === "number" && Number.isInteger(parsed.claimantPid) && parsed.claimantPid > 0
			? parsed.claimantPid
			: null;
		return {
			taskId: parsed.taskId,
			ownerKey: parsed.ownerKey,
			claimedAt: parsed.claimedAt,
			claimantPid,
		};
	} catch {
		return null;
	}
}
