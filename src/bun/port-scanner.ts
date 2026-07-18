import type { PortInfo } from "../shared/types";
import { spawn } from "./spawn";
import { tmux, TASK_SESSION_PREFIX, DEV_SERVER_SESSION_PREFIX, devServerSessionForTaskSession, taskSessionName, PANE_PID_FORMAT, ALL_PANE_PIDS_FORMAT } from "./tmux";
import { createLogger } from "./logger";
import { cleanupTaskTunnels } from "./port-tunnels";

const log = createLogger("port-scanner");

// All process-inspection primitives here are ASYNC on purpose. They used to be
// Bun.spawnSync and ran on the main event loop from two 10-second pollers —
// with 30+ active sessions that meant 100+ synchronous forks per cycle, and
// under system load (agents compiling/testing) each fork slows 10-100x. The
// resulting multi-second loop stalls froze the whole UI, including terminal
// WebSocket upgrades ("Connecting..." forever). Do not reintroduce spawnSync
// in any code reachable from a poller or an RPC handler.

/**
 * Run a command asynchronously and return its stdout, or "" on failure.
 * Stdout is drained concurrently with awaiting exit (pipe-buffer deadlock).
 */
async function runText(cmd: string[]): Promise<string> {
	try {
		const proc = spawn(cmd, { stdout: "pipe", stderr: "pipe" });
		const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
		if (exitCode !== 0) return "";
		return stdout;
	} catch {
		return "";
	}
}

// ── Shared process info cache ─────────────────────────────────────

const PROCESS_INFO_CACHE_MS = 5_000;

type ProcessInfoResult = {
	tree: Map<number, number[]>;
	resources: Map<number, { rss: number; cpu: number }>;
};

let _processInfoCache: { promise: Promise<ProcessInfoResult>; expiry: number } | null = null;

/** Reset the process info cache. Exposed for test isolation. */
export function clearProcessInfoCache(): void {
	_processInfoCache = null;
}

/** Parse `ps -eo pid=,ppid=,rss=,%cpu=` output. Exported for tests. */
export function parseProcessInfoOutput(output: string): ProcessInfoResult {
	const tree = new Map<number, number[]>();
	const resources = new Map<number, { rss: number; cpu: number }>();
	for (const line of output.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		const parts = trimmed.split(/\s+/);
		if (parts.length < 4) continue;
		const pid = parseInt(parts[0], 10);
		const ppid = parseInt(parts[1], 10);
		const rss = parseInt(parts[2], 10);
		const cpu = parseFloat(parts[3]);
		if (isNaN(pid) || isNaN(ppid)) continue;
		let children = tree.get(ppid);
		if (!children) {
			children = [];
			tree.set(ppid, children);
		}
		children.push(pid);
		if (!isNaN(rss) && !isNaN(cpu)) {
			resources.set(pid, { rss: rss * 1024, cpu });
		}
	}
	return { tree, resources };
}

/**
 * Collect ALL process info in a single `ps` call.
 * Returns a process tree (parent → children) and per-PID resource data (rss, cpu).
 *
 * Results are cached for PROCESS_INFO_CACHE_MS so that both pollers
 * (port-scanner and resource-monitor) share a single spawn per cycle.
 * The cache stores the promise, so concurrent callers share one spawn too.
 */
export function collectProcessInfo(): Promise<ProcessInfoResult> {
	const now = Date.now();
	if (_processInfoCache && now < _processInfoCache.expiry) return _processInfoCache.promise;

	const promise = runText(["ps", "-eo", "pid=,ppid=,rss=,%cpu="]).then(parseProcessInfoOutput);
	_processInfoCache = { promise, expiry: now + PROCESS_INFO_CACHE_MS };
	return promise;
}

/**
 * Get pane PIDs for a tmux session.
 */
export async function getSessionPanePids(socket: string, sessionName: string): Promise<number[]> {
	try {
		const rows = await tmux.listPanes(PANE_PID_FORMAT, { target: sessionName, socket });
		return rows.map((row) => row.panePid).filter((pid) => pid > 0);
	} catch {
		return [];
	}
}

/**
 * Pane PIDs for EVERY session on a tmux server, in one `tmux list-panes -a`
 * call. The pollers use this instead of one `list-panes -t` per session —
 * with N sessions that collapses 2N tmux spawns per cycle into 1.
 */
export async function getAllSessionPanePids(socket: string): Promise<Map<string, number[]>> {
	const map = new Map<string, number[]>();
	let rows: Array<{ panePid: number; sessionName: string }>;
	try {
		rows = await tmux.listPanes(ALL_PANE_PIDS_FORMAT, { scope: "server", socket });
	} catch {
		return map;
	}
	for (const row of rows) {
		if (!row.sessionName || row.panePid <= 0) continue;
		let pids = map.get(row.sessionName);
		if (!pids) {
			pids = [];
			map.set(row.sessionName, pids);
		}
		pids.push(row.panePid);
	}
	return map;
}

/**
 * Recursively get all descendant PIDs of a given PID.
 *
 * Built on a single `ps -eo pid,ppid` snapshot (via {@link buildProcessTree}),
 * NOT `pgrep -P`. `pgrep` returns nothing when spawned from the packaged GUI
 * `.app` (its KERN_PROC_PPID sysctl is blocked under the hardened runtime /
 * sandbox), whereas `ps` enumerates the full table unaffected. Using `pgrep`
 * here silently orphaned the dev-server process tree on Stop. See decision 095.
 */
export async function getDescendantPids(pid: number): Promise<number[]> {
	return collectDescendants(pid, await buildProcessTree());
}

/**
 * Parse lsof output and filter by PID set.
 * Expected format from: lsof -i -P -n -sTCP:LISTEN -F pcn
 *
 * lsof -F output uses field identifiers:
 *   p<pid>   — process ID
 *   c<name>  — command name
 *   n<name>  — network name (contains :port)
 */
export function parseLsofOutput(output: string, pidSet: Set<number>): PortInfo[] {
	const ports: PortInfo[] = [];
	const seenPorts = new Set<number>();

	let currentPid = 0;
	let currentName = "";

	for (const line of output.split("\n")) {
		if (!line) continue;
		const tag = line[0];
		const value = line.slice(1);

		if (tag === "p") {
			currentPid = parseInt(value, 10);
			currentName = "";
		} else if (tag === "c") {
			currentName = value;
		} else if (tag === "n") {
			if (!pidSet.has(currentPid)) continue;
			// Extract port from network name like "*:3000" or "127.0.0.1:8080"
			const colonIdx = value.lastIndexOf(":");
			if (colonIdx < 0) continue;
			const port = parseInt(value.slice(colonIdx + 1), 10);
			if (isNaN(port) || port < 1 || port > 65535 || seenPorts.has(port)) continue;
			seenPorts.add(port);
			ports.push({ port, pid: currentPid, processName: currentName });
		}
	}

	ports.sort((a, b) => a.port - b.port);
	return ports;
}

/**
 * Parse lsof output (`-F pcn` format, same as {@link parseLsofOutput}) and
 * return the holders of the given PORTS, regardless of which process owns
 * them. Used to detect port conflicts and orphaned dev-server processes.
 */
export function parsePortHolders(output: string, portSet: Set<number>): PortInfo[] {
	const holders: PortInfo[] = [];
	const seenPorts = new Set<number>();

	let currentPid = 0;
	let currentName = "";

	for (const line of output.split("\n")) {
		if (!line) continue;
		const tag = line[0];
		const value = line.slice(1);

		if (tag === "p") {
			currentPid = parseInt(value, 10);
			currentName = "";
		} else if (tag === "c") {
			currentName = value;
		} else if (tag === "n") {
			const colonIdx = value.lastIndexOf(":");
			if (colonIdx < 0) continue;
			const port = parseInt(value.slice(colonIdx + 1), 10);
			if (isNaN(port) || !portSet.has(port) || seenPorts.has(port)) continue;
			seenPorts.add(port);
			holders.push({ port, pid: currentPid, processName: currentName });
		}
	}

	holders.sort((a, b) => a.port - b.port);
	return holders;
}

/**
 * Which processes are currently LISTENing on the given ports.
 * Optionally accepts pre-fetched lsof output to avoid redundant calls.
 */
export async function findPortHolders(ports: number[], lsofOutput?: string): Promise<PortInfo[]> {
	if (ports.length === 0) return [];
	const output = lsofOutput ?? (await getLsofOutput());
	if (!output) return [];
	return parsePortHolders(output, new Set(ports));
}

/**
 * Poll until none of the given ports has a LISTENing holder, or `timeoutMs`
 * elapses. Returns the holders still present at the end (empty = all free).
 */
export async function waitForPortsFree(ports: number[], timeoutMs: number, pollMs = 150): Promise<PortInfo[]> {
	if (ports.length === 0) return [];
	let holders = await findPortHolders(ports);
	for (let waited = 0; holders.length > 0 && waited < timeoutMs; waited += pollMs) {
		await new Promise((resolve) => setTimeout(resolve, pollMs));
		holders = await findPortHolders(ports);
	}
	return holders;
}

/**
 * Run lsof once and return raw stdout. Shared across all tasks in a poll cycle.
 */
export function getLsofOutput(): Promise<string> {
	return runText(["lsof", "-i", "-P", "-n", "-sTCP:LISTEN", "-F", "pcn"]);
}

/**
 * Build a complete process tree from a single `ps` call.
 * Returns a Map of parent PID → child PIDs.
 * Replaces per-PID `pgrep -P` calls with one O(1) spawn.
 */
export async function buildProcessTree(): Promise<Map<number, number[]>> {
	return (await collectProcessInfo()).tree;
}

/**
 * Get all descendants of a PID from a pre-built process tree (in-memory BFS).
 */
export function collectDescendants(pid: number, tree: Map<number, number[]>): number[] {
	const descendants: number[] = [];
	const queue = [pid];
	while (queue.length > 0) {
		const current = queue.shift()!;
		const children = tree.get(current);
		if (children) {
			for (const child of children) {
				descendants.push(child);
				queue.push(child);
			}
		}
	}
	return descendants;
}

/**
 * Build the full PID set (pane PIDs + all descendants) for a tmux session.
 * Also includes PIDs from the corresponding dev server session (dev3-dev-*)
 * if one exists, so that ports opened by `runDevServer` are detected.
 *
 * When `paneMap` (from {@link getAllSessionPanePids}) is provided, pane PIDs
 * come from it with zero extra spawns. When `processTree` is provided,
 * descendants come from in-memory BFS.
 */
export async function collectTaskPids(
	socket: string,
	sessionName: string,
	processTree?: Map<number, number[]>,
	paneMap?: Map<string, number[]>,
): Promise<Set<number>> {
	const sessionNames = [sessionName];

	// Dev server sessions (dev3-dev-XXXX) run in a separate tmux session
	// that is not tracked as a PtySession. Include their PIDs too.
	if (sessionName.startsWith(TASK_SESSION_PREFIX) && !sessionName.startsWith(DEV_SERVER_SESSION_PREFIX)) {
		sessionNames.push(devServerSessionForTaskSession(sessionName));
	}

	const panePids: number[] = [];
	for (const name of sessionNames) {
		if (paneMap) {
			panePids.push(...(paneMap.get(name) ?? []));
		} else {
			panePids.push(...(await getSessionPanePids(socket, name)));
		}
	}

	const tree = processTree ?? (await buildProcessTree());
	const allPids = new Set<number>(panePids);
	for (const pid of panePids) {
		for (const d of collectDescendants(pid, tree)) {
			allPids.add(d);
		}
	}
	return allPids;
}

/**
 * Scan listening TCP ports for a tmux session.
 * Optionally accepts pre-fetched lsof output to avoid redundant calls.
 */
export async function scanTaskPorts(
	socket: string,
	sessionName: string,
	lsofOutput?: string,
	processTree?: Map<number, number[]>,
	paneMap?: Map<string, number[]>,
): Promise<PortInfo[]> {
	const allPids = await collectTaskPids(socket, sessionName, processTree, paneMap);
	if (allPids.size === 0) return [];

	const output = lsofOutput ?? (await getLsofOutput());
	if (!output) return [];
	return parseLsofOutput(output, allPids);
}

// ── Background poller ──────────────────────────────────────────────

const POLL_INTERVAL_MS = 10_000;

type PushMessageFn = (name: string, payload: unknown) => void;
type ActiveSessionsFn = () => Array<{ taskId: string; tmuxSocket: string }>;

let pollTimer: ReturnType<typeof setTimeout> | null = null;
let pushMessageFn: PushMessageFn | null = null;
let getActiveSessionsFn: ActiveSessionsFn | null = null;

// Cache: taskId → PortInfo[] (serialized for comparison)
const portCache = new Map<string, string>();
// Cache: taskId → PortInfo[] (actual objects)
const portData = new Map<string, PortInfo[]>();

async function poll() {
	try {
		if (!getActiveSessionsFn || !pushMessageFn) return;

		const sessions = getActiveSessionsFn();
		const activeTaskIds = new Set(sessions.map((s) => s.taskId));

		// Clean up stale cache entries. Same hook tears down any port-tunnels
		// the gone task left behind — no need to wait for the liveness timer
		// when the whole tmux session is already dead.
		for (const taskId of portCache.keys()) {
			if (!activeTaskIds.has(taskId)) {
				portCache.delete(taskId);
				portData.delete(taskId);
				cleanupTaskTunnels(taskId);
			}
		}

		if (sessions.length === 0) return;

		// One ps + one lsof + one tmux list-panes -a for the whole cycle.
		// collectProcessInfo is TTL-cached — shared with the resource-monitor
		// poller firing in the same cycle.
		const processTree = (await collectProcessInfo()).tree;
		const lsofOutput = await getLsofOutput();
		const socketNames = new Set(sessions.map((s) => s.tmuxSocket));
		const paneMaps = new Map<string, Map<string, number[]>>();
		for (const socketName of socketNames) {
			paneMaps.set(socketName, await getAllSessionPanePids(socketName));
		}

		for (const { taskId, tmuxSocket } of sessions) {
			const sessionName = taskSessionName(taskId);
			try {
				const ports = await scanTaskPorts(tmuxSocket, sessionName, lsofOutput, processTree, paneMaps.get(tmuxSocket));
				const serialized = JSON.stringify(ports);
				if (portCache.get(taskId) !== serialized) {
					portCache.set(taskId, serialized);
					portData.set(taskId, ports);
					pushMessageFn!("portsUpdated", { taskId, ports });
				}
				// (Port-tunnel liveness used to be driven here, but tunnels now
				// operate on the project's allocated `$DEV3_PORT0..N` slots —
				// not on detected listening ports — so user explicitly starts
				// and stops them. Autodetect was generating false positives for
				// the app's own infrastructure ports.)
			} catch (err) {
				log.warn("Port scan failed for task", { taskId: taskId.slice(0, 8), error: String(err) });
			}
		}
	} catch (err) {
		log.error("Port scan poll cycle failed", { error: String(err) });
	} finally {
		pollTimer = setTimeout(poll, POLL_INTERVAL_MS);
	}
}

export function startPortScanPoller(
	push: PushMessageFn,
	getActiveSessions: ActiveSessionsFn,
): void {
	pushMessageFn = push;
	getActiveSessionsFn = getActiveSessions;
	log.info("Port scan poller started", { intervalMs: POLL_INTERVAL_MS });
	pollTimer = setTimeout(poll, POLL_INTERVAL_MS);
}

export function stopPortScanPoller(): void {
	if (pollTimer) {
		clearTimeout(pollTimer);
		pollTimer = null;
	}
}

/**
 * Get cached ports for a task (returns empty array if not scanned yet).
 */
export function getPortsForTask(taskId: string): PortInfo[] {
	return portData.get(taskId) ?? [];
}

/**
 * Drop the cached port scan for a task. Called after a dev-server teardown so
 * status/UI don't keep showing the dead server's ports for up to one poll
 * cycle (10s) after stop.
 */
export function clearPortDataForTask(taskId: string): void {
	portCache.delete(taskId);
	portData.delete(taskId);
}
