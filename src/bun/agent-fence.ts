/**
 * The app side of the agent delivery fence: close requests from wrappers that could not
 * close their own fence (their tmux binary was gone, e.g. an app-bundle swap mid-update).
 *
 * Such a wrapper starts NO shell. It writes `<index>/<launchId>.close` and waits, saving
 * whatever lands in the pane, until an app instance has closed the fence inside tmux and
 * acknowledged it with `<launchId>.closed-ack`. Every instance sweeps the one flat index at
 * startup and every few seconds, and a pin that meets an open fence with a pending request
 * refuses the write. The close itself is `TmuxClient.closeAgentFence`: one compare-and-set,
 * so any number of instances produce exactly one sentinel.
 *
 * The index lives beside the other `~/.dev3.0` state as a NEW directory; nothing is renamed
 * or moved, and only this protocol's own validated file names are ever deleted.
 * See `decisions/2026/09/28/agent-delivery-fence.md`.
 */

import { randomUUID } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { mkdir, readFile, readdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { isAgentFenceLaunchId, parseAgentFence } from "../shared/agent-fence";
import { createLogger } from "./logger";
import { agentFenceIndexDir } from "./agent-fence-paths";
import { DEFAULT_TMUX_SOCKET, tmux } from "./tmux";
import { tmuxSocketDir } from "./tmux/socket-files";
import { probeSocketLiveness } from "./tmux/socket-sweep";

const log = createLogger("agent-fence");


/** How often a running app sweeps; the wrapper waits at least this long for a close. */
export const AGENT_FENCE_SWEEP_INTERVAL_MS = 2_000;

/** An ack whose request is gone is harmless, but is removed after this long. */
export const AGENT_FENCE_ORPHAN_ACK_MS = 60 * 60 * 1000;

const REQUEST_SUFFIX = ".close";
const ACK_SUFFIX = ".closed-ack";

export interface AgentFenceCloseRequest {
	launchId: string;
	paneId: string;
	/** The tmux socket PATH the wrapper saw in `$TMUX`. */
	socketPath: string;
	exitCode: number;
	/** The task the wrapper was generated for; absent only in hand-written requests. */
	taskId?: string;
}

/** Parse one request file; null for anything this protocol did not write. */
export function parseAgentFenceCloseRequest(fileName: string, content: string): AgentFenceCloseRequest | null {
	if (!fileName.endsWith(REQUEST_SUFFIX)) return null;
	const launchId = fileName.slice(0, -REQUEST_SUFFIX.length);
	if (!isAgentFenceLaunchId(launchId)) return null;
	const [id, paneId, socketPath, code, taskId] = content.trim().split(" ");
	if (id !== launchId || !paneId || !/^%\d+$/.test(paneId) || !socketPath?.startsWith("/")) return null;
	if (!code || !/^(0|[1-9][0-9]{0,2})$/.test(code) || Number(code) > 255) return null;
	if (taskId !== undefined && !/^[0-9a-f-]{8,64}$/.test(taskId)) return null;
	return { launchId, paneId, socketPath, exitCode: Number(code), ...(taskId ? { taskId } : {}) };
}

function realpathOrNull(path: string): string | null {
	try {
		return realpathSync(path);
	} catch {
		return null;
	}
}

/**
 * The `-L` name for a request's socket path, when it is a server of THIS user's tmux socket
 * directory — compared by realpath, because `$TMUX` may say `/tmp` where tmux resolved
 * `/private/tmp`. A socket elsewhere is not one this app can address.
 */
export function socketNameForPath(socketPath: string, socketDir: string = tmuxSocketDir()): string | null {
	const dir = realpathOrNull(dirname(socketPath));
	const ours = realpathOrNull(socketDir);
	if (!dir || !ours || dir !== ours) return null;
	const name = basename(socketPath);
	return /^[A-Za-z0-9_.-]+$/.test(name) ? name : null;
}

/**
 * Whether a wrapper asked for `launchId`'s fence to be closed. A pin that sees `true`
 * refuses its write and kicks the close, so the guard is the authority again at once.
 */
export async function agentFenceCloseRequested(launchId: string, socket: string = DEFAULT_TMUX_SOCKET): Promise<boolean> {
	if (!isAgentFenceLaunchId(launchId)) return false;
	const path = join(agentFenceIndexDir(), `${launchId}${REQUEST_SUFFIX}`);
	if (!existsSync(path)) return false;
	void sweepAgentFenceRequests({ only: launchId }).catch((err) =>
		log.warn("agent fence close on pin failed", { launchId, socket, error: String(err) }),
	);
	return true;
}

/** Write a file atomically under the index with a per-writer tmp name, so two instances never share one. */
async function writeAtomically(dir: string, name: string, content: string): Promise<void> {
	const tmp = join(dir, `.${name}.${randomUUID().slice(0, 8)}.tmp`);
	await writeFile(tmp, content, { encoding: "utf8", flag: "wx" });
	await rename(tmp, join(dir, name));
}

export interface AgentFenceSweepReport {
	closed: string[];
	removed: string[];
	kept: string[];
}

export type AgentFenceLateCloseListener = (request: AgentFenceCloseRequest) => void;

let lateCloseListener: AgentFenceLateCloseListener | null = null;

/** Who hears that an app closed a fence late (the badge and the message-log record). */
export function onAgentFenceLateClose(listener: AgentFenceLateCloseListener | null): void {
	lateCloseListener = listener;
}

let sweeping: Promise<AgentFenceSweepReport> | null = null;

/**
 * One pass over the index. Serialised per process; across processes the compare-and-set
 * inside tmux is what makes concurrent sweeps safe.
 */
export function sweepAgentFenceRequests(opts: { only?: string; nowMs?: number } = {}): Promise<AgentFenceSweepReport> {
	if (sweeping) return sweeping.then(() => sweepAgentFenceRequests(opts));
	sweeping = runSweep(opts).finally(() => {
		sweeping = null;
	});
	return sweeping;
}

async function runSweep(opts: { only?: string; nowMs?: number }): Promise<AgentFenceSweepReport> {
	const report: AgentFenceSweepReport = { closed: [], removed: [], kept: [] };
	const dir = agentFenceIndexDir();
	let names: string[];
	try {
		names = await readdir(dir);
	} catch {
		return report;
	}
	const now = opts.nowMs ?? Date.now();
	const present = new Set(names);
	for (const name of names) {
		if (name.endsWith(ACK_SUFFIX)) {
			await collectOrphanAck(dir, name, present, now, report);
			continue;
		}
		if (!name.endsWith(REQUEST_SUFFIX)) continue;
		if (opts.only && name !== `${opts.only}${REQUEST_SUFFIX}`) continue;
		let content: string;
		try {
			content = await readFile(join(dir, name), "utf8");
		} catch {
			continue;
		}
		const request = parseAgentFenceCloseRequest(name, content);
		if (!request) continue; // not this protocol's: never touched
		// Already acknowledged: the wrapper owns it now. Closing again would be harmless, but a
		// second sentinel would reach the user's shell after the handover.
		if (present.has(`${request.launchId}${ACK_SUFFIX}`)) {
			report.kept.push(request.launchId);
			continue;
		}
		await handleRequest(dir, name, request, report);
	}
	return report;
}

async function handleRequest(dir: string, name: string, request: AgentFenceCloseRequest, report: AgentFenceSweepReport): Promise<void> {
	const socket = socketNameForPath(request.socketPath);
	if (!socket) {
		report.kept.push(request.launchId);
		return;
	}
	const closed = await tmux.closeAgentFence({
		pane: request.paneId,
		launchId: request.launchId,
		exitCode: request.exitCode,
		socket,
	});
	if (closed.kind === "closed") {
		try {
			await writeAtomically(dir, `${request.launchId}${ACK_SUFFIX}`, `${request.launchId} closed:${request.launchId}:${request.exitCode} ${closed.nonce}\n`);
		} catch (err) {
			// The fence is closed in tmux, so the guard already refuses; the ack is retried next sweep.
			log.warn("agent fence closed but its ack could not be written", { launchId: request.launchId, error: String(err) });
			report.kept.push(request.launchId);
			return;
		}
		report.closed.push(request.launchId);
		log.warn("agent fence closed late by the app", { launchId: request.launchId, pane: request.paneId, socket });
		try {
			lateCloseListener?.(request);
		} catch (err) {
			log.warn("agent fence late-close listener failed", { error: String(err) });
		}
		return;
	}
	if (await launchIsGone(request, socket)) {
		await unlink(join(dir, name)).catch(() => {});
		report.removed.push(request.launchId);
		return;
	}
	report.kept.push(request.launchId);
}

/**
 * True only when the server proves this launch has no pane left: it answered and no pane
 * carries its fence, or its socket has no server behind it at all. "Cannot tell" keeps it.
 */
async function launchIsGone(request: AgentFenceCloseRequest, socket: string): Promise<boolean> {
	try {
		const rows = await tmux.listAgentFences({ socket });
		return !rows.some((row) => {
			const state = parseAgentFence(row.agentFence);
			return (state.kind === "open" || state.kind === "closed") && state.launchId === request.launchId;
		});
	} catch {
		return (await probeSocketLiveness(request.socketPath)) === "dead";
	}
}

/** An ack with no request left (the wrapper already cleaned up) goes once it is old enough. */
async function collectOrphanAck(dir: string, name: string, present: Set<string>, now: number, report: AgentFenceSweepReport): Promise<void> {
	const launchId = name.slice(0, -ACK_SUFFIX.length);
	if (!isAgentFenceLaunchId(launchId) || present.has(`${launchId}${REQUEST_SUFFIX}`)) return;
	try {
		const info = await stat(join(dir, name));
		if (now - info.mtimeMs < AGENT_FENCE_ORPHAN_ACK_MS) return;
		await unlink(join(dir, name));
		report.removed.push(launchId);
	} catch {
		/* raced another instance; nothing to do */
	}
}

let sweeper: ReturnType<typeof setInterval> | null = null;

/** Ensure the index exists, sweep once now, then keep sweeping. Idempotent. */
export async function startAgentFenceSweeper(): Promise<void> {
	if (sweeper) return;
	await mkdir(agentFenceIndexDir(), { recursive: true }).catch(() => {});
	const tick = () =>
		void sweepAgentFenceRequests().catch((err) => log.warn("agent fence sweep failed", { error: String(err) }));
	tick();
	sweeper = setInterval(tick, AGENT_FENCE_SWEEP_INTERVAL_MS);
	sweeper.unref?.();
}

export function stopAgentFenceSweeper(): void {
	if (sweeper) clearInterval(sweeper);
	sweeper = null;
}
