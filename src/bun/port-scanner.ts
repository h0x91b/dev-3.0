import type { PortInfo } from "../shared/types";
import { spawnSync } from "./spawn";
import { tmuxArgs } from "./pty-server";
import { createLogger } from "./logger";

const log = createLogger("port-scanner");

/**
 * Get pane PIDs for a tmux session.
 */
export function getSessionPanePids(socket: string, sessionName: string): number[] {
	try {
		const result = spawnSync(tmuxArgs(socket, "list-panes", "-t", sessionName, "-F", "#{pane_pid}"));
		if (result.exitCode !== 0) return [];
		const output = new TextDecoder().decode(result.stdout).trim();
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
			const output = new TextDecoder().decode(result.stdout).trim();
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
		return new TextDecoder().decode(result.stdout);
	} catch {
		return "";
	}
}

/**
 * Build the full PID set (pane PIDs + all descendants) for a tmux session.
 * Also includes PIDs from the corresponding dev server session (dev3-dev-*)
 * if one exists, so that ports opened by `runDevServer` are detected.
 */
export function collectTaskPids(socket: string, sessionName: string): Set<number> {
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
		for (const descendant of getDescendantPids(pid)) {
			allPids.add(descendant);
		}
	}
	return allPids;
}

/**
 * Scan listening TCP ports for a tmux session.
 * Optionally accepts pre-fetched lsof output to avoid redundant calls.
 */
export function scanTaskPorts(socket: string, sessionName: string, lsofOutput?: string): PortInfo[] {
	const allPids = collectTaskPids(socket, sessionName);
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

		// Run lsof once for all tasks (instead of per-task)
		const lsofOutput = sessions.length > 0 ? getLsofOutput() : "";

		for (const { taskId, tmuxSocket } of sessions) {
			const sessionName = `dev3-${taskId.slice(0, 8)}`;
			try {
				const ports = scanTaskPorts(tmuxSocket, sessionName, lsofOutput);
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
