import type { Project, Task, TaskRelation } from "../shared/types";
import { dependencyRefusal, indexDependencies } from "../shared/task-dependencies";
import * as data from "./data";
import { getPushMessage } from "./rpc-handlers/shared-pure";

const isDependency = (r: TaskRelation) => r.type === "blocked-by";

/** What one `task create|update` asks of the links: drop some (any variant of each counts) or all, then add some. */
export interface DependencyChange {
	drop?: Task[] | "all" | null;
	add?: Task[] | null;
}

/** A change already checked against the board: ids to drop, then ids to add. */
export interface DependencyPlan {
	drop: Set<string> | "all";
	add: string[];
}

/**
 * Check a whole change before anything is written, so a refused part leaves the task as it was.
 * Refuses removing a link the task does not hold, and a self-link, another board or a cycle.
 */
export function planDependencyChange(task: Task, board: Task[], change: DependencyChange): DependencyPlan {
	const index = indexDependencies(board);
	let drop: Set<string> | "all" = new Set<string>();
	if (change.drop === "all") drop = "all";
	else for (const prereq of change.drop ?? []) {
		const members = prereq.groupId == null ? [prereq] : index.groups.get(prereq.groupId) ?? [prereq];
		const held = (task.relations ?? []).some((r) => isDependency(r) && members.some((m) => m.id === r.taskId));
		if (!held) {
			throw new Error(task.launchAfter && members.some((m) => m.id === task.launchAfter!.taskId)
				? `#${prereq.seq} is this task's start-after condition: remove it with --no-start-after.`
				: `Task #${task.seq} does not depend on #${prereq.seq}.`);
		}
		for (const m of members) drop.add(m.id);
	}
	for (const prereq of change.add ?? []) {
		const refusal = dependencyRefusal(task, prereq, index);
		if (refusal) throw new Error(refusal);
	}
	return { drop, add: (change.add ?? []).map((p) => p.id) };
}

/** Apply a checked plan in one write under the tasks-file lock, against the task as it is on disk then. */
export async function writeDependencyPlan(project: Project, task: Task, plan: DependencyPlan): Promise<Task> {
	const { task: updated } = await data.updateTaskWith(project, task.id, (cur) => {
		const current = cur.relations ?? [];
		const kept = current.filter((r) => !isDependency(r) || (plan.drop !== "all" && !plan.drop.has(r.taskId)));
		const have = new Set(kept.filter(isDependency).map((r) => r.taskId));
		const added = plan.add.filter((id) => !have.has(id) && have.add(id)).map((taskId): TaskRelation => ({ type: "blocked-by", taskId }));
		return { updates: { relations: [...kept, ...added] }, result: null };
	});
	getPushMessage()?.("taskUpdated", { projectId: project.id, task: updated });
	return updated;
}

/** Make `task` depend on each of `prereqs`. Nothing is written when one is refused. */
export async function addDependencies(project: Project, task: Task, prereqs: Task[]): Promise<Task> {
	return writeDependencyPlan(project, task, planDependencyChange(task, await data.loadTasks(project), { add: prereqs }));
}
