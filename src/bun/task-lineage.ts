import type { Project, Task, TaskLineageIndex, TaskLineageNode } from "../shared/types";
import { getTaskTitle, parentTaskIdOf } from "../shared/types";
import * as data from "./data";

async function allBoards(): Promise<Array<{ project: Project; tasks: Task[] }>> {
	const projects = [...await data.loadProjects(), ...await data.loadVirtualProjects()];
	return Promise.all(projects.map(async (project) => ({ project, tasks: await data.loadTasks(project) })));
}

/** `variantIndex` only for a real group: a lone launched task still carries index 1. */
function lineageNode(task: Task, project: Project, groupSizes: ReadonlyMap<string, number>): TaskLineageNode {
	const inGroup = task.groupId !== null && (groupSizes.get(task.groupId) ?? 0) > 1;
	return {
		id: task.id,
		projectId: task.projectId,
		projectName: project.name,
		seq: task.seq,
		variantIndex: inGroup ? task.variantIndex : null,
		status: task.status,
		title: getTaskTitle(task),
	};
}

/**
 * Every parent→child edge on every board, with a node for each child and each
 * parent that still exists. A parent id missing from `nodes` was deleted. Only
 * tasks that take part in lineage are included, so the payload stays small.
 */
export async function loadTaskLineage(): Promise<TaskLineageIndex> {
	const boards = await allBoards();
	const byId = new Map<string, Task>();
	const projectOf = new Map<string, Project>();
	const groupSizes = new Map<string, number>();
	for (const { project, tasks } of boards) {
		for (const task of tasks) {
			byId.set(task.id, task);
			projectOf.set(task.id, project);
			if (task.groupId) groupSizes.set(task.groupId, (groupSizes.get(task.groupId) ?? 0) + 1);
		}
	}

	const nodes = new Map<string, TaskLineageNode>();
	const edges: TaskLineageIndex["edges"] = [];
	for (const task of byId.values()) {
		const parentId = parentTaskIdOf(task);
		if (!parentId) continue;
		edges.push({ childId: task.id, parentId });
		nodes.set(task.id, lineageNode(task, projectOf.get(task.id)!, groupSizes));
		const parent = byId.get(parentId);
		if (parent) nodes.set(parent.id, lineageNode(parent, projectOf.get(parent.id)!, groupSizes));
	}
	return { nodes: [...nodes.values()], edges };
}

/** Direct children, from every project, of any task in `parentIds` (a variant group). */
export async function loadTaskChildren(parentIds: ReadonlySet<string>): Promise<Array<{ project: Project; task: Task }>> {
	const children: Array<{ project: Project; task: Task }> = [];
	for (const { project, tasks } of await allBoards()) {
		for (const task of tasks) {
			const parentId = parentTaskIdOf(task);
			if (parentId && parentIds.has(parentId)) children.push({ project, task });
		}
	}
	return children;
}
