import type { Project, Task, TaskStatus, TmuxRestartImpact } from "../shared/types";
import { getTaskTitle, taskSeqLabel } from "../shared/types";
import { parseDev3SessionName, sessionShortId } from "./tmux/session-names";

/** Statuses the hooks set while an agent is mid-turn; a restart cuts that turn off. */
const WORKING_STATUSES: ReadonlySet<TaskStatus> = new Set(["in-progress", "review-by-ai"]);

/**
 * Counts what a tmux-server restart ends: the task terminals, every other
 * session, and the tasks whose agents are working right now.
 */
export function tmuxRestartImpact(
	sessionNames: string[],
	boards: Array<{ project: Pick<Project, "name">; tasks: Task[] }>,
): TmuxRestartImpact {
	const taskSessions = new Set<string>();
	let otherSessions = 0;
	for (const name of sessionNames) {
		const parsed = parseDev3SessionName(name);
		if (parsed?.kind === "task") taskSessions.add(parsed.shortId);
		else otherSessions++;
	}

	const working: TmuxRestartImpact["working"] = [];
	for (const { project, tasks } of boards) {
		for (const task of tasks) {
			if (!WORKING_STATUSES.has(task.status) || !taskSessions.has(sessionShortId(task.id))) continue;
			working.push({ taskId: task.id, seqLabel: taskSeqLabel(task), title: getTaskTitle(task), projectName: project.name });
		}
	}
	return { taskTerminals: taskSessions.size, otherSessions, working };
}
