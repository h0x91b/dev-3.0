import type { Task, TaskPriority, TaskStatus } from "../types";
import { DEFAULT_PRIORITY, compareTaskSortRank, getTaskTitle } from "../types";

/** Default page size for `tasks list` when no limit is given. */
export const DEFAULT_TASKS_LIST_LIMIT = 50;

export type TasksListSort = "priority" | "seq";

export interface TasksListOptions {
	/** Drop completed and cancelled tasks. */
	open?: boolean;
	/** A label id or id prefix. */
	label?: string;
	priorities?: ReadonlySet<TaskPriority>;
	sort?: TasksListSort;
	limit?: number;
	offset?: number;
}

export interface TasksListRow {
	id: string;
	seq: number;
	projectId: string;
	title: string;
	status: TaskStatus;
	customColumnId: string | null;
	priority: TaskPriority;
	taskType: string | null;
	draft: boolean;
	hibernated: boolean;
	runtimeState: Task["runtimeState"] | null;
	updatedAt: string;
}

/** `dev3 tasks list --json`. */
export interface TasksListJson {
	schemaVersion: 1;
	tasks: TasksListRow[];
	total: number;
	offset: number;
	limit: number;
}

// Listing order: live work first, then the backlog, then the archive. A default
// page must never be filled with completed tasks while something is running.
const STATUS_GROUP_RANK: Record<TaskStatus, number> = {
	"in-progress": 0,
	"user-questions": 0,
	"review-by-ai": 0,
	"review-by-user": 0,
	"review-by-colleague": 0,
	todo: 1,
	completed: 2,
	cancelled: 3,
};

// Custom-column tasks are live work too — they left To Do and never reached
// completed/cancelled, so they rank with the active group.
function groupRank(task: Task): number {
	if (task.customColumnId) return 0;
	return STATUS_GROUP_RANK[task.status] ?? 1;
}

/**
 * Filter, order and page the tasks `tasks.list` returned. Inside a status group
 * the default is the board's own comparator, so a listing and the Kanban column
 * agree on what is at the top; seq breaks ties, newest first. `sort: "seq"` drops
 * the priority key for chronological reading. Ordered before paging, so
 * offset/limit walk the printed order.
 */
export function selectTasksPage(all: readonly Task[], opts: TasksListOptions = {}): { page: Task[]; total: number; offset: number; limit: number } {
	let tasks = [...all];
	if (opts.open) tasks = tasks.filter((task) => task.status !== "completed" && task.status !== "cancelled");
	const label = opts.label;
	if (label) tasks = tasks.filter((t) => t.labelIds?.some((id) => id === label || id.startsWith(label)));
	const priorities = opts.priorities;
	if (priorities) tasks = tasks.filter((t) => priorities.has(t.priority ?? DEFAULT_PRIORITY));
	const sort = opts.sort ?? "priority";
	tasks.sort((a, b) =>
		groupRank(a) - groupRank(b)
		|| (sort === "priority" ? compareTaskSortRank(a, b) : 0)
		|| b.seq - a.seq,
	);
	const offset = opts.offset ?? 0;
	const limit = opts.limit ?? DEFAULT_TASKS_LIST_LIMIT;
	return { page: tasks.slice(offset, offset + limit), total: tasks.length, offset, limit };
}

export function tasksListRow(task: Task): TasksListRow {
	return {
		id: task.id, seq: task.seq, projectId: task.projectId,
		title: getTaskTitle(task), status: task.status,
		customColumnId: task.customColumnId ?? null,
		priority: task.priority ?? DEFAULT_PRIORITY,
		taskType: task.taskType ?? null,
		draft: task.draft === true, hibernated: task.hibernated === true,
		runtimeState: task.runtimeState ?? null,
		updatedAt: task.updatedAt,
	};
}

export function buildTasksListJson(all: readonly Task[], opts: TasksListOptions = {}): TasksListJson {
	const { page, total, offset, limit } = selectTasksPage(all, opts);
	return { schemaVersion: 1, tasks: page.map(tasksListRow), total, offset, limit };
}
