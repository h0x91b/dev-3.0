import { getTaskTitle } from "../shared/types";
import type { WorktreeDiskUsage } from "../shared/types";
import { createLogger } from "./logger";
import { spawn } from "./spawn";
import { parseDuOutput } from "./system-load";

const log = createLogger("worktree-disk-usage");

const DISK_SCAN_TTL_MS = 5 * 60_000;
let diskScan: { at: number; result: Promise<WorktreeDiskUsage[]> } | null = null;

/**
 * `du` over every worktree takes tens of seconds on a real board (node_modules),
 * so one scan serves every flyout open for five minutes, in flight included.
 */
export async function scanWorktreeDiskUsage(): Promise<WorktreeDiskUsage[]> {
	if (!diskScan || Date.now() - diskScan.at > DISK_SCAN_TTL_MS) {
		const scan = { at: Date.now(), result: measureWorktrees() };
		// A failed scan must not be served for five minutes.
		scan.result.catch(() => {
			if (diskScan === scan) diskScan = null;
		});
		diskScan = scan;
	}
	return diskScan.result;
}

/**
 * Every existing task worktree's size, largest first. Reads `task.worktreePath`
 * rather than walking ~/.dev3.0/worktrees, so custom clone paths count too.
 * One `du` for all of them; where `du` is missing (Windows) the list is empty.
 */
async function measureWorktrees(): Promise<WorktreeDiskUsage[]> {
	const { loadProjects, loadVirtualProjects, loadTasks } = await import("./data");
	const byPath = new Map<string, Omit<WorktreeDiskUsage, "bytes">>();
	for (const project of [...(await loadProjects()), ...(await loadVirtualProjects())]) {
		for (const task of await loadTasks(project)) {
			if (!task.worktreePath) continue;
			byPath.set(task.worktreePath, {
				shortId: task.id.slice(0, 8),
				taskId: task.id,
				title: getTaskTitle(task),
				projectId: project.id,
			});
		}
	}
	if (byPath.size === 0) return [];
	let output: string;
	try {
		// du exits non-zero when any path vanished or is unreadable; the rest is still valid.
		const proc = spawn(["du", "-sk", ...byPath.keys()], { stdout: "pipe", stderr: "ignore" });
		output = await new Response(proc.stdout).text();
		await proc.exited;
	} catch (err) {
		log.warn("du unavailable", { error: String(err) });
		return [];
	}
	const sizes = parseDuOutput(output);
	const result: WorktreeDiskUsage[] = [];
	for (const [path, task] of byPath) {
		const bytes = sizes.get(path);
		if (bytes !== undefined) result.push({ ...task, bytes });
	}
	return result.sort((a, b) => b.bytes - a.bytes);
}
