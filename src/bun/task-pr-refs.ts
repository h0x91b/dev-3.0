// Resolve a `<seq:N>` / `<pr:N>` reference (see src/shared/task-refs.ts) against
// the boards. A bare reference belongs to the project of the text that carries
// it — the task whose terminal, note or message it appears in — and a qualified
// one names its project by id prefix or name.

import { loadProjects, loadTasks, loadVirtualProjects } from "./data";
import { readTaskPullRequest } from "./github-pr-status";
import { parseRefUri, projectMatchesQualifier, type TaskPrRef, type TaskPrRefResolution } from "../shared/task-refs";
import { getTaskTitle, type Project, type Task } from "../shared/types";
import { createLogger } from "./logger";

const log = createLogger("task-pr-refs");

export type { TaskPrRefResolution };

async function allProjects(): Promise<Project[]> {
	const [gitProjects, virtualProjects] = await Promise.all([loadProjects(), loadVirtualProjects()]);
	return [...gitProjects, ...virtualProjects];
}

function pickProject(projects: Project[], ref: TaskPrRef, contextProjectId: string | undefined): Project | null {
	if (!ref.project) return projects.find((p) => p.id === contextProjectId) ?? null;
	const matches = projects.filter((p) => projectMatchesQualifier(p, ref.project!));
	return matches.length === 1 ? matches[0] : null;
}

function taskOwnsPr(task: Task, number: number): boolean {
	return task.prNumber === number || (task.pullRequests ?? []).some((pr) => pr.number === number);
}

function knownPrUrl(task: Task, number: number): string | null {
	if (task.prNumber === number && task.prUrl) return task.prUrl;
	return task.pullRequests?.find((pr) => pr.number === number)?.url ?? null;
}

/** Any PR URL the board already holds tells us the repo; swap in the number. */
function urlFromSiblingPr(tasks: Task[], number: number): string | null {
	for (const task of tasks) {
		const url = task.prUrl ?? task.pullRequests?.[0]?.url;
		const match = url ? /^(https:\/\/[^/]+\/[^/]+\/[^/]+\/pull\/)\d+$/.exec(url) : null;
		if (match) return `${match[1]}${number}`;
	}
	return null;
}

export async function resolveTaskPrRef(uri: string, contextProjectId?: string): Promise<TaskPrRefResolution | null> {
	const ref = parseRefUri(uri);
	if (!ref) return null;
	const project = pickProject(await allProjects(), ref, contextProjectId);
	if (!project) return null;
	const tasks = await loadTasks(project);

	if (ref.kind === "task") {
		// A variant group shares one seq; any member opens the same card group.
		const task = tasks
			.filter((t) => t.seq === ref.number)
			.sort((a, b) => (a.variantIndex ?? 0) - (b.variantIndex ?? 0))[0];
		if (!task) return null;
		return {
			kind: "task",
			taskId: task.id,
			projectId: project.id,
			projectName: project.name,
			seq: ref.number,
			title: getTaskTitle(task),
			status: task.status,
		};
	}

	const owner = tasks.find((t) => taskOwnsPr(t, ref.number));
	let url = (owner && knownPrUrl(owner, ref.number)) ?? urlFromSiblingPr(tasks, ref.number);
	if (!url && project.kind !== "virtual" && project.path) {
		try {
			url = (await readTaskPullRequest(project, project.path, "", ref.number))?.pr?.url ?? null;
		} catch (error) {
			log.warn("PR reference lookup failed", { error: String(error) });
		}
	}
	return {
		kind: "pr",
		number: ref.number,
		projectId: project.id,
		projectName: project.name,
		url,
		...(owner ? { taskId: owner.id } : {}),
	};
}
