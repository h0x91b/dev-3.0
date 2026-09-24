import type { Task, TaskHistoryEntry, TaskNote } from "../shared/types";
import { DEFAULT_PRIORITY, STATUS_LABELS, getTaskOverview, getTaskTitle, taskCompletesManually } from "../shared/types";

/**
 * `dev3 task show --json` is a public contract, so it is a projection with a
 * version, never a dump of the stored `Task`: internal fields come and go, and a
 * script reading `description` must not break when one does. Additive changes
 * keep `schemaVersion`; removing or renaming a field bumps it.
 */
export const TASK_SHOW_JSON_SCHEMA_VERSION = 1;

export interface TaskShowJson {
	schemaVersion: typeof TASK_SHOW_JSON_SCHEMA_VERSION;
	id: string;
	seq: number;
	projectId: string;
	/** The effective title — what the card shows. */
	title: string;
	titleEditedByUser: boolean;
	/** The raw description, byte for byte, even when it equals the title. */
	description: string;
	/** The effective overview (user's wins over the agent's), or null. */
	overview: string | null;
	status: string;
	statusLabel: string;
	customColumnId: string | null;
	priority: string;
	taskType: string | null;
	draft: boolean;
	manualCompletion: boolean;
	branch: string | null;
	baseBranch: string;
	worktree: string | null;
	labelIds: string[];
	groupId: string | null;
	variantIndex: number | null;
	prNumber: number | null;
	prUrl: string | null;
	createdAt: string;
	updatedAt: string;
	movedAt: string | null;
	noteCount: number;
	notes?: Array<Pick<TaskNote, "id" | "source" | "content" | "createdAt" | "updatedAt">>;
	history?: Array<Pick<TaskHistoryEntry, "at" | "changed" | "title" | "overview">>;
}

export function buildTaskShowJson(task: Task, opts: { notes?: boolean; history?: boolean } = {}): TaskShowJson {
	const json: TaskShowJson = {
		schemaVersion: TASK_SHOW_JSON_SCHEMA_VERSION,
		id: task.id,
		seq: task.seq,
		projectId: task.projectId,
		title: getTaskTitle(task),
		titleEditedByUser: task.titleEditedByUser === true,
		description: task.description ?? "",
		overview: getTaskOverview(task) ?? null,
		status: task.status,
		statusLabel: STATUS_LABELS[task.status] || task.status,
		customColumnId: task.customColumnId ?? null,
		priority: task.priority ?? DEFAULT_PRIORITY,
		taskType: task.taskType ?? null,
		draft: task.draft === true,
		manualCompletion: taskCompletesManually(task),
		branch: task.branchName ?? null,
		baseBranch: task.baseBranch,
		worktree: task.worktreePath ?? null,
		labelIds: task.labelIds ?? [],
		groupId: task.groupId ?? null,
		variantIndex: task.variantIndex ?? null,
		prNumber: task.prNumber ?? null,
		prUrl: task.prUrl ?? null,
		createdAt: task.createdAt,
		updatedAt: task.updatedAt,
		movedAt: task.movedAt ?? null,
		noteCount: task.notes?.length ?? 0,
	};
	if (opts.notes) {
		json.notes = (task.notes ?? []).map(({ id, source, content, createdAt, updatedAt }) => ({
			id, source, content, createdAt, updatedAt,
		}));
	}
	if (opts.history) {
		json.history = (task.history ?? []).map(({ at, changed, title, overview }) => ({ at, changed, title, overview }));
	}
	return json;
}
