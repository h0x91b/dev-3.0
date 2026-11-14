import type { Task, TaskStatus } from "./types";

/**
 * Task dependencies: one kind of link, "this task depends on that one".
 * Stored as `blocked-by` entries in `Task.relations`; a "start after"
 * condition (`Task.launchAfter`) is the same link with an automatic start on it.
 * A dependency only orders and warns. See decisions/2026/11/13/task-dependencies-on-relations.md.
 */

export type DependencyState = "open" | "done";

export interface ResolvedDependency {
	taskId: string;
	seq: number;
	title: string;
	status: TaskStatus;
	state: DependencyState;
}

/** `blocked`: at least one dependency is open. `ready`: it has dependencies and all are done. */
export type DependencyVerdict = "none" | "blocked" | "ready";

export interface DependencySummary {
	verdict: DependencyVerdict;
	dependencies: ResolvedDependency[];
	open: ResolvedDependency[];
}

const isFinished = (t: Task) => t.status === "completed" || t.status === "cancelled";

/** Ids of the tasks `task` depends on: its `blocked-by` relations plus its start-after prerequisite. */
export function dependencyIds(task: Pick<Task, "relations" | "launchAfter">): string[] {
	const ids = (task.relations ?? []).filter((r) => r.type === "blocked-by").map((r) => r.taskId);
	if (task.launchAfter) ids.push(task.launchAfter.taskId);
	return [...new Set(ids)];
}

/** The dependency plus every variant of its group: any of them can satisfy the link. */
function membersOf(dep: Task, tasks: Task[]): Task[] {
	return dep.groupId == null ? [dep] : tasks.filter((t) => t.groupId === dep.groupId);
}

/**
 * Done once any variant completed, or once every variant is finished (a cancelled
 * dependency no longer holds anything back; `task show` still names its status).
 */
function stateOf(dep: Task, tasks: Task[]): DependencyState {
	const members = membersOf(dep, tasks);
	return members.some((t) => t.status === "completed") || members.every(isFinished) ? "done" : "open";
}

/** What `task` depends on, resolved against its board. A deleted dependency is dropped. */
export function resolveDependencies(task: Task, tasks: Task[]): ResolvedDependency[] {
	const byId = new Map(tasks.map((t) => [t.id, t]));
	const resolved: ResolvedDependency[] = [];
	for (const id of dependencyIds(task)) {
		const dep = byId.get(id);
		if (!dep) continue;
		resolved.push({ taskId: dep.id, seq: dep.seq, title: dep.customTitle || dep.title, status: dep.status, state: stateOf(dep, tasks) });
	}
	return resolved.sort((a, b) => a.seq - b.seq);
}

export function summarizeDependencies(task: Task, tasks: Task[]): DependencySummary {
	const dependencies = resolveDependencies(task, tasks);
	const open = dependencies.filter((d) => d.state === "open");
	return { verdict: dependencies.length === 0 ? "none" : open.length ? "blocked" : "ready", dependencies, open };
}

/** The tasks that depend on `task`, lowest seq first. */
export function dependentsOf(task: Task, tasks: Task[]): Task[] {
	return tasks.filter((t) => t.id !== task.id && dependencyIds(t).includes(task.id)).sort((a, b) => a.seq - b.seq);
}

/** True when `prereq` already depends, directly or through other tasks, on `task`: linking them would close a loop. */
export function dependencyWouldCycle(task: Task, prereq: Task, tasks: Task[]): boolean {
	const byId = new Map(tasks.map((t) => [t.id, t]));
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

/** Why `task` cannot depend on `prereq`, or null when it can. `tasks` is the whole board. */
export function dependencyRefusal(task: Task, prereq: Task, tasks: Task[]): string | null {
	if (prereq.id === task.id) return "A task cannot depend on itself.";
	if (prereq.projectId !== task.projectId) return `Task #${prereq.seq} is on another board: a dependency stays on one board.`;
	if (task.groupId != null && prereq.groupId === task.groupId) return `Task #${prereq.seq} is a variant of this task.`;
	if (dependencyWouldCycle(task, prereq, tasks)) {
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
export function dependencyInfo(task: Task, tasks: Task[]): TaskDependencyInfo | null {
	const { verdict, dependencies } = summarizeDependencies(task, tasks);
	const blocks = dependentsOf(task, tasks).map((t) => ({ taskId: t.id, seq: t.seq, title: t.customTitle || t.title, status: t.status }));
	return dependencies.length || blocks.length ? { verdict, dependsOn: dependencies, blocks } : null;
}
