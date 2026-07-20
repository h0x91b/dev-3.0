import { buildTaskDialogSubject, getTaskTitle } from "../../shared/types";
import type { Project, Task, TaskDialogSubject } from "../../shared/types";
import type { ConfirmOptions } from "../confirm";

type ConfirmInfo = NonNullable<ConfirmOptions["info"]>;

/**
 * Build the `confirm()` info card for a task-lifecycle prompt (completion /
 * cancel / branch-merged) from a wire {@link TaskDialogSubject}. Used by the
 * App-level push handlers, where the full task object is not available — only
 * the subject shipped in the push message. `subject` may be absent when an older
 * push omits it, in which case only the task title is shown.
 */
export function taskDialogInfoFromSubject(taskTitle: string, subject?: TaskDialogSubject): ConfirmInfo {
	if (!subject) return { title: taskTitle };
	return {
		title: taskTitle,
		body: subject.overview ?? undefined,
		seqLabel: subject.seqLabel,
		projectName: subject.projectName,
		priority: subject.priority,
		labels: subject.labels,
	};
}

/**
 * Convenience for renderer call sites that already hold the live `task` and
 * `project` (info panel, card, drag-to-complete): resolves the subject and maps
 * it to the confirm info card in one step. Equivalent to the wire path so every
 * worktree-destroying prompt renders the same context card.
 */
export function taskDialogInfo(task: Task, project: Project): ConfirmInfo {
	return taskDialogInfoFromSubject(getTaskTitle(task), buildTaskDialogSubject(task, project));
}
