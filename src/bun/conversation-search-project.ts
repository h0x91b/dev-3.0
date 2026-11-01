import { existsSync, readFileSync, readdirSync } from "node:fs";
import type { Task, TaskHistoryEntry, TaskStatus } from "../shared/types";
import { ALL_STATUSES } from "../shared/types";
import { projectSlug, type ConversationMatch } from "../shared/conversation-search-core";
import { searchConversations, type EngineTask } from "./conversation-search";

export function loadProjectTasks(dev3Home: string, slug: string): Task[] {
	const tasksFile = `${dev3Home}/data/${slug}/tasks.json`;
	if (!existsSync(tasksFile)) return [];
	try {
		return JSON.parse(readFileSync(tasksFile, "utf-8")) as Task[];
	} catch {
		return [];
	}
}

/**
 * Title/overview history moved out of tasks.json into per-task sidecars, and
 * this command reads the store directly rather than through the app. Reading the
 * blob directory once keeps the search's history signal intact; a missing or
 * unparseable sidecar just contributes nothing.
 */
export function loadArchivedHistory(dev3Home: string, slug: string): Map<string, TaskHistoryEntry[]> {
	const byTask = new Map<string, TaskHistoryEntry[]>();
	const dir = `${dev3Home}/data/${slug}/task-blobs`;
	if (!existsSync(dir)) return byTask;
	for (const entry of readdirSync(dir)) {
		if (!entry.endsWith(".json")) continue;
		try {
			const blob = JSON.parse(readFileSync(`${dir}/${entry}`, "utf-8")) as { taskId?: string; history?: TaskHistoryEntry[] };
			if (blob.taskId && blob.history?.length) byTask.set(blob.taskId, blob.history);
		} catch {
			// A half-written sidecar is not worth failing a search over.
		}
	}
	return byTask;
}

/**
 * `dev3 conversations search` over one project's board, read straight from
 * disk: the CLI runs it with no app, and the MCP listener runs it in a worker.
 * Synchronous file I/O over every transcript — never call it on the app's main thread.
 */
export function searchProjectConversations(opts: {
	query: string;
	projectPath: string;
	currentTaskId: string | null;
	allStatuses: boolean;
	limit: number;
	home: string;
	dev3Home: string;
}): ConversationMatch[] {
	const { dev3Home } = opts;
	const slug = projectSlug(opts.projectPath);
	const tasks = loadProjectTasks(dev3Home, slug);
	const currentTask = opts.currentTaskId ? tasks.find((t) => t.id === opts.currentTaskId || t.id.startsWith(opts.currentTaskId!)) : null;
	const statuses: TaskStatus[] | undefined = opts.allStatuses ? [...ALL_STATUSES] : undefined;
	const archivedHistory = loadArchivedHistory(dev3Home, slug);

	const engineTasks: EngineTask[] = tasks.map((t) => ({
		id: t.id,
		title: t.title,
		description: t.description,
		overview: t.overview,
		userOverview: t.userOverview,
		notes: (t.notes ?? []).map((n) => n.content),
		historyTexts: [...(t.history ?? []), ...(archivedHistory.get(t.id) ?? [])]
			.flatMap((h) => [h.title, h.overview])
			.filter((s): s is string => !!s),
		status: t.status,
		groupId: t.groupId,
		agentId: t.agentId,
	}));

	return searchConversations({
		query: opts.query,
		tasks: engineTasks,
		projectSlug: slug,
		currentTaskId: currentTask?.id ?? opts.currentTaskId,
		currentGroupId: currentTask?.groupId ?? null,
		statuses,
		limit: opts.limit,
		home: opts.home,
		dev3Home,
	});
}
