import type { Project, Task, TaskRelation } from "../shared/types";
import { dependencyRefusal } from "../shared/task-dependencies";
import * as data from "./data";
import { getPushMessage } from "./rpc-handlers/shared-pure";

const isDependency = (r: TaskRelation) => r.type === "blocked-by";

async function saveRelations(project: Project, task: Task, next: (current: TaskRelation[]) => TaskRelation[]): Promise<Task> {
	const { task: updated } = await data.updateTaskWith(project, task.id, (cur) => ({
		updates: { relations: next(cur.relations ?? []) },
		result: null,
	}));
	getPushMessage()?.("taskUpdated", { projectId: project.id, task: updated });
	return updated;
}

/** Make `task` depend on each of `prereqs`, refusing a self-link, another board or a cycle. Nothing is written when one is refused. */
export async function addDependencies(project: Project, task: Task, prereqs: Task[]): Promise<Task> {
	const tasks = await data.loadTasks(project);
	for (const prereq of prereqs) {
		const refusal = dependencyRefusal(task, prereq, tasks);
		if (refusal) throw new Error(refusal);
	}
	return saveRelations(project, task, (current) => {
		const have = new Set(current.filter(isDependency).map((r) => r.taskId));
		const added = prereqs.filter((p) => !have.has(p.id) && have.add(p.id)).map((p): TaskRelation => ({ type: "blocked-by", taskId: p.id }));
		return [...current, ...added];
	});
}

/** Drop the dependencies on `prereqs` (any variant of each counts), or every dependency when `prereqs` is "all". */
export async function removeDependencies(project: Project, task: Task, prereqs: Task[] | "all"): Promise<Task> {
	if (prereqs === "all") return saveRelations(project, task, (current) => current.filter((r) => !isDependency(r)));
	const tasks = await data.loadTasks(project);
	const drop = new Set<string>();
	for (const prereq of prereqs) {
		const members = prereq.groupId == null ? [prereq] : tasks.filter((t) => t.groupId === prereq.groupId);
		const held = (task.relations ?? []).some((r) => isDependency(r) && members.some((m) => m.id === r.taskId));
		if (!held) {
			throw new Error(task.launchAfter && members.some((m) => m.id === task.launchAfter!.taskId)
				? `#${prereq.seq} is this task's start-after condition: remove it with --no-start-after.`
				: `Task #${task.seq} does not depend on #${prereq.seq}.`);
		}
		for (const m of members) drop.add(m.id);
	}
	return saveRelations(project, task, (current) => current.filter((r) => !(isDependency(r) && drop.has(r.taskId))));
}
