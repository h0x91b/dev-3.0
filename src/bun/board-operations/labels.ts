import type { Label, Project, Task } from "../../shared/types";
import { LABEL_COLORS } from "../../shared/types";
import * as data from "../data";
import { pushTaskUpdated, type BoardPorts, type ProjectOpResult, type TaskOpResult } from "./types";

/**
 * Project labels and the labels on a task, one implementation for every door.
 * Every write recomputes from the state read inside the relevant file lock.
 */

export class UnknownLabelError extends Error {
	constructor(readonly labelIds: string[]) {
		super(`Label not found: ${labelIds.join(", ")}`);
		this.name = "UnknownLabelError";
	}
}

export type TaskLabelChange =
	| { mode: "replace"; labelIds: string[] }
	| { mode: "add"; labelIds: string[] }
	| { mode: "remove"; labelIds: string[] };

function sameIds(a: string[], b: string[]): boolean {
	return a.length === b.length && a.every((id, i) => id === b[i]);
}

/**
 * Takes full label ids; prefix resolution belongs to the adapter. An id the caller
 * INTRODUCES must name a project label, or the whole change is refused with
 * {@link UnknownLabelError}. An id already on the task is never re-validated, so a
 * task holding a dangling id (its label deleted elsewhere) can still be edited.
 */
export async function changeTaskLabels(
	ports: BoardPorts,
	project: Project,
	taskId: string,
	change: TaskLabelChange,
): Promise<TaskOpResult> {
	const requested = [...new Set(change.labelIds)];
	const known = new Set(((await data.getProject(project.id)).labels ?? []).map((label) => label.id));
	const { task, result: changed } = await data.updateTaskWith(project, taskId, (current) => {
		const existing = current.labelIds ?? [];
		const next = change.mode === "replace"
			? requested
			: change.mode === "add"
				? [...existing, ...requested.filter((id) => !existing.includes(id))]
				: existing.filter((id) => !requested.includes(id));
		const unknown = next.filter((id) => !known.has(id) && !existing.includes(id));
		if (unknown.length > 0) throw new UnknownLabelError(unknown);
		if (sameIds(existing, next)) return { updates: {}, result: false };
		return { updates: { labelIds: next }, result: true };
	});
	if (changed) pushTaskUpdated(ports, project, task);
	return { verdict: changed ? "applied" : "noop", task, rejected: [] };
}

/** Validation for callers that write `labelIds` as part of a wider patch. */
export async function assertKnownLabelIds(project: Project, task: Task, labelIds: string[]): Promise<void> {
	const known = new Set(((await data.getProject(project.id)).labels ?? []).map((label) => label.id));
	const unknown = labelIds.filter((id) => !known.has(id) && !(task.labelIds ?? []).includes(id));
	if (unknown.length > 0) throw new UnknownLabelError([...new Set(unknown)]);
}

function pushProject(ports: BoardPorts, project: Project): void {
	ports.push("projectUpdated", { project });
}

export async function createLabel(
	ports: BoardPorts,
	projectId: string,
	input: { name: string; color?: string },
): Promise<ProjectOpResult<Label>> {
	const name = input.name?.trim();
	if (!name) throw new Error("name is required");
	const { project, result: label } = await data.updateProjectWith(projectId, (current) => {
		const labels = current.labels ?? [];
		const usedColors = new Set(labels.map((existing) => existing.color));
		const color = input.color ?? LABEL_COLORS.find((candidate) => !usedColors.has(candidate)) ?? LABEL_COLORS[labels.length % LABEL_COLORS.length];
		const label: Label = { id: crypto.randomUUID(), name, color };
		return { updates: { labels: [...labels, label] }, result: label };
	});
	pushProject(ports, project);
	return { verdict: "applied", project, result: label };
}

export async function updateLabel(
	ports: BoardPorts,
	projectId: string,
	labelId: string,
	input: { name?: string; color?: string },
): Promise<ProjectOpResult<Label>> {
	const name = input.name?.trim();
	if (input.name !== undefined && !name) throw new Error("name must not be empty");
	const { project, result } = await data.updateProjectWith(projectId, (current) => {
		const labels = current.labels ?? [];
		const idx = labels.findIndex((label) => label.id === labelId);
		if (idx === -1) throw new Error(`Label not found: ${labelId}`);
		const next: Label = {
			...labels[idx],
			...(name !== undefined ? { name } : {}),
			...(input.color !== undefined ? { color: input.color } : {}),
		};
		if (next.name === labels[idx].name && next.color === labels[idx].color) {
			return { updates: {}, result: { label: labels[idx], changed: false } };
		}
		const nextLabels = [...labels];
		nextLabels[idx] = next;
		return { updates: { labels: nextLabels }, result: { label: next, changed: true } };
	});
	if (result.changed) pushProject(ports, project);
	return { verdict: result.changed ? "applied" : "noop", project, result: result.label };
}

/**
 * Removes the label from the project, then from every task holding it (each task
 * under its own lock). Pushes `projectUpdated` once, not one `taskUpdated` per task:
 * every peer re-reads tasks.json per notification, and the renderer already ignores
 * ids that name no project label.
 */
export async function deleteLabel(
	ports: BoardPorts,
	projectId: string,
	labelId: string,
): Promise<ProjectOpResult<{ removedFromTasks: number }>> {
	const { project, result: existed } = await data.updateProjectWith(projectId, (current) => {
		const labels = current.labels ?? [];
		if (!labels.some((label) => label.id === labelId)) return { updates: {}, result: false };
		return { updates: { labels: labels.filter((label) => label.id !== labelId) }, result: true };
	});
	let removedFromTasks = 0;
	for (const task of await data.loadTasks(project)) {
		if (!task.labelIds?.includes(labelId)) continue;
		const { result: removed } = await data.updateTaskWith(project, task.id, (current) => {
			const ids = current.labelIds ?? [];
			if (!ids.includes(labelId)) return { updates: {}, result: false };
			return { updates: { labelIds: ids.filter((id) => id !== labelId) }, result: true };
		});
		if (removed) removedFromTasks++;
	}
	const applied = existed || removedFromTasks > 0;
	if (applied) pushProject(ports, project);
	return { verdict: applied ? "applied" : "noop", project, result: { removedFromTasks } };
}

export async function reorderLabels(
	ports: BoardPorts,
	projectId: string,
	labelOrder: string[],
): Promise<ProjectOpResult<number>> {
	const { project, result } = await data.updateProjectWith(projectId, (current) => {
		const existing = current.labels ?? [];
		const reordered = labelOrder
			.map((id) => existing.find((label) => label.id === id))
			.filter((label): label is Label => label !== undefined);
		for (const label of existing) {
			if (!reordered.includes(label)) reordered.push(label);
		}
		const changed = !sameIds(existing.map((label) => label.id), reordered.map((label) => label.id));
		return { updates: changed ? { labels: reordered } : {}, result: { count: reordered.length, changed } };
	});
	if (result.changed) pushProject(ports, project);
	return { verdict: result.changed ? "applied" : "noop", project, result: result.count };
}
