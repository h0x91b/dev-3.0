import type { ColumnAgentConfig, CustomColumn, Label, NoteSource, Project, Task, TaskNote, TaskStatus } from "../../shared/types";
import { LABEL_COLORS } from "../../shared/types";
import * as data from "../data";
import { loadSettings } from "../settings";
import { getPushMessage, log } from "./shared";
import { activateTask, triggerColumnAgentIfNeeded } from "./task-lifecycle";

async function createLabel(params: { projectId: string; name: string; color?: string }): Promise<Label> {
	log.info("→ createLabel", { projectId: params.projectId, name: params.name });
	const { result: label } = await data.updateProjectWith(params.projectId, async (project) => {
		const labels = project.labels ?? [];
		const usedColors = new Set(labels.map((existingLabel) => existingLabel.color));
		const color = params.color ?? LABEL_COLORS.find((candidate) => !usedColors.has(candidate)) ?? LABEL_COLORS[labels.length % LABEL_COLORS.length];
		const newLabel: Label = {
			id: crypto.randomUUID(),
			name: params.name.trim(),
			color,
		};
		return {
			updates: { labels: [...labels, newLabel] },
			result: newLabel,
		};
	});
	log.info("← createLabel done", { labelId: label.id });
	return label;
}

async function updateLabel(params: { projectId: string; labelId: string; name?: string; color?: string }): Promise<Label> {
	log.info("→ updateLabel", { projectId: params.projectId, labelId: params.labelId });
	const { result: updated } = await data.updateProjectWith(params.projectId, async (project) => {
		const labels = project.labels ?? [];
		const idx = labels.findIndex((label) => label.id === params.labelId);
		if (idx === -1) throw new Error(`Label not found: ${params.labelId}`);
		const nextLabel: Label = {
			...labels[idx],
			...(params.name !== undefined ? { name: params.name.trim() } : {}),
			...(params.color !== undefined ? { color: params.color } : {}),
		};
		const newLabels = [...labels];
		newLabels[idx] = nextLabel;
		return {
			updates: { labels: newLabels },
			result: nextLabel,
		};
	});
	log.info("← updateLabel done", { labelId: updated.id });
	return updated;
}

async function deleteLabel(params: { projectId: string; labelId: string }): Promise<void> {
	log.info("→ deleteLabel", { projectId: params.projectId, labelId: params.labelId });
	const project = await data.getProject(params.projectId);
	await data.updateProjectWith(params.projectId, async (currentProject) => ({
		updates: {
			labels: (currentProject.labels ?? []).filter((label) => label.id !== params.labelId),
		},
		result: undefined,
	}));
	const tasks = await data.loadTasks(project);
	const affectedTasks = tasks.filter((task) => task.labelIds?.includes(params.labelId));
	for (const task of affectedTasks) {
		await data.updateTaskWith(project, task.id, async (currentTask) => ({
			updates: {
				labelIds: (currentTask.labelIds ?? []).filter((id) => id !== params.labelId),
			},
			result: undefined,
		}));
	}
	log.info("← deleteLabel done", { removed_from_tasks: affectedTasks.length });
}

async function createCustomColumn(params: { projectId: string; name: string; color?: string }): Promise<CustomColumn> {
	log.info("→ createCustomColumn", { projectId: params.projectId, name: params.name });
	const { project, result: column } = await data.updateProjectWith(params.projectId, async (currentProject) => {
		const columns = currentProject.customColumns ?? [];
		const usedColors = new Set(columns.map((existingColumn) => existingColumn.color));
		const color = params.color ?? LABEL_COLORS.find((candidate) => !usedColors.has(candidate)) ?? LABEL_COLORS[columns.length % LABEL_COLORS.length];
		const newColumn: CustomColumn = {
			id: crypto.randomUUID(),
			name: params.name.trim(),
			color,
			llmInstruction: "",
		};
		return {
			updates: { customColumns: [...columns, newColumn] },
			result: newColumn,
		};
	});
	getPushMessage()?.("projectUpdated", { project });
	log.info("← createCustomColumn done", { columnId: column.id });
	return column;
}

async function updateCustomColumn(params: { projectId: string; columnId: string; name?: string; color?: string; llmInstruction?: string; agentConfig?: ColumnAgentConfig | null }): Promise<CustomColumn> {
	log.info("→ updateCustomColumn", { projectId: params.projectId, columnId: params.columnId });
	const { project, result: updated } = await data.updateProjectWith(params.projectId, async (currentProject) => {
		const columns = currentProject.customColumns ?? [];
		const idx = columns.findIndex((column) => column.id === params.columnId);
		if (idx === -1) throw new Error(`Custom column not found: ${params.columnId}`);
		const nextColumn: CustomColumn = {
			...columns[idx],
			...(params.name !== undefined ? { name: params.name.trim() } : {}),
			...(params.color !== undefined ? { color: params.color } : {}),
			...(params.llmInstruction !== undefined ? { llmInstruction: params.llmInstruction } : {}),
			...(params.agentConfig !== undefined ? { agentConfig: params.agentConfig ?? undefined } : {}),
		};
		const newColumns = [...columns];
		newColumns[idx] = nextColumn;
		return {
			updates: { customColumns: newColumns },
			result: nextColumn,
		};
	});
	getPushMessage()?.("projectUpdated", { project });
	log.info("← updateCustomColumn done", { columnId: updated.id });
	return updated;
}

async function renameBuiltinColumn(params: { projectId: string; status: TaskStatus; name: string | null }): Promise<Project> {
	log.info("→ renameBuiltinColumn", { projectId: params.projectId, status: params.status, name: params.name });
	const { project: updated } = await data.updateProjectWith(params.projectId, async (currentProject) => {
		const labels = { ...(currentProject.customStatusLabels ?? {}) };
		if (params.name === null || params.name.trim() === "") {
			delete labels[params.status];
		} else {
			labels[params.status] = params.name.trim();
		}
		return {
			updates: {
				customStatusLabels: Object.keys(labels).length > 0 ? labels : undefined,
			},
			result: undefined,
		};
	});
	getPushMessage()?.("projectUpdated", { project: updated });
	log.info("← renameBuiltinColumn done", { status: params.status });
	return updated;
}

async function deleteCustomColumn(params: { projectId: string; columnId: string }): Promise<void> {
	log.info("→ deleteCustomColumn", { projectId: params.projectId, columnId: params.columnId });
	const project = await data.getProject(params.projectId);
	const { project: updatedProject } = await data.updateProjectWith(params.projectId, async (currentProject) => ({
		updates: {
			customColumns: (currentProject.customColumns ?? []).filter((column) => column.id !== params.columnId),
		},
		result: undefined,
	}));
	const tasks = await data.loadTasks(project);
	const affectedTasks = tasks.filter((task) => task.customColumnId === params.columnId);
	for (const task of affectedTasks) {
		const updated = await data.updateTask(project, task.id, { customColumnId: null });
		getPushMessage()?.("taskUpdated", { projectId: params.projectId, task: updated });
	}
	getPushMessage()?.("projectUpdated", { project: updatedProject });
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
	const { project: updated, result: reorderedCount } = await data.updateProjectWith(params.projectId, async (project) => {
		const existing = project.customColumns ?? [];
		const reordered = params.columnOrder
			.map((id) => existing.find((column) => column.id === id))
			.filter((column): column is CustomColumn => column !== undefined);
		for (const column of existing) {
			if (!reordered.find((candidate) => candidate.id === column.id)) reordered.push(column);
		}
		return {
			updates: {
				customColumns: reordered,
				columnOrder: params.columnOrder,
			},
			result: reordered.length,
		};
	});
	getPushMessage()?.("projectUpdated", { project: updated });
	log.info("← reorderColumns done", { count: reorderedCount });
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
	const { task: updated, result: note } = await data.updateTaskWith(project, params.taskId, async (task) => {
		const now = new Date().toISOString();
		const note: TaskNote = {
			id: crypto.randomUUID(),
			content: params.content,
			source: params.source ?? "user",
			createdAt: now,
			updatedAt: now,
		};
		return {
			updates: { notes: [...(task.notes ?? []), note] },
			result: note,
		};
	});
	log.info("← addTaskNote done", { taskId: params.taskId, noteId: note.id });
	return updated;
}

async function updateTaskNote(params: { taskId: string; projectId: string; noteId: string; content: string }): Promise<Task> {
	log.info("→ updateTaskNote", { taskId: params.taskId, noteId: params.noteId });
	const project = await data.getProject(params.projectId);
	const { task: updated } = await data.updateTaskWith(project, params.taskId, async (task) => ({
		updates: {
			notes: (task.notes ?? []).map((note) =>
				note.id === params.noteId
					? { ...note, content: params.content, updatedAt: new Date().toISOString() }
					: note,
			),
		},
		result: undefined,
	}));
	log.info("← updateTaskNote done", { taskId: params.taskId, noteId: params.noteId });
	return updated;
}

async function deleteTaskNote(params: { taskId: string; projectId: string; noteId: string }): Promise<Task> {
	log.info("→ deleteTaskNote", { taskId: params.taskId, noteId: params.noteId });
	const project = await data.getProject(params.projectId);
	const { task: updated } = await data.updateTaskWith(project, params.taskId, async (task) => ({
		updates: {
			notes: (task.notes ?? []).filter((note) => note.id !== params.noteId),
		},
		result: undefined,
	}));
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
