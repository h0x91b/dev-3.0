import { useEffect, useState } from "react";
import type { Task } from "../../shared/types";
import { parentTaskIdOf } from "../../shared/types";
import { api } from "../rpc";
import { EMPTY_LINEAGE, buildTaskLineage, type TaskLineage } from "../utils/taskLineage";

/**
 * One lineage index for the whole renderer: the board, the sidebar and the task
 * detail read the same snapshot, fetched once and refetched only when a push says
 * lineage changed — a new child, a moved or removed lineage task. Most task
 * updates (status, overview) carry no lineage change and cost nothing.
 */
let current: TaskLineage = EMPTY_LINEAGE;
const subscribers = new Set<(lineage: TaskLineage) => void>();
let refetchTimer: ReturnType<typeof setTimeout> | null = null;
let listening = false;

const REFETCH_DEBOUNCE_MS = 400;

function refetch(): void {
	Promise.resolve()
		.then(() => api.request.getTaskLineage())
		.then((index) => {
			current = buildTaskLineage(index);
			for (const notify of subscribers) notify(current);
		})
		.catch((err) => console.error("getTaskLineage failed", err));
}

function scheduleRefetch(): void {
	if (refetchTimer) clearTimeout(refetchTimer);
	refetchTimer = setTimeout(() => {
		refetchTimer = null;
		refetch();
	}, REFETCH_DEBOUNCE_MS);
}

/** True when this update can change what the index says. */
export function lineageChangedBy(task: Task, lineage: TaskLineage): boolean {
	const known = lineage.nodeById.get(task.id);
	if (known) return known.seq !== task.seq || known.projectId !== task.projectId || known.status !== task.status;
	return parentTaskIdOf(task) !== null;
}

function onTaskUpdated(e: Event): void {
	const task = (e as CustomEvent<{ task?: Task }>).detail?.task;
	if (task && lineageChangedBy(task, current)) scheduleRefetch();
}

function onTaskRemoved(e: Event): void {
	const taskId = (e as CustomEvent<{ taskId?: string }>).detail?.taskId;
	if (taskId && current.nodeById.has(taskId)) scheduleRefetch();
}

export function useTaskLineage(): TaskLineage {
	const [lineage, setLineage] = useState<TaskLineage>(current);
	useEffect(() => {
		subscribers.add(setLineage);
		if (!listening) {
			listening = true;
			window.addEventListener("rpc:taskUpdated", onTaskUpdated);
			window.addEventListener("rpc:taskRemoved", onTaskRemoved);
			refetch();
		} else {
			setLineage(current);
		}
		return () => {
			subscribers.delete(setLineage);
		};
	}, []);
	return lineage;
}

export function _resetTaskLineageStoreForTest(): void {
	current = EMPTY_LINEAGE;
	subscribers.clear();
	if (refetchTimer) clearTimeout(refetchTimer);
	refetchTimer = null;
	if (listening) {
		window.removeEventListener("rpc:taskUpdated", onTaskUpdated);
		window.removeEventListener("rpc:taskRemoved", onTaskRemoved);
	}
	listening = false;
}
