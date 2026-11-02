import type { Task } from "../types";
import { DEFAULT_PRIORITY, getTaskTitle, taskCompletesManually } from "../types";

/** The task as `task create|update|move --json` report it: what those commands can change. */
export interface TaskMutationRow {
	id: string;
	seq: number;
	projectId: string;
	title: string;
	status: string;
	customColumnId: string | null;
	priority: string;
	taskType: string | null;
	manualCompletion: boolean;
	draft: boolean;
}

/** `dev3 task create|update|move --json`. Additive changes keep the version. */
export interface TaskMutationJson {
	schemaVersion: 1;
	task: TaskMutationRow;
}

export function taskMutationRow(task: Task): TaskMutationRow {
	return {
		id: task.id,
		seq: task.seq,
		projectId: task.projectId,
		title: getTaskTitle(task),
		status: task.status,
		customColumnId: task.customColumnId ?? null,
		priority: task.priority ?? DEFAULT_PRIORITY,
		taskType: task.taskType ?? null,
		manualCompletion: taskCompletesManually(task),
		draft: task.draft === true,
	};
}

export function taskMutationJson(task: Task): TaskMutationJson {
	return { schemaVersion: 1, task: taskMutationRow(task) };
}
