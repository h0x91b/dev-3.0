import type { Project, Task, TaskStatus, NoteSource } from "../../shared/types";
import { replyToReviewComment, resolveReviewComment, resolveReviewCommentId, reopenReviewComment, type ReviewReplyAuthor } from "../../shared/review";
import { formatStatus, getTaskTitle, STATUS_LABELS } from "../../shared/types";
import { nextKeepAliveState } from "../../shared/keep-alive";
import { DEFAULT_EVENT_LIMIT, DEFAULT_EVENT_WINDOW_MS, MAX_EVENT_LIMIT, formatMovementText, normalizeEventInstant, resolveEventIdPrefix, selectEvents, type BoardEvent, type BoardEventKind } from "../../shared/board-events";
import * as data from "../data";
import { boardCopyEnabled, exportBoardCopy } from "../board-copy";
import * as taskNotes from "../board-operations/task-notes";
import * as labelOps from "../board-operations/labels";
import { updateTaskMetadata } from "../board-operations/task-metadata";
import { boardPorts } from "../board-operations/runtime";
import { AGENT_ACTOR } from "../board-operations/types";
import { getPushMessage } from "../rpc-handlers";
import { addVent } from "../vents";
import { conversationImport, log, type Handler } from "./shared";
import { findByIdPrefix, findTaskByRef, resolveReviewTask, resolveTaskAcrossProjects, resolveTaskFromParams, scopedTaskNotFoundError, taskNotFoundError } from "./task-resolution";

export const boardMetadataHandlers: Record<string, Handler> = {

	"overview.set": async (params) => {
		const overview = params.overview as string | undefined;
		if (typeof overview !== "string" || !overview.trim()) {
			throw new Error("overview text is required");
		}
		const { project, task } = await resolveTaskFromParams(params);
		return (await updateTaskMetadata(boardPorts, project, task.id, { overview }, AGENT_ACTOR)).task;
	},

	"overview.show": async (params) => {
		const { task } = await resolveTaskFromParams(params);
		return {
			overview: task.overview ?? null,
			userOverview: task.userOverview ?? null,
			description: task.description,
		};
	},

	"overview.clear": async (params) => {
		const { project, task } = await resolveTaskFromParams(params);
		return (await updateTaskMetadata(boardPorts, project, task.id, { overview: null }, AGENT_ACTOR)).task;
	},

	"keepAlive.set": async (params) => {
		const enabled = params.enabled === true || params.enabled === "true";
		const { project, task } = await resolveTaskFromParams(params);
		return (await updateTaskMetadata(boardPorts, project, task.id, { keepAlive: nextKeepAliveState(enabled) }, AGENT_ACTOR)).task;
	},

	"keepAlive.status": async (params) => {
		const { task } = await resolveTaskFromParams(params);
		return { taskId: task.id, seq: task.seq, title: getTaskTitle(task), status: task.status, keepAlive: task.keepAlive ?? null };
	},

	"keepAlive.list": async (params) => {
		const projects = params.projectId
			? [await data.getProject(params.projectId as string)]
			: [...await data.loadProjects(), ...await data.loadVirtualProjects()];
		const rows: Array<{ taskId: string; seq: number; title: string; status: TaskStatus; projectId: string; projectName: string; keepAlive: Task["keepAlive"] }> = [];
		for (const project of projects) {
			for (const task of await data.loadTasks(project)) {
				if (!task.keepAlive?.enabled) continue;
				rows.push({ taskId: task.id, seq: task.seq, title: getTaskTitle(task), status: task.status, projectId: project.id, projectName: project.name, keepAlive: task.keepAlive });
			}
		}
		return rows;
	},

	"note.add": async (params) => {
		const taskId = params.taskId as string;
		const content = params.content as string;
		if (!taskId) throw new Error("taskId is required");
		if (!content) throw new Error("content is required");

		let project: Project;
		let task: Task;

		if (params.projectId) {
			project = await data.getProject(params.projectId as string);
			const tasks = await data.loadTasks(project);
			const found = findTaskByRef(tasks, taskId);
			if (!found) throw await scopedTaskNotFoundError(taskId, project);
			task = found;
		} else {
			const found = await resolveTaskAcrossProjects(taskId);
			if (!found) throw taskNotFoundError(taskId);
			project = found.project;
			task = found.task;
		}

		const { task: updated } = await taskNotes.addNote(
			boardPorts, project, task.id, content, AGENT_ACTOR, params.source as NoteSource | undefined,
		);
		return updated;
	},

	"note.list": async (params) => {
		const taskId = params.taskId as string;
		if (!taskId) throw new Error("taskId is required");

		let task: Task;

		if (params.projectId) {
			const project = await data.getProject(params.projectId as string);
			const tasks = await data.loadTasks(project);
			const found = findTaskByRef(tasks, taskId);
			if (!found) throw await scopedTaskNotFoundError(taskId, project);
			task = found;
		} else {
			const found = await resolveTaskAcrossProjects(taskId);
			if (!found) throw taskNotFoundError(taskId);
			task = found.task;
		}

		return task.notes ?? [];
	},

	/**
	 * `dev3 review` — the agent's side of the review loop. Reads and writes the
	 * same `Task.review` the viewers use; every write recomputes from the CURRENT
	 * task inside the per-task lock (the same lost-update rule as notes).
	 */
	"review.list": async (params) => {
		const taskId = params.taskId as string;
		if (!taskId) throw new Error("taskId is required");
		const { task } = await resolveReviewTask(taskId, params.projectId as string | undefined);
		return task.review ?? [];
	},

	"review.resolve": async (params) => {
		const taskId = params.taskId as string;
		const ref = params.commentId as string;
		if (!taskId) throw new Error("taskId is required");
		if (!ref) throw new Error("commentId is required");
		const by = (params.by as ReviewReplyAuthor) ?? "agent";
		const reply = typeof params.reply === "string" && params.reply.trim() ? params.reply.trim() : undefined;
		const { project, task } = await resolveReviewTask(taskId, params.projectId as string | undefined);
		const resolved = resolveReviewCommentId(task.review, ref);
		if ("error" in resolved) throw new Error(resolved.error);
		const { task: updated } = await data.updateTaskWith(project, task.id, async (current) => ({
			updates: { review: resolveReviewComment(current.review, resolved.id, by, reply) },
			result: undefined,
		}));
		getPushMessage()?.("taskUpdated", { projectId: project.id, task: updated });
		return { commentId: resolved.id, task: updated };
	},

	"review.reopen": async (params) => {
		const taskId = params.taskId as string;
		const ref = params.commentId as string;
		if (!taskId) throw new Error("taskId is required");
		if (!ref) throw new Error("commentId is required");
		const { project, task } = await resolveReviewTask(taskId, params.projectId as string | undefined);
		const resolved = resolveReviewCommentId(task.review, ref);
		if ("error" in resolved) throw new Error(resolved.error);
		const { task: updated } = await data.updateTaskWith(project, task.id, async (current) => ({
			updates: { review: reopenReviewComment(current.review, resolved.id) },
			result: undefined,
		}));
		getPushMessage()?.("taskUpdated", { projectId: project.id, task: updated });
		return { commentId: resolved.id, task: updated };
	},

	"review.reply": async (params) => {
		const taskId = params.taskId as string;
		const ref = params.commentId as string;
		const body = typeof params.body === "string" ? params.body.trim() : "";
		if (!taskId) throw new Error("taskId is required");
		if (!ref) throw new Error("commentId is required");
		if (!body) throw new Error("body is required");
		const author = (params.author as ReviewReplyAuthor) ?? "agent";
		const { project, task } = await resolveReviewTask(taskId, params.projectId as string | undefined);
		const resolved = resolveReviewCommentId(task.review, ref);
		if ("error" in resolved) throw new Error(resolved.error);
		const { task: updated } = await data.updateTaskWith(project, task.id, async (current) => ({
			updates: { review: replyToReviewComment(current.review, resolved.id, { body, author }) },
			result: undefined,
		}));
		getPushMessage()?.("taskUpdated", { projectId: project.id, task: updated });
		return { commentId: resolved.id, task: updated };
	},

	"note.delete": async (params) => {
		const taskId = params.taskId as string;
		const noteId = params.noteId as string;
		if (!taskId) throw new Error("taskId is required");
		if (!noteId) throw new Error("noteId is required");

		let project: Project;
		let task: Task;

		if (params.projectId) {
			project = await data.getProject(params.projectId as string);
			const tasks = await data.loadTasks(project);
			const found = findTaskByRef(tasks, taskId);
			if (!found) throw await scopedTaskNotFoundError(taskId, project);
			task = found;
		} else {
			const found = await resolveTaskAcrossProjects(taskId);
			if (!found) throw taskNotFoundError(taskId);
			project = found.project;
			task = found.task;
		}

		// Prefix resolution is this adapter's job; the operation takes a full id. A
		// note that vanished before the lock (concurrent delete) comes back as a no-op.
		const note = findByIdPrefix(task.notes ?? [], noteId, "note");
		if (!note) throw new Error(`Note not found: ${noteId}`);
		const { task: updated } = await taskNotes.deleteNote(boardPorts, project, task.id, note.id);
		return updated;
	},

	/**
	 * `dev3 events` — every note recorded anywhere on the board, in one feed.
	 *
	 * Completed and cancelled tasks are deliberately included: that is the whole
	 * point. A live task can still message a coordinator, a finished one cannot,
	 * and its notes are all that survived its worktree.
	 *
	 * Selection happens here rather than in the CLI because the "older than the
	 * window" count needs the full corpus, and shipping every note body over the
	 * socket to count them would be the expensive way to learn one number.
	 */
	"events.list": async (params) => {
		const rawLimit = Number(params.limit ?? DEFAULT_EVENT_LIMIT);
		const limit = Number.isFinite(rawLimit)
			? Math.min(MAX_EVENT_LIMIT, Math.max(1, Math.floor(rawLimit)))
			: DEFAULT_EVENT_LIMIT;

		const projects = params.projectId
			? [await data.getProject(params.projectId as string)]
			: [...await data.loadProjects(), ...await data.loadVirtualProjects()];

		const kind = (params.kind as BoardEventKind | undefined) ?? null;
		const wantNotes = kind === null || kind === "note";
		const wantMoves = kind === null || kind === "move";

		const events: BoardEvent[] = [];
		// Filled while scanning; resolved into a count once the cursor is known,
		// because "was it inside what you asked for" needs that cursor.
		const evictionProbes: Array<{ dropped: number; oldestRetained: string | null }> = [];
		for (const project of projects) {
			let tasks: Task[];
			try {
				tasks = await data.loadTasks(project);
			} catch (err) {
				log.warn("events.list: skipping unreadable project", { projectId: project.id, error: String(err) });
				continue;
			}
			const columnName = new Map((project.customColumns ?? []).map((col) => [col.id, col.name]));
			// The board's own vocabulary, renames included — a reader recognises
			// "Agent is Working", not the `in-progress` slug underneath it.
			const statusLabel = (status: TaskStatus) =>
				project.customStatusLabels?.[status] ?? STATUS_LABELS[status] ?? formatStatus(status);
			for (const task of tasks) {
				if (wantMoves) {
					if (task.movementsDropped) {
						const oldest = normalizeEventInstant(task.movements?.[0]?.at);
						evictionProbes.push({ dropped: task.movementsDropped, oldestRetained: oldest });
					}
					for (const move of task.movements ?? []) {
						const at = normalizeEventInstant(move.at);
						if (!at) continue;
						const movement = {
							kind: move.kind,
							...(move.from ? { from: move.from } : {}),
							to: move.to,
							fromColumn: move.fromColumnId ? columnName.get(move.fromColumnId) ?? null : null,
							toColumn: move.toColumnId ? columnName.get(move.toColumnId) ?? null : null,
						};
						events.push({
							kind: "move",
							at,
							id: move.id,
							projectId: project.id,
							projectName: project.name ?? "",
							taskId: task.id,
							seq: task.seq ?? null,
							taskTitle: getTaskTitle(task),
							taskStatus: task.status,
							movement,
							text: formatMovementText(movement, statusLabel),
						});
					}
				}
				if (!wantNotes) continue;
				for (const note of task.notes ?? []) {
					const at = normalizeEventInstant(note.createdAt) ?? normalizeEventInstant(task.createdAt);
					if (!at) continue;
					events.push({
						kind: "note",
						at,
						id: note.id,
						projectId: project.id,
						projectName: project.name ?? "",
						taskId: task.id,
						seq: task.seq ?? null,
						taskTitle: getTaskTitle(task),
						taskStatus: task.status,
						source: note.source,
						text: note.content,
					});
				}
			}
		}

		// An id prefix is resolved against the same scope that is about to be read,
		// so "not found" always means "not in what you asked for".
		const cursorId = params.cursorId as string | undefined;
		const cursor = cursorId
			? resolveEventIdPrefix(events, cursorId)
			: (params.cursor as string | null | undefined) ?? null;

		const now = Date.now();
		// A task's evicted moves are all older than its oldest surviving one, so
		// they only matter when even that survivor is newer than where the caller
		// is reading from — then the gap is inside the answer.
		const floor = cursor
			?? new Date(now - ((params.windowMs as number | undefined) ?? DEFAULT_EVENT_WINDOW_MS)).toISOString();
		const movementsEvicted = evictionProbes
			.filter((p) => p.oldestRetained !== null && p.oldestRetained > floor)
			.reduce((sum, p) => sum + p.dropped, 0);

		return {
			...selectEvents(events, {
				cursor,
				limit,
				now,
				windowMs: params.windowMs as number | undefined,
			}),
			from: cursor ? cursor.replace(/Z$/, "") : null,
			movementsEvicted,
		};
	},

	"vent.add": async (params) => {
		// Background, fire-and-forget: an agent reporting friction with the dev3
		// platform itself. Always available, no opt-in, no UI — just write the
		// anonymous markdown file to ~/.dev3.0/vents/ for the maintainer to read.
		const name = (params.name as string)?.trim();
		const content = (params.content as string)?.trim();
		if (!name) throw new Error("name is required");
		if (!content) throw new Error("content is required");

		const vent = addVent(name, content);
		return { fileName: vent.fileName };
	},

	"conversations.scanImport": async (params) => {
		const projectId = params.projectId as string;
		if (!projectId) throw new Error("projectId is required");
		return (await conversationImport()).scanImportableConversations({ projectId });
	},

	"conversations.import": async (params) => {
		const projectId = params.projectId as string;
		if (!projectId) throw new Error("projectId is required");
		const sessionIds = params.sessionIds;
		if (!Array.isArray(sessionIds) || sessionIds.some((id) => typeof id !== "string")) {
			throw new Error("sessionIds must be an array of session ids");
		}
		return (await conversationImport()).importConversations({ projectId, sessionIds: sessionIds as string[] });
	},

	"board.export": async (params) => {
		const projectId = params.projectId as string;
		if (!projectId) throw new Error("projectId is required");
		const project = await data.getProject(projectId);
		if (!boardCopyEnabled(project)) {
			throw new Error("The board copy is off for this project. Turn it on in Project Settings > Board > Board copy.");
		}
		return exportBoardCopy(project, { compareWithDisk: true });
	},

	"label.list": async (params) => {
		const projectId = params.projectId as string;
		if (!projectId) throw new Error("projectId is required");
		const project = await data.getProject(projectId);
		return project.labels ?? [];
	},

	"label.create": async (params) => {
		const projectId = params.projectId as string;
		const name = (params.name as string)?.trim();
		if (!projectId) throw new Error("projectId is required");
		if (!name) throw new Error("name is required");

		const { result: label } = await labelOps.createLabel(boardPorts, projectId, { name, color: params.color as string | undefined });
		return label;
	},

	"label.delete": async (params) => {
		const projectId = params.projectId as string;
		const labelId = params.labelId as string;
		if (!projectId) throw new Error("projectId is required");
		if (!labelId) throw new Error("labelId is required");

		const project = await data.getProject(projectId);
		const label = findByIdPrefix(project.labels ?? [], labelId, "label");
		if (!label) throw new Error(`Label not found: ${labelId}`);

		await labelOps.deleteLabel(boardPorts, projectId, label.id);
		return { deleted: label.id };
	},
};
