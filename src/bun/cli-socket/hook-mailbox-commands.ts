import type { Task } from "../../shared/types";
import {
	AGENT_MESSAGE_HOOK_MAX_CHARS,
	agentMessageHoldKey,
	claimHeldAgentMessagesForHook,
	pendingAgentMessageHoldCount,
} from "../agent-message-hold";
import { log, type Handler } from "./shared";
import { taskHandlers } from "./task-commands";
import { resolveTaskFromParams } from "./task-resolution";

/** What the Claude PostToolUse hook gets back: held messages to inject, and why the move failed if it did. */
export interface ClaudePostToolUseResult {
	context?: string;
	messages?: number;
	/** Lines for the user: hook context does not show in the pane the way typed text did. */
	notice?: string;
	moveError?: string;
}

function movedTaskId(result: unknown): string | null {
	const task = result as Partial<Task> | null;
	return task && typeof task.id === "string" && typeof task.status === "string" ? task.id : null;
}

export const hookMailboxHandlers: Record<string, Handler> = {
	/**
	 * Claude's PostToolUse in one round trip: the same status move the hook always
	 * made, then the hook mailbox. A subagent or teammate sends no `paneId`, so it
	 * only moves the status: held mail is for the pane's own agent.
	 */
	"task.claudePostToolUse": async (params, ctx) => {
		const out: ClaudePostToolUseResult = {};
		let taskId: string | null = null;
		try {
			taskId = movedTaskId(await taskHandlers["task.move"]({
				taskId: params.taskId,
				...(params.projectId ? { projectId: params.projectId } : {}),
				newStatus: "in-progress",
				ifStatusNot: "review-by-ai",
				sourceTaskId: params.taskId,
			}, ctx));
		} catch (err) {
			out.moveError = err instanceof Error ? err.message : String(err);
		}
		const paneId = typeof params.paneId === "string" ? params.paneId : "";
		// Nothing held anywhere is the common case, and it costs no task lookup.
		if (!paneId || pendingAgentMessageHoldCount() === 0) return out;
		try {
			taskId ??= (await resolveTaskFromParams(params)).task.id;
			const claim = await claimHeldAgentMessagesForHook(agentMessageHoldKey("tmux", taskId, paneId), AGENT_MESSAGE_HOOK_MAX_CHARS);
			if (claim) {
				out.context = claim.text;
				out.messages = claim.messages;
				if (claim.notices.length > 0) out.notice = claim.notices.join("\n");
			}
		} catch (err) {
			log.warn("hook mailbox drain failed", { taskId: String(params.taskId).slice(0, 8), paneId, error: String(err) });
		}
		return out;
	},
};
