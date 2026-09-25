import type { Project, Task, TaskType } from "../../shared/types";
import { getTaskTitle, titleFromDescription } from "../../shared/types";
import * as data from "../data";
import { pushTaskUpdated, type BoardActor, type BoardPorts, type TaskOpResult } from "./types";

/**
 * A task's metadata — title, description, role, completion policy, overviews — one
 * implementation for every door. Rules are evaluated on the task read inside the
 * tasks-file lock, never on a snapshot the caller loaded earlier.
 *
 * Borrowed from the lifecycle: a completion-policy flip resets the lifecycle-owned
 * `mergeCompletionPrompt` and drops the merge-prompt reservation, outside the actor
 * mailbox, exactly as both doors did before this module existed.
 */

export function isScratchPlaceholderDescription(description: string): boolean {
	return /^Scratch — \d{2}:\d{2}$/.test(description.trim());
}

export interface TitleDescriptionChange {
	/** `null` or blank clears the custom title. */
	title?: { value: string | null; force?: boolean };
	description?: string;
}

export interface TaskMetadataChange extends TitleDescriptionChange {
	taskType?: TaskType | null;
	manualCompletion?: boolean;
	overview?: string | null;
	userOverview?: string | null;
}

/**
 * The title/description rules, shared with `editTask`, which writes them inside its
 * own lock alongside its draft-only fields.
 *
 * - An agent may not overwrite a user-edited title unless `force` → `rejected: ["title"]`.
 * - A user title marks the title user-edited; clearing a title (either actor) unmarks it.
 * - A real title or description takes a task out of scratch.
 * - With no custom title left, the auto title is recomputed from the description:
 *   `titleFromDescription(description) || current title || fallbackTitle`.
 */
export function planTitleAndDescription(
	current: Task,
	change: TitleDescriptionChange,
	actor: BoardActor,
	opts: { fallbackTitle?: () => string } = {},
): { updates: Partial<Task>; rejected: "title"[] } {
	const updates: Partial<Task> = {};
	const rejected: "title"[] = [];
	let customTitle = current.customTitle ?? null;
	let titleApplied = false;

	if (change.title !== undefined) {
		const value = change.title.value?.trim() || null;
		if (value && actor.kind === "agent" && current.titleEditedByUser && !change.title.force) {
			rejected.push("title");
		} else {
			titleApplied = true;
			customTitle = value;
			updates.customTitle = value;
			if (actor.kind === "user") updates.titleEditedByUser = value !== null;
			else if (!value) updates.titleEditedByUser = false;
			if (value && current.scratch === true) updates.scratch = false;
		}
	}

	const description = change.description ?? current.description;
	if (change.description !== undefined) {
		updates.description = change.description;
		if (current.scratch === true && change.description.trim() && !isScratchPlaceholderDescription(change.description)) {
			updates.scratch = false;
		}
	}

	if (!customTitle && (change.description !== undefined || titleApplied)) {
		updates.title = titleFromDescription(description) || current.title || opts.fallbackTitle?.() || "";
	}
	return { updates, rejected };
}

function sameValue(a: unknown, b: unknown): boolean {
	return (a ?? null) === (b ?? null) || (a === false && b == null) || (b === false && a == null);
}

/** Drop every field that already holds the requested value. */
export function withoutUnchanged(current: Task, updates: Partial<Task>): Partial<Task> {
	const changed: Partial<Task> = {};
	for (const [key, value] of Object.entries(updates) as [keyof Task, unknown][]) {
		if (!sameValue(current[key], value)) (changed as Record<string, unknown>)[key] = value;
	}
	return changed;
}

/**
 * Apply `change` in one write and at most one `taskUpdated` push. A change whose
 * every field already matches is `noop`; one refused entirely by the title guard is
 * `guardRejected`. `manualCompletionChanged` is pushed only for an agent — a user's
 * own toggle stays silent (App.tsx toasts agent changes).
 */
export async function updateTaskMetadata(
	ports: BoardPorts,
	project: Project,
	taskId: string,
	change: TaskMetadataChange,
	actor: BoardActor,
): Promise<TaskOpResult> {
	const { task, result } = await data.updateTaskWith(project, taskId, (current) => {
		const { updates, rejected } = planTitleAndDescription(current, change, actor);
		if (change.taskType !== undefined) updates.taskType = change.taskType;
		if (change.overview !== undefined) updates.overview = change.overview?.trim() || null;
		if (change.userOverview !== undefined) updates.userOverview = change.userOverview?.trim() || null;
		const flipsCompletion = change.manualCompletion !== undefined && change.manualCompletion !== current.manualCompletion;
		if (flipsCompletion) {
			updates.manualCompletion = change.manualCompletion;
			updates.mergeCompletionPrompt = null;
		}
		const changed = withoutUnchanged(current, updates);
		return { updates: changed, result: { rejected, applied: Object.keys(changed).length > 0, flipsCompletion } };
	});

	const { rejected, applied, flipsCompletion } = result;
	if (!applied) return { verdict: rejected.length > 0 ? "guardRejected" : "noop", task, rejected };

	if (flipsCompletion) await ports.clearMergeNotification(task.id);
	pushTaskUpdated(ports, project, task);
	if (flipsCompletion && actor.kind === "agent") {
		ports.push("manualCompletionChanged", {
			taskId: task.id,
			projectId: project.id,
			manualCompletion: task.manualCompletion === true,
			taskSeq: task.seq,
			taskTitle: getTaskTitle(task),
			projectName: project.name,
		});
	}
	return { verdict: "applied", task, rejected };
}
