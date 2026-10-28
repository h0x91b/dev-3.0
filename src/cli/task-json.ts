import type { PRCIStatus, PRMergeState, PRReviewDecision, Task, TaskHistoryEntry, TaskNote, TaskOriginParent } from "../shared/types";
import { DEFAULT_PRIORITY, STATUS_LABELS, getTaskOverview, getTaskTitle, taskCompletesManually, taskOrigin } from "../shared/types";
import { allPullRequests } from "../shared/task-pull-requests";

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
	/** Every PR the task has had, newest first; `prNumber` is the current one. */
	pullRequests: Array<{ number: number; url: string; title: string | null; state: string | null }>;
	/**
	 * The PR poller's last reading, or null before its first one. `number` says
	 * which PR it describes — compare it with `prNumber` before trusting it.
	 */
	prStatus: {
		number: number;
		ciStatus: PRCIStatus | null;
		reviewDecision: PRReviewDecision | null;
		mergeState: PRMergeState | null;
		isDraft: boolean | null;
		autoMergeEnabled: boolean | null;
		unresolvedCount: number | null;
		cachedAt: string;
	} | null;
	/** The agent, terminal and dev server are stopped until the task is woken. */
	hibernated: boolean;
	/** `status` is the watchdog state: watching, reviving or gave-up. */
	keepAlive: { enabled: boolean; status: string } | null;
	createdAt: string;
	updatedAt: string;
	movedAt: string | null;
	noteCount: number;
	/**
	 * Who created the task. For `task`, `parent` is resolved at read time and is
	 * null when the parent was deleted.
	 */
	origin:
		| { kind: "user" }
		| { kind: "task"; taskId: string; projectId: string; parent: TaskOriginParent | null }
		| { kind: "automation"; automationId: string | null }
		| { kind: "import" };
	notes?: Array<Pick<TaskNote, "id" | "source" | "content" | "createdAt" | "updatedAt">>;
	history?: Array<Pick<TaskHistoryEntry, "at" | "changed" | "title" | "overview">>;
}

/** The task as `task.show` returns it: the stored task plus its resolved parent. */
export type ShownTask = Task & { originParent?: TaskOriginParent | null };

function originJson(task: ShownTask): TaskShowJson["origin"] {
	const origin = taskOrigin(task);
	if (origin.kind === "task") return { ...origin, parent: task.originParent ?? null };
	if (origin.kind === "automation") return { kind: "automation", automationId: task.automationId ?? null };
	return origin;
}

/** The "Created by" line for a non-user origin, or null for a task the user created. */
export function describeTaskOrigin(task: ShownTask): string | null {
	const origin = taskOrigin(task);
	if (origin.kind === "user") return null;
	if (origin.kind === "automation") return task.automationId ? `automation ${task.automationId.slice(0, 8)}` : "an automation";
	if (origin.kind === "import") return "a conversation import";
	const parent = task.originParent;
	if (!parent) return `a task (deleted) — ${origin.taskId.slice(0, 8)}`;
	const seq = parent.variantIndex !== null ? `${parent.seq}-${parent.variantIndex}` : String(parent.seq);
	return `#${seq} · ${parent.projectName} — ${parent.title} (seq:${parent.seq}, ${parent.id.slice(0, 8)})`;
}

function prStatusJson(task: Task): TaskShowJson["prStatus"] {
	const cache = task.prStatusCache;
	if (!cache) return null;
	return {
		number: cache.number,
		ciStatus: cache.ciStatus,
		reviewDecision: cache.reviewDecision ?? null,
		mergeState: cache.mergeState,
		isDraft: cache.isDraft,
		autoMergeEnabled: cache.autoMergeEnabled ?? null,
		unresolvedCount: cache.unresolvedCount,
		cachedAt: cache.cachedAt,
	};
}

export function buildTaskShowJson(task: ShownTask, opts: { notes?: boolean; history?: boolean } = {}): TaskShowJson {
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
		pullRequests: allPullRequests(task).map(({ number, url, title, state }) => ({
			number, url, title: title ?? null, state: state ?? null,
		})),
		prStatus: prStatusJson(task),
		hibernated: task.hibernated === true,
		keepAlive: task.keepAlive ? { enabled: task.keepAlive.enabled, status: task.keepAlive.status ?? "watching" } : null,
		createdAt: task.createdAt,
		updatedAt: task.updatedAt,
		movedAt: task.movedAt ?? null,
		noteCount: task.notes?.length ?? 0,
		origin: originJson(task),
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
