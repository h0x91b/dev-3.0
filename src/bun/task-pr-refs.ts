// Resolve a `<seq:N>` / `<pr:N>` reference (see src/shared/task-refs.ts) against
// the boards. A bare reference belongs to the project of the text that carries
// it — the task whose terminal, note or message it appears in — and a qualified
// one names its project by id prefix or name.

import { loadProjects, loadTasks, loadVirtualProjects } from "./data";
import { readTaskPullRequest } from "./github-pr-status";
import {
	parseRefUri, projectMatchesQualifier,
	PREVIEW_ARTIFACT_LIMIT, PREVIEW_IMAGE_LIMIT, PREVIEW_NOTE_CHARS, PREVIEW_NOTE_LIMIT,
	type TaskPrRef, type TaskPrRefPreview, type TaskPrRefResolution,
} from "../shared/task-refs";
import { getTaskOverview, getTaskTitle, isSharedClip, type Project, type Task, type TaskPRBadgeInfo } from "../shared/types";
import { prSummaryStatus } from "./rpc-handlers/pr-status";
import { createLogger } from "./logger";

const log = createLogger("task-pr-refs");

export type { TaskPrRefPreview, TaskPrRefResolution };

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

type Resolved =
	| { target: Extract<TaskPrRefResolution, { kind: "task" }>; project: Project; task: Task }
	| { target: Extract<TaskPrRefResolution, { kind: "pr" }>; project: Project; owner: Task | undefined };

async function resolve(uri: string, contextProjectId: string | undefined): Promise<Resolved | null> {
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
			project,
			task,
			target: {
				kind: "task",
				taskId: task.id,
				projectId: project.id,
				projectName: project.name,
				seq: ref.number,
				title: getTaskTitle(task),
				status: task.status,
			},
		};
	}

	const owner = tasks.find((t) => taskOwnsPr(t, ref.number));
	let url = (owner && knownPrUrl(owner, ref.number)) ?? urlFromSiblingPr(tasks, ref.number);
	if (!url && project.kind !== "virtual" && project.path) {
		url = (await readGitHubPr(project, ref.number))?.url ?? null;
	}
	return {
		project,
		owner,
		target: {
			kind: "pr",
			number: ref.number,
			projectId: project.id,
			projectName: project.name,
			url,
			...(owner ? { taskId: owner.id } : {}),
		},
	};
}

async function readGitHubPr(project: Project, number: number, force = false): Promise<TaskPRBadgeInfo | null> {
	try {
		const pr = (await readTaskPullRequest(project, project.path, "", number, force ? { force } : undefined))?.pr;
		return pr ? { number, url: pr.url, ...prSummaryStatus(pr) } : null;
	} catch (error) {
		log.warn("PR reference lookup failed", { error: String(error) });
		return null;
	}
}

export async function resolveTaskPrRef(uri: string, contextProjectId?: string): Promise<TaskPrRefResolution | null> {
	return (await resolve(uri, contextProjectId))?.target ?? null;
}

function clip(text: string): string {
	return text.length > PREVIEW_NOTE_CHARS ? `${text.slice(0, PREVIEW_NOTE_CHARS - 1).trimEnd()}…` : text;
}

/**
 * Everything a reference's hover preview shows. A PR's status comes from its
 * owner task's polled cache when that is the same PR; otherwise — or when the
 * user asks to refresh — from GitHub through the user's own `gh` account.
 */
export async function previewTaskPrRef(uri: string, contextProjectId?: string, fresh = false): Promise<TaskPrRefPreview | null> {
	const resolved = await resolve(uri, contextProjectId);
	if (!resolved) return null;

	if ("task" in resolved) {
		const { task, target, project } = resolved;
		const labels = (task.labelIds ?? []).flatMap((id) => project.labels?.find((label) => label.id === id) ?? []);
		const column = task.customColumnId ? project.customColumns?.find((c) => c.id === task.customColumnId) : undefined;
		const images = (task.sharedImages ?? []).filter((image) => !isSharedClip(image));
		const artifacts = task.sharedArtifacts ?? [];
		return {
			kind: "task",
			target,
			task,
			labels,
			customColumn: column ? { name: column.name, color: column.color } : null,
			...(project.customStatusLabels ? { customStatusLabels: project.customStatusLabels } : {}),
			overview: getTaskOverview(task),
			notes: (task.notes ?? []).slice(-PREVIEW_NOTE_LIMIT).map((n) => ({ id: n.id, content: clip(n.content), createdAt: n.createdAt })),
			images: images.slice(-PREVIEW_IMAGE_LIMIT).reverse(),
			imageCount: images.length,
			artifacts: artifacts.slice(-PREVIEW_ARTIFACT_LIMIT).reverse(),
			artifactCount: artifacts.length,
		};
	}

	const { project, owner, target } = resolved;
	const cache = owner?.prStatusCache?.number === target.number ? owner.prStatusCache : null;
	let badge: TaskPRBadgeInfo | null = null;
	if (cache && !fresh) {
		const { cachedAt: _cachedAt, headRefName: _head, ...rest } = cache;
		badge = rest;
	} else if (project.kind !== "virtual" && project.path) {
		badge = await readGitHubPr(project, target.number, fresh);
	}
	if (badge && !badge.url && target.url) badge = { ...badge, url: target.url };
	return { kind: "pr", target, badge };
}
