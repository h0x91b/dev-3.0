import type { Label, Project, Task } from "../../shared/types";
import * as data from "../data";
import * as git from "../git";
import * as repoConfig from "../repo-config";
import { parseTranscriptFile } from "../conversation-parse";
import { scanImportableConversations, type ImportableConversation } from "../conversation-import";
import {
	IMPORTED_LABEL_NAME,
	type ImportConversationsResult,
	type ImportableConversationView,
} from "../../shared/conversation-import-model";
import { firstUserRequest, renderImportedDescription } from "../../shared/conversation-render";
import { getPushMessage, log } from "./shared";

/**
 * Turning the Claude Code conversations that ran in a project's own directory
 * into ordinary dev3 tasks.
 *
 * "Ordinary" is the whole design: after the import a task carries a title, a
 * description, a label and (when the work is recent) a worktree, and nothing
 * about it behaves specially again. The only trace is `importedSessionId`, which
 * exists so a second import cannot offer the same conversation twice.
 */

function toView(conversation: ImportableConversation): ImportableConversationView {
	return {
		sessionId: conversation.sessionId,
		title: conversation.title,
		workingDir: conversation.workingDir,
		lastActivityMs: conversation.lastActivityMs,
		turns: conversation.turns,
		targetStatus: conversation.targetStatus,
	};
}

async function importableConversationsFor(project: Project): Promise<ImportableConversation[]> {
	// A virtual ("Operations") board has no repository, so no conversation can be
	// contained by it.
	if (project.kind === "virtual") return [];
	const tasks = await data.loadTasks(project);
	const importedSessionIds = tasks
		.map((task) => task.importedSessionId)
		.filter((id): id is string => typeof id === "string" && id.length > 0);
	return scanImportableConversations({ projectPath: project.path, importedSessionIds });
}

/**
 * The conversations this project could import right now. Declining is not
 * recorded anywhere, so a scan after a decline offers the same list again.
 */
async function scanImportableConversationsHandler(
	params: { projectId: string },
): Promise<{ conversations: ImportableConversationView[] }> {
	log.info("→ scanImportableConversations", { projectId: params.projectId.slice(0, 8) });
	const project = await data.getProject(params.projectId);
	const conversations = await importableConversationsFor(project);
	log.info("← scanImportableConversations", { count: conversations.length });
	return { conversations: conversations.map(toView) };
}

/** The `imported` label, created on first use and reused afterwards. */
async function ensureImportedLabel(projectId: string): Promise<Label> {
	let created = false;
	const { result, project: updated } = await data.updateProjectWith(projectId, async (project) => {
		const labels = project.labels ?? [];
		const existing = labels.find((label) => label.name.toLowerCase() === IMPORTED_LABEL_NAME);
		if (existing) return { updates: {}, result: existing };
		const label: Label = { id: crypto.randomUUID(), name: IMPORTED_LABEL_NAME, color: "#94a3b8" };
		created = true;
		return { updates: { labels: [...labels, label] }, result: label };
	});
	// Without this the cards carry a label id the renderer's project does not know
	// yet, so the chip is invisible until something else reloads the project.
	if (created && updated) getPushMessage()?.("projectUpdated", { project: updated });
	return result;
}

/** A sticky note for a task nobody has looked at yet: what it was, and when. */
function overviewFor(conversation: ImportableConversation, firstLine: string): string {
	const when = new Date(conversation.lastActivityMs).toISOString().slice(0, 10);
	const head = firstLine.replace(/\s+/g, " ").trim().slice(0, 220);
	return `Imported Claude Code conversation (${conversation.turns} turns, last active ${when}).${head ? ` ${head}` : ""}`;
}

/**
 * The branch a recent import continues from: the one the conversation actually
 * ran on when that ref still exists, and the project's base branch otherwise
 * (a detached HEAD, or a branch deleted since).
 */
async function baseBranchFor(project: Project, conversation: ImportableConversation): Promise<string> {
	const branch = conversation.gitBranch?.trim();
	if (branch && branch !== "HEAD" && await git.refExists(project.path, branch)) return branch;
	return project.defaultBaseBranch || "main";
}

async function importOne(
	project: Project,
	conversation: ImportableConversation,
	labelId: string,
	problems: { title: string; error: string }[],
): Promise<Task> {
	const parsed = parseTranscriptFile(conversation.transcriptPath, "claude");
	if (!parsed) throw new Error(`Could not parse ${conversation.transcriptPath}`);
	const description = renderImportedDescription(parsed);
	const recent = conversation.targetStatus === "user-questions";

	const task = await data.addTask(project, description, conversation.targetStatus, {
		title: conversation.title,
		labelIds: [labelId],
		overview: overviewFor(conversation, firstUserRequest(parsed) ?? ""),
		importedSessionId: conversation.sessionId,
		...(recent ? { baseBranch: await baseBranchFor(project, conversation) } : {}),
	});

	if (!recent) return task;

	// A worktree, no terminal and no agent: the work is there to be picked up, and
	// the description reaches the agent as its first prompt whenever the user opens
	// the task. Importing must never boot a fleet of agents nobody asked for.
	try {
		const resolved = await repoConfig.resolveProjectConfig(project);
		const worktree = await git.createWorktree(resolved, task);
		return await data.updateTask(project, task.id, {
			worktreePath: worktree.worktreePath,
			branchName: worktree.branchName,
		});
	} catch (err) {
		log.warn("Imported task created without a worktree", { taskId: task.id.slice(0, 8), error: String(err) });
		problems.push({ title: conversation.title, error: `imported without a worktree: ${String(err)}` });
		return task;
	}
}

/**
 * Import the selected conversations. Unknown or already-imported session ids are
 * simply not in the scan, so clicking twice adds nothing the second time.
 */
async function importConversationsHandler(
	params: { projectId: string; sessionIds: string[] },
): Promise<ImportConversationsResult> {
	log.info("→ importConversations", { projectId: params.projectId.slice(0, 8), requested: params.sessionIds.length });
	const project = await data.getProject(params.projectId);
	const wanted = new Set(params.sessionIds);
	const selected = (await importableConversationsFor(project)).filter((c) => wanted.has(c.sessionId));

	if (selected.length === 0) {
		log.info("← importConversations: nothing matched the selection");
		return { imported: 0, tasks: [], problems: [] };
	}

	const problems: { title: string; error: string }[] = [];
	const tasks: Task[] = [];
	const label = await ensureImportedLabel(project.id);
	const push = getPushMessage();

	// Oldest first, so the board's seq order matches the order the work happened in.
	for (const conversation of [...selected].reverse()) {
		try {
			const task = await importOne(project, conversation, label.id, problems);
			tasks.push(task);
			push?.("taskUpdated", { projectId: project.id, task });
		} catch (err) {
			log.error("Conversation import failed", { sessionId: conversation.sessionId.slice(0, 8), error: String(err) });
			problems.push({ title: conversation.title, error: String(err) });
		}
	}

	log.info("← importConversations", { imported: tasks.length, problems: problems.length });
	return { imported: tasks.length, tasks, problems };
}

/**
 * Spend the project's one unprompted offer. Written whatever the user answered,
 * including "there was nothing to offer" — the point is that dev3 asked, not
 * that it got a yes.
 */
async function markConversationImportOfferedHandler(
	params: { projectId: string },
): Promise<{ project: Project }> {
	const { project } = await data.updateProjectWith(params.projectId, (current) => ({
		updates: current.conversationImportOfferedAt ? {} : { conversationImportOfferedAt: new Date().toISOString() },
		result: undefined,
	}));
	getPushMessage()?.("projectUpdated", { project });
	return { project };
}

export const conversationImportHandlers = {
	scanImportableConversations: scanImportableConversationsHandler,
	importConversations: importConversationsHandler,
	markConversationImportOffered: markConversationImportOfferedHandler,
};
