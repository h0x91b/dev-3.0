import {
	onPromptHeldAgentMessageCount,
	promptHeldAgentMessageCounts,
	sendHeldAgentMessagesNow as sendHeldNow,
} from "../agent-message-hold";
import { getPushMessage } from "./shared";

// Every change of a task's "messages waiting behind a prompt" count reaches the views.
onPromptHeldAgentMessageCount((taskId, count) => getPushMessage()?.("heldAgentMessages", { taskId, count }));

/** Counts for a view that just opened; afterwards `heldAgentMessages` pushes keep it current. */
async function getHeldAgentMessageCounts(): Promise<Record<string, number>> {
	return promptHeldAgentMessageCounts();
}

/**
 * The user sees no prompt in the agent's pane: deliver its waiting messages now.
 * Returns how many were released.
 */
async function sendHeldAgentMessagesNow(params: { taskId: string }): Promise<{ released: number }> {
	return { released: sendHeldNow(params.taskId) };
}

export const heldAgentMessageHandlers = {
	getHeldAgentMessageCounts,
	sendHeldAgentMessagesNow,
};
