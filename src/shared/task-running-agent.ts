import type { Task } from "./types";

/** The agent a task runs: its own pick, else (no pick, worktree exists) the main pane's, i.e. the global default. */
export function taskRunningAgentIds(
	task: Pick<Task, "agentId" | "configId" | "worktreePath" | "sessionState">,
): { agentId: string | null; configId: string | null } {
	if (task.agentId) return { agentId: task.agentId, configId: task.configId ?? null };
	const pane = task.worktreePath ? task.sessionState?.panes?.[0] : undefined;
	return { agentId: pane?.agentId ?? null, configId: pane?.configId ?? null };
}
