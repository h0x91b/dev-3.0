import type { ResourceUsage } from "../shared/types";
import { collectTaskPids } from "./port-scanner";
import { spawnSync } from "./spawn";
import { createLogger } from "./logger";

const log = createLogger("resource-monitor");
const POLL_INTERVAL_MS = 10_000;

type PushMessageFn = (name: string, payload: unknown) => void;
type ActiveSessionsFn = () => Array<{ taskId: string; tmuxSocket: string }>;

let pollTimer: ReturnType<typeof setTimeout> | null = null;
let pushMessageFn: PushMessageFn | null = null;
let getActiveSessionsFn: ActiveSessionsFn | null = null;

const usageCache = new Map<string, string>();
const usageData = new Map<string, ResourceUsage>();

function parsePsOutput(output: string): { rss: number; cpu: number } {
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

function poll() {
	try {
		if (!getActiveSessionsFn || !pushMessageFn) return;
		const sessions = getActiveSessionsFn();
		const activeTaskIds = new Set(sessions.map((s) => s.taskId));

		for (const taskId of usageCache.keys()) {
			if (!activeTaskIds.has(taskId)) {
				usageCache.delete(taskId);
				usageData.delete(taskId);
			}
		}

		for (const { taskId, tmuxSocket } of sessions) {
			const sessionName = `dev3-${taskId.slice(0, 8)}`;
			try {
				const pids = collectTaskPids(tmuxSocket, sessionName);
				if (pids.size === 0) continue;

				const pidList = Array.from(pids).join(",");
				const result = spawnSync(["ps", "-o", "pid=,rss=,%cpu=", "-p", pidList]);
				if (result.exitCode !== 0 && result.exitCode !== 1) continue;
				const output = new TextDecoder().decode(result.stdout).trim();
				const usage = parsePsOutput(output);

				const prev = usageData.get(taskId);
				const cpuChanged = !prev || Math.abs(usage.cpu - prev.cpu) > 1;
				const rssChanged = !prev || Math.abs(usage.rss - prev.rss) > 1024 * 1024;

				if (cpuChanged || rssChanged) {
					usageCache.set(taskId, JSON.stringify(usage));
					usageData.set(taskId, usage);
					pushMessageFn!("resourceUsageUpdated", { taskId, usage });
				}
			} catch (err) {
				log.warn("Resource usage scan failed for task", { taskId: taskId.slice(0, 8), error: String(err) });
			}
		}
	} catch (err) {
		log.error("Resource monitor poll cycle failed", { error: String(err) });
	} finally {
		pollTimer = setTimeout(poll, POLL_INTERVAL_MS);
	}
}

export function startResourceMonitor(push: PushMessageFn, getActiveSessions: ActiveSessionsFn): void {
	pushMessageFn = push;
	getActiveSessionsFn = getActiveSessions;
	log.info("Resource monitor started", { intervalMs: POLL_INTERVAL_MS });
	pollTimer = setTimeout(poll, POLL_INTERVAL_MS);
}

export function stopResourceMonitor(): void {
	if (pollTimer) {
		clearTimeout(pollTimer);
		pollTimer = null;
	}
}

export function getResourceUsage(taskId: string): ResourceUsage | undefined {
	return usageData.get(taskId);
}
