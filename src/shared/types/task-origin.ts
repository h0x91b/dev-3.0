import type { Task } from "./task";

// ---- Task origin (lineage) ----

/**
 * Who created a task. Written once inside task creation and never accepted by
 * an update path — see decisions/2026/10/28/task-origin-lineage.md. A `task`
 * origin points at the PARENT; tasks pointing at a parent are its CHILDREN.
 * Which automation / which imported session stays on `automationId` /
 * `importedSessionId`.
 */
export type TaskOrigin =
	| { kind: "user" }
	| { kind: "task"; taskId: string; projectId: string }
	| { kind: "automation" }
	| { kind: "import" };

export const TASK_ORIGIN_KINDS = ["user", "task", "automation", "import"] as const;

const USER_ORIGIN: TaskOrigin = { kind: "user" };

/** The task's origin; an absent or unreadable field is the user (every pre-lineage task). */
export function taskOrigin(task: Pick<Task, "origin">): TaskOrigin {
	const origin = task.origin;
	if (!origin || typeof origin !== "object") return USER_ORIGIN;
	if (origin.kind === "task") {
		return typeof origin.taskId === "string" && origin.taskId && typeof origin.projectId === "string"
			? origin
			: USER_ORIGIN;
	}
	if (origin.kind === "automation" || origin.kind === "import") return origin;
	return USER_ORIGIN;
}

/** The parent task id, or null when the task was not created by another task. */
export function parentTaskIdOf(task: Pick<Task, "origin">): string | null {
	const origin = taskOrigin(task);
	return origin.kind === "task" ? origin.taskId : null;
}

/** One task that takes part in lineage, as the board needs it to resolve a ref. */
export interface TaskLineageNode {
	id: string;
	projectId: string;
	projectName: string;
	seq: number;
	variantIndex: number | null;
	status: Task["status"];
	title: string;
}

/** Every parent→child edge across all projects; a parent absent from `nodes` was deleted. */
export interface TaskLineageIndex {
	nodes: TaskLineageNode[];
	edges: Array<{ childId: string; parentId: string }>;
}

/** A task origin's parent as resolved at read time — null when the parent was deleted. */
export interface TaskOriginParent {
	id: string;
	projectId: string;
	projectName: string;
	seq: number;
	variantIndex: number | null;
	title: string;
}

/** `#42` or, for one member of a variant group, `#42-2`. */
export function lineageSeqLabel(node: { seq: number; variantIndex: number | null }, isVariantGroup: boolean): string {
	return isVariantGroup && node.variantIndex !== null ? `#${node.seq}-${node.variantIndex}` : `#${node.seq}`;
}
