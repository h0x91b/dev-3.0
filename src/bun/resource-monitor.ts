import type { ResourceUsage } from "../shared/types";
import { collectTaskPids } from "./port-scanner";
import { tmuxArgs } from "./pty-server";
import { spawnSync } from "./spawn";
import { createLogger } from "./logger";

const log = createLogger("resource-monitor");
const POLL_INTERVAL_MS = 10_000;
const TMUX_SOCKET = "dev3";

type PushMessageFn = (name: string, payload: unknown) => void;

let pollTimer: ReturnType<typeof setTimeout> | null = null;
let pushMessageFn: PushMessageFn | null = null;

const usageData = new Map<string, ResourceUsage>();

export function parsePsOutput(output: string): { rss: number; cpu: number } {
	let totalRss = 0;
	let totalCpu = 0;
	for (const line of output.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		const parts = trimmed.split(/\s+/);
		if (parts.length < 3) continue;
		const rss = parseInt(parts[1], 10);
		const cpu = parseFloat(parts[2]);
		if (!isNaN(rss)) totalRss += rss;
		if (!isNaN(cpu)) totalCpu += cpu;
	}
	return { rss: totalRss * 1024, cpu: totalCpu };
}

/**
 * Discover active task tmux sessions directly from tmux.
 * Returns session names like "dev3-abc12345" (excluding cleanup, dev-server, project-terminal).
 */
function discoverTmuxSessions(): string[] {
	try {
		const result = spawnSync(tmuxArgs(TMUX_SOCKET, "list-sessions", "-F", "#{session_name}"));
		if (result.exitCode !== 0) return [];
		const output = new TextDecoder().decode(result.stdout).trim();
		if (!output) return [];
		return output.split("\n")
			.map((s) => s.trim())
			.filter((name) =>
				name.startsWith("dev3-") &&
				!name.startsWith("dev3-cl-") &&
				!name.startsWith("dev3-dev-") &&
				!name.startsWith("dev3-pt-"),
			);
	} catch {
		return [];
	}
}

function poll() {
	try {
		if (!pushMessageFn) return;

		const sessionNames = discoverTmuxSessions();
		const activeShortIds = new Set(sessionNames.map((n) => n.slice(5))); // "dev3-XXXXXXXX" → "XXXXXXXX"

		// Clean up stale cache
		for (const shortId of usageData.keys()) {
			if (!activeShortIds.has(shortId)) {
				usageData.delete(shortId);
			}
		}

		for (const sessionName of sessionNames) {
			const shortId = sessionName.slice(5);
			try {
				const pids = collectTaskPids(TMUX_SOCKET, sessionName);
				if (pids.size === 0) continue;

				const pidList = Array.from(pids).join(",");
				const result = spawnSync(["ps", "-o", "pid=,rss=,%cpu=", "-p", pidList]);
				if (result.exitCode !== 0 && result.exitCode !== 1) continue;
				const output = new TextDecoder().decode(result.stdout).trim();
				const usage = parsePsOutput(output);

				const prev = usageData.get(shortId);
				const cpuChanged = !prev || Math.abs(usage.cpu - prev.cpu) > 1;
				const rssChanged = !prev || Math.abs(usage.rss - prev.rss) > 1024 * 1024;

				if (cpuChanged || rssChanged) {
					usageData.set(shortId, usage);
					pushMessageFn!("resourceUsageUpdated", { taskId: shortId, usage });
				}
			} catch (err) {
				log.warn("Resource usage scan failed", { session: sessionName, error: String(err) });
			}
		}
	} catch (err) {
		log.error("Resource monitor poll cycle failed", { error: String(err) });
	} finally {
		pollTimer = setTimeout(poll, POLL_INTERVAL_MS);
	}
}

export function startResourceMonitor(push: PushMessageFn): void {
	pushMessageFn = push;
	log.info("Resource monitor started", { intervalMs: POLL_INTERVAL_MS });
	pollTimer = setTimeout(poll, POLL_INTERVAL_MS);
}

export function stopResourceMonitor(): void {
	if (pollTimer) {
		clearTimeout(pollTimer);
		pollTimer = null;
	}
}

/**
 * Get cached resource usage for a task (by short ID — first 8 chars of taskId).
 */
export function getResourceUsage(taskId: string): ResourceUsage | undefined {
	return usageData.get(taskId.slice(0, 8));
}
