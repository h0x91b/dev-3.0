import type { ResourceUsage } from "../shared/types";
import { collectProcessInfo, collectDescendants, getAllSessionPanePids } from "./port-scanner";
import { DEFAULT_TMUX_SOCKET, devServerSessionForTaskSession, parseDev3SessionName, TASK_SESSION_PREFIX } from "./tmux";
import { createLogger } from "./logger";
import { updateCaffeinateState } from "./caffeinate";

const log = createLogger("resource-monitor");
const POLL_INTERVAL_MS = 10_000;

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
 * Task session names from a pane map (excluding cleanup, dev-server,
 * project-terminal sessions).
 */
function filterTaskSessions(paneMap: Map<string, number[]>): string[] {
	return [...paneMap.keys()].filter((name) => parseDev3SessionName(name)?.kind === "task");
}

async function poll() {
	try {
		if (!pushMessageFn) return;

		// One tmux call for all sessions AND all their pane PIDs — this poller
		// used to spawn `tmux list-sessions` + 2 `list-panes` per session,
		// synchronously, which stalled the main loop under load.
		const paneMap = await getAllSessionPanePids(DEFAULT_TMUX_SOCKET);
		const sessionNames = filterTaskSessions(paneMap);
		const activeShortIds = new Set(sessionNames.map((n) => n.slice(TASK_SESSION_PREFIX.length)));

		// Keep the machine awake while the app runs (per setting) or while
		// remote access is active (forced on). Import the remote-access module
		// lazily so this poller stays free of electrobun-heavy imports.
		import("./remote-access-server")
			.then(({ isRemoteAccessActive }) => updateCaffeinateState(isRemoteAccessActive()))
			.catch(() => updateCaffeinateState(false));

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
		const { tree, resources } = await collectProcessInfo();

		for (const sessionName of sessionNames) {
			const shortId = sessionName.slice(TASK_SESSION_PREFIX.length);
			try {
				// Pane PIDs from the shared map (main session + dev server session)
				const panePids = [...(paneMap.get(sessionName) ?? [])];
				panePids.push(...(paneMap.get(devServerSessionForTaskSession(sessionName)) ?? []));

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
