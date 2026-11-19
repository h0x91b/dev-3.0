import type { Task, TaskStatus } from "./types";

/**
 * Task dependencies: one kind of link, "this task depends on that one".
 * Stored as `blocked-by` entries in `Task.relations`; a "start after"
 * condition (`Task.launchAfter`) is the same link with an automatic start on it.
 * A dependency only orders and warns. See decisions/2026/11/13/task-dependencies-on-relations.md.
 */

/** `cancelled`: every variant finished and none completed. It no longer blocks, and is never reported as done. */
export type DependencyState = "open" | "done" | "cancelled";

export interface ResolvedDependency {
	taskId: string;
	seq: number;
	title: string;
	status: TaskStatus;
	state: DependencyState;
}

/** `blocked`: at least one dependency is open. `ready`: it has dependencies and none is open. */
export type DependencyVerdict = "none" | "blocked" | "ready";

export interface DependencySummary {
	verdict: DependencyVerdict;
	dependencies: ResolvedDependency[];
	open: ResolvedDependency[];
	cancelled: ResolvedDependency[];
}

/** A board looked up once: by id, by variant group, and who depends on whom. */
export interface DependencyIndex {
	byId: Map<string, Task>;
	groups: Map<string, Task[]>;
	dependents: Map<string, Task[]>;
}

/** Every function here takes the board or an index of it; build the index once when resolving many tasks. */
export type DependencyBoard = Task[] | DependencyIndex;

const isFinished = (t: Task) => t.status === "completed" || t.status === "cancelled";

/** Ids of the tasks `task` depends on: its `blocked-by` relations plus its start-after prerequisite. */
export function dependencyIds(task: Pick<Task, "relations" | "launchAfter">): string[] {
	const ids = (task.relations ?? []).filter((r) => r.type === "blocked-by").map((r) => r.taskId);
	if (task.launchAfter) ids.push(task.launchAfter.taskId);
	return [...new Set(ids)];
}

export function indexDependencies(tasks: Task[]): DependencyIndex {
	const byId = new Map<string, Task>();
	const groups = new Map<string, Task[]>();
	const dependents = new Map<string, Task[]>();
	const push = (map: Map<string, Task[]>, key: string, t: Task) => {
		const list = map.get(key);
		if (list) list.push(t);
		else map.set(key, [t]);
	};
	for (const t of tasks) {
		byId.set(t.id, t);
		if (t.groupId != null) push(groups, t.groupId, t);
		for (const id of dependencyIds(t)) {
			if (id !== t.id) push(dependents, id, t);
		}
	}
	return { byId, groups, dependents };
}

const asIndex = (board: DependencyBoard): DependencyIndex => (Array.isArray(board) ? indexDependencies(board) : board);

/** The dependency plus every variant of its group: any of them can satisfy the link. */
function membersOf(dep: Task, index: DependencyIndex): Task[] {
	return dep.groupId == null ? [dep] : index.groups.get(dep.groupId) ?? [dep];
}

/** Done once any variant completed; cancelled once every variant finished without one completing. */
function stateOf(dep: Task, index: DependencyIndex): DependencyState {
	const members = membersOf(dep, index);
	if (members.some((t) => t.status === "completed")) return "done";
	return members.every(isFinished) ? "cancelled" : "open";
}

/** What `task` depends on, resolved against its board. A deleted dependency is dropped. */
export function resolveDependencies(task: Task, board: DependencyBoard): ResolvedDependency[] {
	const index = asIndex(board);
	const resolved: ResolvedDependency[] = [];
	for (const id of dependencyIds(task)) {
		const dep = index.byId.get(id);
		if (!dep) continue;
		resolved.push({ taskId: dep.id, seq: dep.seq, title: dep.customTitle || dep.title, status: dep.status, state: stateOf(dep, index) });
	}
	return resolved.sort((a, b) => a.seq - b.seq);
}

export function summarizeDependencies(task: Task, board: DependencyBoard): DependencySummary {
	const dependencies = resolveDependencies(task, board);
	const open = dependencies.filter((d) => d.state === "open");
	const cancelled = dependencies.filter((d) => d.state === "cancelled");
	return { verdict: dependencies.length === 0 ? "none" : open.length ? "blocked" : "ready", dependencies, open, cancelled };
}

/** The tasks that depend on `task`, lowest seq first. */
export function dependentsOf(task: Task, board: DependencyBoard): Task[] {
	return [...(asIndex(board).dependents.get(task.id) ?? [])].sort((a, b) => a.seq - b.seq);
}

/** True when `prereq` already depends, directly or through other tasks, on `task`: linking them would close a loop. */
export function dependencyWouldCycle(task: Task, prereq: Task, board: DependencyBoard): boolean {
	const { byId } = asIndex(board);
	const seen = new Set<string>();
	const queue = [prereq];
	for (let cur = queue.pop(); cur; cur = queue.pop()) {
		if (cur.id === task.id) return true;
		if (seen.has(cur.id)) continue;
		seen.add(cur.id);
		for (const id of dependencyIds(cur)) {
			const next = byId.get(id);
			if (next) queue.push(next);
		}
	}
	return false;
}

/** Why `task` cannot depend on `prereq`, or null when it can. `board` is the whole board. */
export function dependencyRefusal(task: Task, prereq: Task, board: DependencyBoard): string | null {
	if (prereq.id === task.id) return "A task cannot depend on itself.";
	if (prereq.projectId !== task.projectId) return `Task #${prereq.seq} is on another board: a dependency stays on one board.`;
	if (task.groupId != null && prereq.groupId === task.groupId) return `Task #${prereq.seq} is a variant of this task.`;
	if (dependencyWouldCycle(task, prereq, board)) {
		return `Task #${prereq.seq} already depends, directly or through other tasks, on #${task.seq}. That would be a cycle.`;
	}
	return null;
}

/** "#3, #5" for a warning or a chip. */
export function formatDependencyRefs(deps: Array<{ seq: number }>): string {
	return deps.map((d) => `#${d.seq}`).join(", ");
}

/** What `task show` and `task list` carry about a task's links, resolved by the app. */
export interface TaskDependencyInfo {
	verdict: DependencyVerdict;
	dependsOn: ResolvedDependency[];
	blocks: Array<Pick<ResolvedDependency, "taskId" | "seq" | "title" | "status">>;
}

/** Null when the task has no link in either direction. */
export function dependencyInfo(task: Task, board: DependencyBoard): TaskDependencyInfo | null {
	const index = asIndex(board);
	const { verdict, dependencies } = summarizeDependencies(task, index);
	const blocks = dependentsOf(task, index).map((t) => ({ taskId: t.id, seq: t.seq, title: t.customTitle || t.title, status: t.status }));
	return dependencies.length || blocks.length ? { verdict, dependsOn: dependencies, blocks } : null;
}
