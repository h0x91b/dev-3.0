import type { BoardColumnSlot, Task } from "../../../shared/types";
import { priorityRank } from "../../../shared/types";
import { parentTaskIdOf } from "../../../shared/types/task-origin";
import { taskLastActivityMs } from "../../utils/projectActivity";

/** Every column the Table can show, in canonical display order (spec D18). */
export const TABLE_COLUMNS = [
	"seq", "title", "project", "status", "priority", "labels", "agent", "pr", "activity",
	"parent", "created", "branch", "type",
] as const;
export type TableColumnId = (typeof TABLE_COLUMNS)[number];

export const DEFAULT_TABLE_COLUMNS: readonly TableColumnId[] = [
	"seq", "title", "status", "priority", "labels", "agent", "pr", "activity",
];

export type SortDirection = "asc" | "desc";
export type TableSort = readonly [TableColumnId, SortDirection];

/** What the Table persists through `ctx.board.setLayout("builtin:table", …)`. */
export interface TableLayout {
	columns: TableColumnId[];
	sort: TableSort;
}

export type TableBoardKind = "project" | "space";

const DEFAULT_SORT: TableSort = ["activity", "desc"];
/** Columns whose natural first click is "newest first". */
const DESC_FIRST: ReadonlySet<TableColumnId> = new Set(["activity", "created"]);

function isColumnId(value: unknown): value is TableColumnId {
	return typeof value === "string" && (TABLE_COLUMNS as readonly string[]).includes(value);
}

function allowedOn(kind: TableBoardKind, column: TableColumnId): boolean {
	return column !== "project" || kind === "space";
}

function canonical(columns: Iterable<TableColumnId>): TableColumnId[] {
	const set = new Set(columns);
	return TABLE_COLUMNS.filter((c) => set.has(c));
}

export function defaultTableLayout(kind: TableBoardKind): TableLayout {
	const columns = kind === "space" ? canonical([...DEFAULT_TABLE_COLUMNS, "project"]) : [...DEFAULT_TABLE_COLUMNS];
	return { columns, sort: DEFAULT_SORT };
}

/** A stored layout made safe: unknown columns dropped, canonical order, the title kept, a broken sort reset. */
export function normalizeTableLayout(raw: unknown, kind: TableBoardKind): TableLayout {
	const fallback = defaultTableLayout(kind);
	if (typeof raw !== "object" || raw === null || !Array.isArray((raw as { columns?: unknown }).columns)) return fallback;
	const stored = raw as { columns: unknown[]; sort?: unknown };

	const columns = canonical([...stored.columns.filter(isColumnId).filter((c) => allowedOn(kind, c)), "title"]);

	const sort = stored.sort;
	const validSort = Array.isArray(sort) && sort.length === 2 && isColumnId(sort[0]) && allowedOn(kind, sort[0])
		&& (sort[1] === "asc" || sort[1] === "desc");
	return { columns, sort: validSort ? [sort[0], sort[1]] as TableSort : DEFAULT_SORT };
}

export function toggleTableSort(layout: TableLayout, column: TableColumnId): TableLayout {
	const [active, direction] = layout.sort;
	if (active === column) return { ...layout, sort: [column, direction === "asc" ? "desc" : "asc"] };
	return { ...layout, sort: [column, DESC_FIRST.has(column) ? "desc" : "asc"] };
}

/** Show or hide one column; shown columns keep the canonical order. The title is never hidden. */
export function toggleTableColumn(layout: TableLayout, column: TableColumnId, kind: TableBoardKind): TableLayout {
	if (column === "title" || !allowedOn(kind, column)) return layout;
	const shown = layout.columns.includes(column);
	const columns = shown ? layout.columns.filter((c) => c !== column) : canonical([...layout.columns, column]);
	return { ...layout, columns };
}

/** Index of the board lane a task sits in; -1 when the board does not show that lane. */
export function laneOfTask(task: Task, columns: readonly BoardColumnSlot[]): number {
	if (task.customColumnId) {
		const custom = columns.findIndex((lane) => lane.type === "custom" && lane.members.some((m) => m.columnId === task.customColumnId));
		if (custom >= 0) return custom;
	}
	return columns.findIndex((lane) => lane.type === "builtin" && lane.status === task.status);
}

export function taskPrNumber(task: Task): number | null {
	const history = task.pullRequests ?? [];
	return task.prNumber ?? history[history.length - 1]?.number ?? null;
}

export interface TableSortContext {
	columns: readonly BoardColumnSlot[];
	agentName(agentId: string | null): string;
	projectName(projectId: string): string;
	taskSeqById(taskId: string): number | null;
}

type SortKey = string | number | null;

function sortKey(task: Task, column: TableColumnId, ctx: TableSortContext): SortKey {
	switch (column) {
		// Variants share a seq; they order by attempt number inside it.
		case "seq": return task.seq + (task.variantIndex ?? 0) / 1000;
		case "title": return (task.customTitle || task.title).toLocaleLowerCase();
		case "project": return ctx.projectName(task.projectId).toLocaleLowerCase() || null;
		case "status": {
			const lane = laneOfTask(task, ctx.columns);
			return lane >= 0 ? lane : Number.MAX_SAFE_INTEGER;
		}
		case "priority": return priorityRank(task.priority);
		case "labels": return task.labelIds?.length || null;
		case "agent": return ctx.agentName(task.agentId).toLocaleLowerCase() || null;
		case "pr": return taskPrNumber(task);
		case "activity": return taskLastActivityMs(task);
		case "parent": {
			const parentId = parentTaskIdOf(task);
			return parentId ? ctx.taskSeqById(parentId) : null;
		}
		case "created": return Date.parse(task.createdAt) || null;
		case "branch": return task.branchName || null;
		case "type": return task.taskType ?? null;
	}
}

function compareKeys(a: SortKey, b: SortKey): number {
	if (typeof a === "number" && typeof b === "number") return a - b;
	return String(a).localeCompare(String(b));
}

/** A sorted copy. Empty values go last in both directions; ties fall back to newest seq first. */
export function sortTableTasks(tasks: readonly Task[], [column, direction]: TableSort, ctx: TableSortContext): Task[] {
	const sign = direction === "asc" ? 1 : -1;
	const keyed = tasks.map((task) => ({ task, key: sortKey(task, column, ctx) }));
	keyed.sort((x, y) => {
		const xEmpty = x.key === null;
		const yEmpty = y.key === null;
		if (xEmpty !== yEmpty) return xEmpty ? 1 : -1;
		const byKey = xEmpty ? 0 : sign * compareKeys(x.key, y.key);
		return byKey || y.task.seq - x.task.seq || (x.task.variantIndex ?? 0) - (y.task.variantIndex ?? 0);
	});
	return keyed.map((entry) => entry.task);
}
