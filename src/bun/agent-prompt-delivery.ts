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
 *    or written to, the answer is the caller's honest "no live agent session" —
 *    not a tmux send that would type into nothing.
 *  - Three answers reach the caller, never two. `unconfirmed` is the native arm's
 *    everyday answer (its host cannot acknowledge input) and tmux's answer when a
 *    send stopped mid-program, so nothing may report it as either success or
 *    failure — see `src/shared/agent-prompt-delivery.ts`.
 */

import type { ScheduledMessageTarget, Task } from "../shared/types";
import { type AgentPromptDelivery, agentPromptDeliveryFromPaneInput } from "../shared/agent-prompt-delivery";
import { sendPromptToAgentPane, sendPromptToPane } from "./agent-prompt";
import { sendPromptToNativeAgentPane, sendPromptToNativePane } from "./agent-prompt-native";
import { taskTerminalBackendIdentity } from "./task-terminal-backend";

/**
 * Type `prompt` into `task`'s agent (or into one concrete pane) and submit it,
 * reporting which of the three answers the backend could actually give.
 */
export async function deliverAgentPrompt(
	task: Task,
	prompt: string,
	target: ScheduledMessageTarget = { kind: "agent" },
): Promise<AgentPromptDelivery> {
	if (taskTerminalBackendIdentity(task) === "native") {
		return target.kind === "pane"
			? sendPromptToNativePane(task, target.paneId, prompt)
			: sendPromptToNativeAgentPane(task, prompt);
	}
	const outcome =
		target.kind === "pane"
			? await sendPromptToPane(task, target.paneId, prompt)
			: await sendPromptToAgentPane(task, prompt, task.sessionState?.panes);
	return agentPromptDeliveryFromPaneInput(outcome);
}
