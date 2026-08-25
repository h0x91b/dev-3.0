import type { TaskStatus } from "../../shared/types";
import { ALL_STATUSES } from "../../shared/types";
import type { ConversationMatch } from "../../shared/conversation-search-core";
import * as data from "../data";
import { projectSlug } from "../git";
import { searchConversations, type EngineTask } from "../conversation-search";
import { describeImportableSession, listImportableSessions, type ImportableSession } from "../session-import";
import { readAllTaskBlobs } from "../task-blobs";
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
 * Sessions that ran under this project's directory and could be imported.
 *
 * Scoped to the project that owns the session's cwd and nothing else — a
 * cross-project import would fork a branch in the wrong repo. Session ids
 * already spoken for by a task are hidden, so a session cannot be imported
 * twice.
 */
async function listImportableSessionsHandler(params: {
	projectId: string;
}): Promise<ImportableSession[]> {
	log.info("→ listImportableSessions", { projectId: params.projectId });
	const project = await data.getProject(params.projectId);
	if (project.kind === "virtual" || !project.path) {
		log.info("← listImportableSessions skipped (no repo path)", { projectId: params.projectId });
		return [];
	}
	const tasks = await data.loadTasks(project);
	const claimed = tasks.flatMap((t) => (t.sessionState?.panes ?? []).map((p) => p.sessionId).filter((id): id is string => !!id));

	const sessions = listImportableSessions(project.path, { excludeSessionIds: claimed });
	log.info("← listImportableSessions done", { count: sessions.length });
	return sessions;
}

/**
 * The title and description an imported session would produce.
 *
 * Rendered up front so the user reads what dev3 derived and can edit it before
 * the task exists — the transcript formats are reverse-engineered, so the
 * retelling is offered, never applied behind their back.
 */
async function describeImportableSessionHandler(params: {
	projectId: string;
	sessionId: string;
}): Promise<{ title: string | null; description: string; gitBranch: string | null; cwd: string } | null> {
	log.info("→ describeImportableSession", { projectId: params.projectId, sessionId: params.sessionId.slice(0, 8) });
	const project = await data.getProject(params.projectId);
	if (project.kind === "virtual" || !project.path) return null;

	const session = listImportableSessions(project.path).find((s) => s.sessionId === params.sessionId);
	if (!session) {
		log.warn("← describeImportableSession: no such session under this project", { sessionId: params.sessionId.slice(0, 8) });
		return null;
	}
	const draft = describeImportableSession(session);
	if (!draft) return null;

	return { ...draft, gitBranch: session.gitBranch, cwd: session.cwd };
}

export const conversationSearchHandlers = {
	searchConversations: searchConversationsHandler,
	listImportableSessions: listImportableSessionsHandler,
	describeImportableSession: describeImportableSessionHandler,
};
