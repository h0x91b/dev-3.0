import { existsSync } from "node:fs";
import type { ProductivityStatEvent, ProductivityStats, Project, Task } from "../../shared/types";
import { getTaskTitle } from "../../shared/types";
import * as data from "../data";
import * as git from "../git";
import { log } from "./shared";

type RawDiff = { files: number; insertions: number; deletions: number };

/**
 * Build one {@link ProductivityStatEvent} from a task. Pure — LOC comes from the
 * passed-in `liveDiff` (computed from a live worktree) when present, otherwise
 * the task's captured `completedDiffStats`, otherwise zero.
 */
export function toStatEvent(
	project: Pick<Project, "id" | "name" | "kind">,
	task: Task,
	liveDiff?: RawDiff | null,
): ProductivityStatEvent {
	const diff: RawDiff = liveDiff ?? task.completedDiffStats ?? { files: 0, insertions: 0, deletions: 0 };
	return {
		taskId: task.id,
		projectId: project.id,
		projectName: project.name,
		projectKind: project.kind === "virtual" ? "virtual" : "git",
		title: getTaskTitle(task),
		status: task.status,
		createdAt: task.createdAt,
		movedAt: task.movedAt ?? null,
		lifecycleStartedAt: task.lifecycleStartedAt ?? null,
		insertions: diff.insertions,
		deletions: diff.deletions,
		files: diff.files,
		liveStats: !!liveDiff,
		agentId: task.agentId ?? null,
		groupId: task.groupId ?? null,
		variantIndex: task.variantIndex ?? null,
		statusDurations: task.statusDurations ?? {},
		statusEnteredAt: task.statusEnteredAt ?? null,
		focusMs: task.focusMs ?? 0,
	};
}

/** True for a non-virtual task whose live worktree should be diffed for current LOC. */
function shouldComputeLiveDiff(project: Project, task: Task): boolean {
	return (
		project.kind !== "virtual" &&
		!task.completedDiffStats &&
		!!task.worktreePath &&
		task.status !== "completed" &&
		task.status !== "cancelled" &&
		existsSync(task.worktreePath)
	);
}

/** Best-effort current diff of an active worktree (origin base, local fallback). Never throws. */
async function computeLiveDiff(project: Project, task: Task): Promise<RawDiff | null> {
	const baseBranch = task.baseBranch || project.defaultBaseBranch || "main";
	try {
		const stats = await git.getBranchDiffStats(task.worktreePath!, `origin/${baseBranch}`);
		if (stats.files === 0 && stats.insertions === 0 && stats.deletions === 0) {
			const local = await git.getBranchDiffStats(task.worktreePath!, baseBranch);
			if (local.files > 0 || local.insertions > 0 || local.deletions > 0) return local;
		}
		return stats;
	} catch (err) {
		log.warn("computeLiveDiff failed (best-effort)", { taskId: task.id.slice(0, 8), error: String(err) });
		return null;
	}
}

/**
 * Aggregate per-task productivity stat events across ALL projects (git + virtual)
 * from local data only. Completed/cancelled tasks contribute their captured
 * `completedDiffStats`; active tasks contribute a live worktree diff. The
 * renderer buckets these client-side per the selected time range.
 */
export async function getProductivityStats(): Promise<ProductivityStats> {
	const [gitProjects, virtualProjects] = await Promise.all([
		data.loadProjects(),
		data.loadVirtualProjects(),
	]);
	const allProjects = [...gitProjects, ...virtualProjects];

	const events: ProductivityStatEvent[] = [];
	const liveJobs: Promise<void>[] = [];

	for (const project of allProjects) {
		let tasks: Task[];
		try {
			tasks = await data.loadTasks(project);
		} catch (err) {
			log.warn("getProductivityStats: loadTasks failed", { projectId: project.id, error: String(err) });
			continue;
		}
		for (const task of tasks) {
			if (shouldComputeLiveDiff(project, task)) {
				const idx = events.length;
				events.push(toStatEvent(project, task, null)); // placeholder; patched below
				liveJobs.push(
					computeLiveDiff(project, task).then((diff) => {
						if (diff) events[idx] = toStatEvent(project, task, diff);
					}),
				);
			} else {
				events.push(toStatEvent(project, task));
			}
		}
	}

	await Promise.all(liveJobs);
	return { events, generatedAt: new Date().toISOString() };
}

export const productivityStatsHandlers = {
	getProductivityStats,
};
