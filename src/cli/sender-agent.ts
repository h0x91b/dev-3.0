import type { CliContext } from "./context";

/**
 * Our pane and pid, so the app can tell WHICH agent in the worktree ran this
 * command: replies and self-reminders go back to that agent, not a sibling. Only
 * from inside a worktree; the app decides whether an agent can be proven.
 */
export function senderAgentParams(context: CliContext | null): { sourcePaneId?: string; sourcePid?: number; sourceTmux?: string; sourceEnvTaskId?: string } {
	if (!context?.taskId) return {};
	const paneId = process.env.TMUX_PANE?.trim() || process.env.DEV3_PANE_ID?.trim();
	if (!paneId) return {};
	// Evidence for an agent started through a wrapper, which hides it from this process's ancestry.
	const sourceTmux = process.env.TMUX?.trim();
	const sourceEnvTaskId = process.env.DEV3_TASK_ID?.trim();
	return {
		sourcePaneId: paneId,
		sourcePid: process.pid,
		...(sourceTmux ? { sourceTmux } : {}),
		...(sourceEnvTaskId ? { sourceEnvTaskId } : {}),
	};
}
