import type { TaskStatus } from "../../shared/types";
import { ALL_STATUSES } from "../../shared/types";
import type { ConversationMatch } from "../../shared/conversation-search-core";
import * as data from "../data";
import { projectSlug } from "../git";
import { searchConversations, type EngineTask } from "../conversation-search";
import { readAllTaskBlobs } from "../task-blobs";
import { readTaskConversation } from "../task-conversation";
import type { TaskConversationView } from "../../shared/task-conversation-model";
import { log } from "./shared";

async function searchConversationsHandler(params: {
	projectId: string;
	query: string;
	currentTaskId?: string | null;
	limit?: number;
	allStatuses?: boolean;
}): Promise<ConversationMatch[]> {
	log.info("→ searchConversations", { projectId: params.projectId, query: params.query });
	const project = await data.getProject(params.projectId);
	const tasks = await data.loadTasks(project);

	const currentTaskId = params.currentTaskId ?? null;
	const currentTask = currentTaskId ? tasks.find((t) => t.id === currentTaskId) : null;
	const currentGroupId = currentTask?.groupId ?? null;

	// History lives in each task's sidecar, so a search reads the blobs once for
	// the whole project rather than per task.
	const blobs = await readAllTaskBlobs(project);

	const engineTasks: EngineTask[] = tasks.map((t) => ({
		id: t.id,
		title: t.title,
		description: t.description,
		overview: t.overview,
		userOverview: t.userOverview,
		notes: (t.notes ?? []).map((n) => n.content),
		historyTexts: [...(t.history ?? []), ...(blobs.get(t.id)?.history ?? [])]
			.flatMap((h) => [h.title, h.overview])
			.filter((s): s is string => !!s),
		status: t.status,
		groupId: t.groupId,
		agentId: t.agentId,
	}));

	const statuses: TaskStatus[] | undefined = params.allStatuses ? [...ALL_STATUSES] : undefined;

	const results = searchConversations({
		query: params.query,
		tasks: engineTasks,
		projectSlug: projectSlug(project.path),
		currentTaskId,
		currentGroupId,
		statuses,
		limit: params.limit,
	});
	log.info("← searchConversations done", { count: results.length });
	return results;
}

/**
 * One task's own agent conversation, a page at a time. Read-only, and it answers
 * for a completed task too — from dev3's archived dump, which the view labels.
 */
async function readTaskConversationHandler(params: {
	projectId: string;
	taskId: string;
	sessionKey?: string | null;
	before?: number | null;
	limit?: number;
}): Promise<TaskConversationView> {
	const project = await data.getProject(params.projectId);
	const tasks = await data.loadTasks(project);
	const task = tasks.find((candidate) => candidate.id === params.taskId);
	if (!task) return { sessions: [], sessionKey: null, turns: [], totalTurns: 0, firstIndex: 0 };
	return readTaskConversation(project, task, {
		sessionKey: params.sessionKey,
		before: params.before,
		limit: params.limit,
	});
}

export const conversationSearchHandlers = {
	searchConversations: searchConversationsHandler,
	readTaskConversation: readTaskConversationHandler,
};
