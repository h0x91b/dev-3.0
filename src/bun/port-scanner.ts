import type { PortInfo } from "../shared/types";
import { spawnSync } from "./spawn";
import { tmuxArgs } from "./pty-server";
import { createLogger } from "./logger";

const log = createLogger("port-scanner");
const decoder = new TextDecoder();

// ── Shared process info cache ─────────────────────────────────────

const PROCESS_INFO_CACHE_MS = 5_000;

type ProcessInfoResult = {
	tree: Map<number, number[]>;
	resources: Map<number, { rss: number; cpu: number }>;
};

let _processInfoCache: { result: ProcessInfoResult; expiry: number } | null = null;

/** Reset the process info cache. Exposed for test isolation. */
export function clearProcessInfoCache(): void {
	_processInfoCache = null;
}

/**
 * Collect ALL process info in a single `ps` call.
 * Returns a process tree (parent → children) and per-PID resource data (rss, cpu).
 *
 * Results are cached for PROCESS_INFO_CACHE_MS so that both pollers
 * (port-scanner and resource-monitor) share a single spawn per cycle.
 */
export function collectProcessInfo(): ProcessInfoResult {
	const now = Date.now();
	if (_processInfoCache && now < _processInfoCache.expiry) return _processInfoCache.result;

	const tree = new Map<number, number[]>();
	const resources = new Map<number, { rss: number; cpu: number }>();
	try {
		const result = spawnSync(["ps", "-eo", "pid=,ppid=,rss=,%cpu="]);
		if (result.exitCode !== 0) {
			_processInfoCache = { result: { tree, resources }, expiry: now + PROCESS_INFO_CACHE_MS };
			return { tree, resources };
		}
		const output = decoder.decode(result.stdout);
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
	} catch {
		// ignore
	}
	const finalResult = { tree, resources };
	_processInfoCache = { result: finalResult, expiry: now + PROCESS_INFO_CACHE_MS };
	return finalResult;
}

/**
 * Get pane PIDs for a tmux session.
 */
export function getSessionPanePids(socket: string, sessionName: string): number[] {
	try {
		const result = spawnSync(tmuxArgs(socket, "list-panes", "-t", sessionName, "-F", "#{pane_pid}"));
		if (result.exitCode !== 0) return [];
		const output = decoder.decode(result.stdout).trim();
		if (!output) return [];
		return output.split("\n").map((s) => parseInt(s.trim(), 10)).filter((n) => !isNaN(n));
	} catch {
		return [];
	}
}

/**
 * Recursively get all descendant PIDs of a given PID using pgrep.
 */
export function getDescendantPids(pid: number): number[] {
	const descendants: number[] = [];
	const queue = [pid];
	while (queue.length > 0) {
		const current = queue.shift()!;
		try {
			const result = spawnSync(["pgrep", "-P", String(current)]);
			if (result.exitCode !== 0) continue;
			const output = decoder.decode(result.stdout).trim();
			if (!output) continue;
			for (const line of output.split("\n")) {
				const childPid = parseInt(line.trim(), 10);
				if (!isNaN(childPid)) {
					descendants.push(childPid);
					queue.push(childPid);
				}
			}
		} catch {
			// ignore
		}
	}
	return descendants;
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
 * Run lsof once and return raw stdout. Shared across all tasks in a poll cycle.
 */
export function getLsofOutput(): string {
	try {
		const result = spawnSync(["lsof", "-i", "-P", "-n", "-sTCP:LISTEN", "-F", "pcn"]);
		if (result.exitCode !== 0) return "";
		return decoder.decode(result.stdout);
	} catch {
		return "";
	}
}

/**
 * Build a complete process tree from a single `ps` call.
 * Returns a Map of parent PID → child PIDs.
 * Replaces per-PID `pgrep -P` calls with one O(1) spawn.
 */
export function buildProcessTree(): Map<number, number[]> {
	const tree = new Map<number, number[]>();
	try {
		const result = spawnSync(["ps", "-eo", "pid=,ppid="]);
		if (result.exitCode !== 0) return tree;
		const output = decoder.decode(result.stdout);
		for (const line of output.split("\n")) {
			const trimmed = line.trim();
			if (!trimmed) continue;
			const parts = trimmed.split(/\s+/);
			if (parts.length < 2) continue;
			const pid = parseInt(parts[0], 10);
			const ppid = parseInt(parts[1], 10);
			if (isNaN(pid) || isNaN(ppid)) continue;
			let children = tree.get(ppid);
			if (!children) {
				children = [];
				tree.set(ppid, children);
			}
			children.push(pid);
		}
	} catch {
		// ignore
	}
	return tree;
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
 * When `processTree` is provided, uses in-memory BFS (no extra spawns).
 * Otherwise falls back to per-PID `pgrep -P` calls.
 */
export function collectTaskPids(socket: string, sessionName: string, processTree?: Map<number, number[]>): Set<number> {
	const panePids = getSessionPanePids(socket, sessionName);

	// Dev server sessions (dev3-dev-XXXX) run in a separate tmux session
	// that is not tracked as a PtySession. Include their PIDs too.
	if (sessionName.startsWith("dev3-") && !sessionName.startsWith("dev3-dev-")) {
		const devSessionName = `dev3-dev-${sessionName.slice("dev3-".length)}`;
		const devPanePids = getSessionPanePids(socket, devSessionName);
		panePids.push(...devPanePids);
	}

	const allPids = new Set<number>(panePids);
	for (const pid of panePids) {
		const descendants = processTree
			? collectDescendants(pid, processTree)
			: getDescendantPids(pid);
		for (const d of descendants) {
			allPids.add(d);
		}
	}
	return allPids;
}

/**
 * Scan listening TCP ports for a tmux session.
 * Optionally accepts pre-fetched lsof output to avoid redundant calls.
 */
export function scanTaskPorts(socket: string, sessionName: string, lsofOutput?: string, processTree?: Map<number, number[]>): PortInfo[] {
	const allPids = collectTaskPids(socket, sessionName, processTree);
	if (allPids.size === 0) return [];

	const output = lsofOutput ?? getLsofOutput();
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

function poll() {
	try {
		if (!getActiveSessionsFn || !pushMessageFn) return;

		const sessions = getActiveSessionsFn();
		const activeTaskIds = new Set(sessions.map((s) => s.taskId));

		// Clean up stale cache entries
		for (const taskId of portCache.keys()) {
			if (!activeTaskIds.has(taskId)) {
				portCache.delete(taskId);
				portData.delete(taskId);
			}
		}

		// Build process tree and run lsof once for all tasks
		// collectProcessInfo is TTL-cached — shared with resource-monitor poller to avoid duplicate ps spawns
		const processTree = sessions.length > 0 ? collectProcessInfo().tree : new Map<number, number[]>();
		const lsofOutput = sessions.length > 0 ? getLsofOutput() : "";

		for (const { taskId, tmuxSocket } of sessions) {
			const sessionName = `dev3-${taskId.slice(0, 8)}`;
			try {
				const ports = scanTaskPorts(tmuxSocket, sessionName, lsofOutput, processTree);
				const serialized = JSON.stringify(ports);
				if (portCache.get(taskId) !== serialized) {
					portCache.set(taskId, serialized);
					portData.set(taskId, ports);
					pushMessageFn!("portsUpdated", { taskId, ports });
				}
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
