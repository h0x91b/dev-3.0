import type { TaskStatus } from "../../shared/types";
import { ALL_STATUSES } from "../../shared/types";
import type { ConversationMatch } from "../../shared/conversation-search-core";
import * as data from "../data";
import { projectSlug } from "../git";
import { searchConversations, type EngineTask } from "../conversation-search";
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

	const engineTasks: EngineTask[] = tasks.map((t) => ({
		id: t.id,
		title: t.title,
		description: t.description,
		overview: t.overview,
		userOverview: t.userOverview,
		notes: (t.notes ?? []).map((n) => n.content),
		historyTexts: (t.history ?? []).flatMap((h) => [h.title, h.overview]).filter((s): s is string => !!s),
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

export const conversationSearchHandlers = {
	searchConversations: searchConversationsHandler,
};
