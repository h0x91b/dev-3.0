import type { ResourceUsage } from "../shared/types";
import { collectProcessInfo, collectDescendants, getSessionPanePids } from "./port-scanner";
import { tmuxArgs } from "./pty-server";
import { spawnSync } from "./spawn";
import { createLogger } from "./logger";

const log = createLogger("resource-monitor");
const POLL_INTERVAL_MS = 10_000;
const TMUX_SOCKET = "dev3";
const decoder = new TextDecoder();

type PushMessageFn = (name: string, payload: unknown) => void;

let pollTimer: ReturnType<typeof setTimeout> | null = null;
let pushMessageFn: PushMessageFn | null = null;

const usageData = new Map<string, ResourceUsage>();

/**
 * Aggregate resource usage for a set of PIDs from pre-collected data.
 */
export function aggregateResources(
	pids: Set<number>,
	resources: Map<number, { rss: number; cpu: number }>,
): ResourceUsage {
	let totalRss = 0;
	let totalCpu = 0;
	for (const pid of pids) {
		const info = resources.get(pid);
		if (info) {
			totalRss += info.rss;
			totalCpu += info.cpu;
		}
	}
	return { rss: totalRss, cpu: totalCpu };
}

/**
 * Discover active task tmux sessions directly from tmux.
 * Returns session names like "dev3-abc12345" (excluding cleanup, dev-server, project-terminal).
 */
function discoverTmuxSessions(): string[] {
	try {
		const result = spawnSync(tmuxArgs(TMUX_SOCKET, "list-sessions", "-F", "#{session_name}"));
		if (result.exitCode !== 0) return [];
		const output = decoder.decode(result.stdout).trim();
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
		const activeShortIds = new Set(sessionNames.map((n) => n.slice(5)));

		// Clean up stale cache and notify renderer
		for (const shortId of usageData.keys()) {
			if (!activeShortIds.has(shortId)) {
				usageData.delete(shortId);
				pushMessageFn("resourceUsageUpdated", {
					taskId: shortId,
					usage: { cpu: 0, rss: 0 },
				});
			}
		}

		if (sessionNames.length === 0) return;

		// Shared process info — TTL-cached in port-scanner, so port-scanner poller
		// firing in the same cycle reuses this result without a second ps spawn.
		const { tree, resources } = collectProcessInfo();

		for (const sessionName of sessionNames) {
			const shortId = sessionName.slice(5);
			try {
				// Get pane PIDs from tmux (main session + dev server session)
				const panePids = getSessionPanePids(TMUX_SOCKET, sessionName);
				const devPanePids = getSessionPanePids(TMUX_SOCKET, `dev3-dev-${shortId}`);
				panePids.push(...devPanePids);

				if (panePids.length === 0) continue;

				// Build full PID set using collectDescendants (in-memory BFS, no extra spawns)
				const allPids = new Set<number>(panePids);
				for (const pid of panePids) {
					for (const d of collectDescendants(pid, tree)) {
						allPids.add(d);
					}
				}

				// Aggregate resources from pre-collected data (no extra spawns)
				const usage = aggregateResources(allPids, resources);

				const prev = usageData.get(shortId);
				const cpuChanged = !prev || Math.abs(usage.cpu - prev.cpu) > 1;
				const rssChanged = !prev || Math.abs(usage.rss - prev.rss) > 1024 * 1024;

				if (cpuChanged || rssChanged) {
					usageData.set(shortId, usage);
					pushMessageFn("resourceUsageUpdated", { taskId: shortId, usage });
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
	usageData.clear();
}

/**
 * Get cached resource usage for a task (by short ID — first 8 chars of taskId).
 */
export function getResourceUsage(taskId: string): ResourceUsage | undefined {
	return usageData.get(taskId.slice(0, 8));
}
