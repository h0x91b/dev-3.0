import {
	getTaskTitle,
	makeTasksQuickSwitchCustomFilter,
	TASKS_QUICK_SWITCH_FILTER_STATUSES,
	type Project,
	type Task,
	type TasksQuickSwitchFilter,
	type TaskStatus,
} from "../shared/types";
import type { Route } from "./state";

export interface TasksQuickSwitchItem {
	projectId: string;
	projectName: string;
	taskId: string;
	taskTitle: string;
	status: TaskStatus;
	customColumnName?: string;
	customColumnColor?: string;
}

export function getActiveQuickSwitchRouteTaskId(route: Route): string | null {
	if (route.screen === "task") {
		return route.taskId;
	}
	if (route.screen === "project" && route.activeTaskId) {
		return route.activeTaskId;
	}
	return null;
}

export function buildQuickSwitchOpenTaskRoute(
	projectId: string,
	taskId: string,
	openMode: "split" | "fullscreen" | null,
): Route {
	if (openMode === "fullscreen") {
		return { screen: "task", projectId, taskId };
	}
	return { screen: "project", projectId, activeTaskId: taskId };
}

export function getQuickSwitchDirection(
	event: Pick<KeyboardEvent, "shiftKey">,
	shortcut: Pick<{ modifiers: string[] }, "modifiers">,
): 1 | -1 {
	return event.shiftKey && !shortcut.modifiers.includes("shift") ? -1 : 1;
}

function getTaskRecencyValue(task: Task): number {
	return new Date(task.movedAt ?? task.updatedAt ?? task.createdAt).getTime();
}

export function buildTasksQuickSwitchItems(params: {
	projects: Project[];
	recentTaskIds: string[];
	allowedFilters: TasksQuickSwitchFilter[];
	tasksByProject: Map<string, Task[]>;
}): TasksQuickSwitchItem[] {
	const { projects, recentTaskIds, allowedFilters, tasksByProject } = params;
	const recentRank = new Map(recentTaskIds.map((taskId, index) => [taskId, index]));
	const allowedFilterSet = new Set(allowedFilters);

	return projects
		.filter((project) => !project.deleted)
		.flatMap((project) => {
			const customColumnsById = new Map(
				(project.customColumns ?? []).map((column) => [column.id, column]),
			);
			return (tasksByProject.get(project.id) ?? [])
				.filter((task) => {
					const filter = task.customColumnId
						? makeTasksQuickSwitchCustomFilter(task.customColumnId)
						: task.status;
					return allowedFilterSet.has(filter);
				})
				.map((task) => {
					const customColumn = task.customColumnId
						? customColumnsById.get(task.customColumnId)
						: null;
					return {
						projectId: project.id,
						projectName: project.name,
						taskId: task.id,
						taskTitle: getTaskTitle(task),
						status: task.status,
						customColumnName: customColumn?.name,
						customColumnColor: customColumn?.color,
						recencyValue: getTaskRecencyValue(task),
						recentRank: recentRank.get(task.id) ?? Number.POSITIVE_INFINITY,
					};
				});
		})
		.sort((left, right) => {
			if (left.recentRank !== right.recentRank) {
				return left.recentRank - right.recentRank;
			}
			if (left.recencyValue !== right.recencyValue) {
				return right.recencyValue - left.recencyValue;
			}
			if (left.projectName !== right.projectName) {
				return left.projectName.localeCompare(right.projectName);
			}
			return left.taskTitle.localeCompare(right.taskTitle);
		})
		.map(
			({
				projectId,
				projectName,
				taskId,
				taskTitle,
				status,
				customColumnName,
				customColumnColor,
			}) => ({
				projectId,
				projectName,
				taskId,
				taskTitle,
				status,
				customColumnName,
				customColumnColor,
			}),
		);
}

export function getInitialTasksQuickSwitchIndex(
	items: TasksQuickSwitchItem[],
	currentTaskId: string | null,
	direction: 1 | -1,
): number {
	if (items.length === 0) return 0;
	const currentIndex = currentTaskId
		? items.findIndex((item) => item.taskId === currentTaskId)
		: -1;
	if (currentIndex === -1) {
		return direction === -1 ? items.length - 1 : 0;
	}
	if (items.length === 1) {
		return currentIndex;
	}
	return moveTasksQuickSwitchSelection(currentIndex, items.length, direction);
}

export function moveTasksQuickSwitchSelection(
	currentIndex: number,
	totalItems: number,
	direction: 1 | -1,
): number {
	if (totalItems <= 0) return 0;
	return (currentIndex + direction + totalItems) % totalItems;
}

export function syncTasksQuickSwitchProjectTasks(
	tasksByProject: Map<string, Task[]>,
	task: Task,
): Map<string, Task[]> {
	const next = new Map(tasksByProject);
	const projectTasks = [...(next.get(task.projectId) ?? [])];
	const idx = projectTasks.findIndex((existing) => existing.id === task.id);

	if (TASKS_QUICK_SWITCH_FILTER_STATUSES.includes(task.status)) {
		if (idx >= 0) {
			projectTasks[idx] = task;
		} else {
			projectTasks.push(task);
		}
	} else if (idx >= 0) {
		projectTasks.splice(idx, 1);
	}

	next.set(task.projectId, projectTasks);
	return next;
}
