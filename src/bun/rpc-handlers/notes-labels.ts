import type { ColumnAgentConfig, CustomColumn, Label, NoteSource, Project, Task, TaskNote, TaskStatus } from "../../shared/types";
import { LABEL_COLORS } from "../../shared/types";
import * as data from "../data";
import { loadSettings } from "../settings";
import { getPushMessage, log } from "./shared";
import { activateTask, triggerColumnAgentIfNeeded } from "./task-lifecycle";

async function createLabel(params: { projectId: string; name: string; color?: string }): Promise<Label> {
	log.info("→ createLabel", { projectId: params.projectId, name: params.name });
	const project = await data.getProject(params.projectId);
	const labels = project.labels ?? [];
	const usedColors = new Set(labels.map((label) => label.color));
	const color = params.color ?? LABEL_COLORS.find((candidate) => !usedColors.has(candidate)) ?? LABEL_COLORS[labels.length % LABEL_COLORS.length];
	const label: Label = {
		id: crypto.randomUUID(),
		name: params.name.trim(),
		color,
	};
	await data.updateProject(params.projectId, { labels: [...labels, label] });
	log.info("← createLabel done", { labelId: label.id });
	return label;
}

async function updateLabel(params: { projectId: string; labelId: string; name?: string; color?: string }): Promise<Label> {
	log.info("→ updateLabel", { projectId: params.projectId, labelId: params.labelId });
	const project = await data.getProject(params.projectId);
	const labels = project.labels ?? [];
	const idx = labels.findIndex((label) => label.id === params.labelId);
	if (idx === -1) throw new Error(`Label not found: ${params.labelId}`);
	const updated: Label = {
		...labels[idx],
		...(params.name !== undefined ? { name: params.name.trim() } : {}),
		...(params.color !== undefined ? { color: params.color } : {}),
	};
	const newLabels = [...labels];
	newLabels[idx] = updated;
	await data.updateProject(params.projectId, { labels: newLabels });
	log.info("← updateLabel done", { labelId: updated.id });
	return updated;
}

async function deleteLabel(params: { projectId: string; labelId: string }): Promise<void> {
	log.info("→ deleteLabel", { projectId: params.projectId, labelId: params.labelId });
	const project = await data.getProject(params.projectId);
	const newLabels = (project.labels ?? []).filter((label) => label.id !== params.labelId);
	await data.updateProject(params.projectId, { labels: newLabels });
	const tasks = await data.loadTasks(project);
	const affectedTasks = tasks.filter((task) => task.labelIds?.includes(params.labelId));
	for (const task of affectedTasks) {
		await data.updateTask(project, task.id, {
			labelIds: (task.labelIds ?? []).filter((id) => id !== params.labelId),
		});
	}
	log.info("← deleteLabel done", { removed_from_tasks: affectedTasks.length });
}

async function createCustomColumn(params: { projectId: string; name: string; color?: string }): Promise<CustomColumn> {
	log.info("→ createCustomColumn", { projectId: params.projectId, name: params.name });
	const project = await data.getProject(params.projectId);
	const columns = project.customColumns ?? [];
	const usedColors = new Set(columns.map((column) => column.color));
	const color = params.color ?? LABEL_COLORS.find((candidate) => !usedColors.has(candidate)) ?? LABEL_COLORS[columns.length % LABEL_COLORS.length];
	const column: CustomColumn = {
		id: crypto.randomUUID(),
		name: params.name.trim(),
		color,
		llmInstruction: "",
	};
	await data.updateProject(params.projectId, { customColumns: [...columns, column] });
	getPushMessage()?.("projectUpdated", { project: await data.getProject(params.projectId) });
	log.info("← createCustomColumn done", { columnId: column.id });
	return column;
}

async function updateCustomColumn(params: { projectId: string; columnId: string; name?: string; color?: string; llmInstruction?: string; agentConfig?: ColumnAgentConfig | null }): Promise<CustomColumn> {
	log.info("→ updateCustomColumn", { projectId: params.projectId, columnId: params.columnId });
	const project = await data.getProject(params.projectId);
	const columns = project.customColumns ?? [];
	const idx = columns.findIndex((column) => column.id === params.columnId);
	if (idx === -1) throw new Error(`Custom column not found: ${params.columnId}`);
	const updated: CustomColumn = {
		...columns[idx],
		...(params.name !== undefined ? { name: params.name.trim() } : {}),
		...(params.color !== undefined ? { color: params.color } : {}),
		...(params.llmInstruction !== undefined ? { llmInstruction: params.llmInstruction } : {}),
		...(params.agentConfig !== undefined ? { agentConfig: params.agentConfig ?? undefined } : {}),
	};
	const newColumns = [...columns];
	newColumns[idx] = updated;
	await data.updateProject(params.projectId, { customColumns: newColumns });
	getPushMessage()?.("projectUpdated", { project: await data.getProject(params.projectId) });
	log.info("← updateCustomColumn done", { columnId: updated.id });
	return updated;
}

async function renameBuiltinColumn(params: { projectId: string; status: TaskStatus; name: string | null }): Promise<Project> {
	log.info("→ renameBuiltinColumn", { projectId: params.projectId, status: params.status, name: params.name });
	const project = await data.getProject(params.projectId);
	const labels = { ...(project.customStatusLabels ?? {}) };
	if (params.name === null || params.name.trim() === "") {
		delete labels[params.status];
	} else {
		labels[params.status] = params.name.trim();
	}
	const customStatusLabels = Object.keys(labels).length > 0 ? labels : undefined;
	await data.updateProject(params.projectId, { customStatusLabels });
	const updated = await data.getProject(params.projectId);
	getPushMessage()?.("projectUpdated", { project: updated });
	log.info("← renameBuiltinColumn done", { status: params.status });
	return updated;
}

async function deleteCustomColumn(params: { projectId: string; columnId: string }): Promise<void> {
	log.info("→ deleteCustomColumn", { projectId: params.projectId, columnId: params.columnId });
	const project = await data.getProject(params.projectId);
	const newColumns = (project.customColumns ?? []).filter((column) => column.id !== params.columnId);
	await data.updateProject(params.projectId, { customColumns: newColumns });
	const tasks = await data.loadTasks(project);
	const affectedTasks = tasks.filter((task) => task.customColumnId === params.columnId);
	for (const task of affectedTasks) {
		const updated = await data.updateTask(project, task.id, { customColumnId: null });
		getPushMessage()?.("taskUpdated", { projectId: params.projectId, task: updated });
	}
	getPushMessage()?.("projectUpdated", { project: await data.getProject(params.projectId) });
	log.info("← deleteCustomColumn done", { removed_from_tasks: affectedTasks.length });
}

async function moveTaskToCustomColumn(params: { taskId: string; projectId: string; customColumnId: string | null }): Promise<Task> {
	log.info("→ moveTaskToCustomColumn", params);
	const project = await data.getProject(params.projectId);
	let column: CustomColumn | undefined;
	if (params.customColumnId !== null) {
		column = (project.customColumns ?? []).find((candidate) => candidate.id === params.customColumnId);
		if (!column) throw new Error(`Custom column not found: ${params.customColumnId}`);
	}
	const task = await data.getTask(project, params.taskId);

	if (params.customColumnId !== null && (task.status === "completed" || task.status === "cancelled")) {
		log.info("Reopening task into custom column, creating worktree + PTY", { taskId: task.id });
		const settings = await loadSettings();
		const wt = await activateTask(project, task, { isReopen: true });
		const updated = await data.updateTask(project, task.id, {
			status: "in-progress",
			worktreePath: wt.worktreePath,
			branchName: wt.branchName,
			customColumnId: params.customColumnId,
		}, { dropPosition: settings.taskDropPosition });
		getPushMessage()?.("taskUpdated", { projectId: project.id, task: updated });
		if (column?.agentConfig && updated.worktreePath) {
			await triggerColumnAgentIfNeeded(updated.status, project, updated, { customColumn: column });
		}
		log.info("← moveTaskToCustomColumn done (reopened)", { taskId: params.taskId });
		return updated;
	}

	const updated = await data.updateTask(project, params.taskId, { customColumnId: params.customColumnId });
	getPushMessage()?.("taskUpdated", { projectId: project.id, task: updated });
	if (column?.agentConfig && updated.worktreePath) {
		await triggerColumnAgentIfNeeded(updated.status, project, updated, { customColumn: column });
	}
	log.info("← moveTaskToCustomColumn done", { taskId: params.taskId, customColumnId: params.customColumnId });
	return updated;
}

async function reorderColumns(params: { projectId: string; columnOrder: string[] }): Promise<Project> {
	log.info("→ reorderColumns", { projectId: params.projectId, columnOrder: params.columnOrder });
	const project = await data.getProject(params.projectId);
	const existing = project.customColumns ?? [];
	const reordered = params.columnOrder
		.map((id) => existing.find((column) => column.id === id))
		.filter((column): column is CustomColumn => column !== undefined);
	for (const column of existing) {
		if (!reordered.find((candidate) => candidate.id === column.id)) reordered.push(column);
	}
	const updated = await data.updateProject(params.projectId, {
		customColumns: reordered,
		columnOrder: params.columnOrder,
	});
	getPushMessage()?.("projectUpdated", { project: updated });
	log.info("← reorderColumns done", { count: reordered.length });
	return updated;
}

async function setTaskLabels(params: { taskId: string; projectId: string; labelIds: string[] }): Promise<Task> {
	log.info("→ setTaskLabels", { taskId: params.taskId, labelIds: params.labelIds });
	const project = await data.getProject(params.projectId);
	const task = await data.updateTask(project, params.taskId, { labelIds: params.labelIds });
	log.info("← setTaskLabels done", { taskId: params.taskId });
	return task;
}

async function addTaskNote(params: { taskId: string; projectId: string; content: string; source?: NoteSource }): Promise<Task> {
	log.info("→ addTaskNote", { taskId: params.taskId });
	const project = await data.getProject(params.projectId);
	const task = await data.getTask(project, params.taskId);
	const now = new Date().toISOString();
	const note: TaskNote = {
		id: crypto.randomUUID(),
		content: params.content,
		source: params.source ?? "user",
		createdAt: now,
		updatedAt: now,
	};
	const notes = [...(task.notes ?? []), note];
	const updated = await data.updateTask(project, params.taskId, { notes });
	log.info("← addTaskNote done", { taskId: params.taskId, noteId: note.id });
	return updated;
}

async function updateTaskNote(params: { taskId: string; projectId: string; noteId: string; content: string }): Promise<Task> {
	log.info("→ updateTaskNote", { taskId: params.taskId, noteId: params.noteId });
	const project = await data.getProject(params.projectId);
	const task = await data.getTask(project, params.taskId);
	const notes = (task.notes ?? []).map((note) =>
		note.id === params.noteId
			? { ...note, content: params.content, updatedAt: new Date().toISOString() }
			: note,
	);
	const updated = await data.updateTask(project, params.taskId, { notes });
	log.info("← updateTaskNote done", { taskId: params.taskId, noteId: params.noteId });
	return updated;
}

async function deleteTaskNote(params: { taskId: string; projectId: string; noteId: string }): Promise<Task> {
	log.info("→ deleteTaskNote", { taskId: params.taskId, noteId: params.noteId });
	const project = await data.getProject(params.projectId);
	const task = await data.getTask(project, params.taskId);
	const notes = (task.notes ?? []).filter((note) => note.id !== params.noteId);
	const updated = await data.updateTask(project, params.taskId, { notes });
	log.info("← deleteTaskNote done", { taskId: params.taskId, noteId: params.noteId });
	return updated;
}

export const notesLabelsHandlers = {
	createLabel,
	updateLabel,
	deleteLabel,
	createCustomColumn,
	updateCustomColumn,
	renameBuiltinColumn,
	deleteCustomColumn,
	moveTaskToCustomColumn,
	reorderColumns,
	setTaskLabels,
	addTaskNote,
	updateTaskNote,
	deleteTaskNote,
};
