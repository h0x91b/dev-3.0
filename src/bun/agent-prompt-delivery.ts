/**
 * The ONE backend-neutral entry point for typing a prompt into a task's agent.
 *
 * Everything that hands a task's agent some text goes through here: `dev3 message`
 * (immediate), scheduled-message delivery, the Create-PR / auto-merge / commit
 * hand-offs, and the rebase-conflict hand-off. Before this seam existed each of
 * them called the tmux helpers directly, so a task running on the native backend
 * had no pane to find and every send failed with "no live agent session" while the
 * agent was plainly alive (seq 1371).
 *
 * Rules, all load-bearing:
 *  - The task's persisted backend identity decides the path, and a task whose
 *    marker cannot be read throws instead of guessing (`taskTerminalBackendIdentity`).
 *  - A native task NEVER falls back to tmux. If its agent pane cannot be resolved
 *    or written to, the answer is false — the caller's honest "no live agent
 *    session" — not a tmux send that would type into nothing.
 *  - The tmux path is the pre-existing code, unchanged, called with the same
 *    arguments it was called with before.
 */

import type { ScheduledMessageTarget, Task } from "../shared/types";
import { sendPromptToAgentPane, sendPromptToPane } from "./agent-prompt";
import { sendPromptToNativeAgentPane, sendPromptToNativePane } from "./agent-prompt-native";
import { taskTerminalBackendIdentity } from "./task-terminal-backend";
import { DEFAULT_TMUX_SOCKET, taskSessionName } from "./tmux";

/**
 * Type `prompt` into `task`'s agent (or into one concrete pane) and submit it.
 * Returns false when nothing usable is live, so callers keep their existing
 * drop-with-notice / throw behavior.
 */
export async function deliverAgentPrompt(
	task: Task,
	prompt: string,
	target: ScheduledMessageTarget = { kind: "agent" },
): Promise<boolean> {
	if (taskTerminalBackendIdentity(task) === "native") {
		return target.kind === "pane"
			? sendPromptToNativePane(task, target.paneId, prompt)
			: sendPromptToNativeAgentPane(task, prompt);
	}
	const tmuxSession = taskSessionName(task.id);
	const socket = task.tmuxSocket ?? DEFAULT_TMUX_SOCKET;
	return target.kind === "pane"
		? sendPromptToPane(tmuxSession, socket, target.paneId, prompt)
		: sendPromptToAgentPane(tmuxSession, socket, prompt, task.sessionState?.panes);
}
