import type { Task } from "../../shared/types";
import {
	AGENT_MESSAGE_HOOK_MAX_CHARS,
	acknowledgeHookClaim,
	agentMessageHoldKey,
	claimHeldAgentMessagesForHook,
	pendingAgentMessageHoldCount,
} from "../agent-message-hold";
import { log, type Handler } from "./shared";
import { taskHandlers } from "./task-commands";
import { resolveTaskFromParams } from "./task-resolution";

/** Held messages an agent's tool hook injects; the hook acknowledges `claimId` once printed. */
export interface HookMailboxDrain {
	context?: string;
	messages?: number;
	/** Lines for the user: hook context does not show in the pane the way typed text did. */
	notice?: string;
	/** The hook acknowledges it once printed (`task.claudePostToolUseAck`); unacknowledged mail is held again. */
	claimId?: string;
}

/** What the Claude PostToolUse hook gets back: held messages to inject, and why the move failed if it did. */
export interface ClaudePostToolUseResult extends HookMailboxDrain {
	moveError?: string;
}

function movedTaskId(result: unknown): string | null {
	const task = result as Partial<Task> | null;
	return task && typeof task.id === "string" && typeof task.status === "string" ? task.id : null;
}

/** Hand the pane's held messages to its agent's tool hook. No `paneId` means not the pane's own agent: nothing to drain. */
async function drainHookMailbox(
	params: Record<string, unknown>,
	knownTaskId: string | null,
	budgetChars = AGENT_MESSAGE_HOOK_MAX_CHARS,
	ownsPane: (task: Task, paneId: string) => boolean = () => true,
): Promise<HookMailboxDrain> {
	const paneId = typeof params.paneId === "string" ? params.paneId : "";
	// Nothing held anywhere is the common case, and it costs no task lookup.
	if (!paneId || pendingAgentMessageHoldCount() === 0) return {};
	try {
		let taskId = knownTaskId;
		if (!taskId) {
			const { task } = await resolveTaskFromParams(params);
			if (!ownsPane(task, paneId)) return {};
			taskId = task.id;
		}
		const claim = await claimHeldAgentMessagesForHook(agentMessageHoldKey("tmux", taskId, paneId), budgetChars);
		if (!claim) return {};
		return {
			context: claim.text,
			messages: claim.messages,
			claimId: claim.claimId,
			...(claim.notices.length > 0 ? { notice: claim.notices.join("\n") } : {}),
		};
	} catch (err) {
		log.warn("hook mailbox drain failed", { taskId: String(params.taskId).slice(0, 8), paneId, error: String(err) });
		return {};
	}
}

/**
 * Cursor drops a hook's whole `additional_context` past 10,000 characters, joined
 * with every other hook's; this headroom keeps a drained, already-acknowledged
 * batch from vanishing. What does not fit stays held and is typed instead.
 */
const CURSOR_HOOK_MAX_CHARS = 6_000;

/**
 * Whether the hook's Cursor conversation is the one dev3 launched in this pane. A
 * nested `agent -p` or a subagent inherits the pane's env but not its conversation.
 */
function cursorConversationOwnsPane(conversationId: unknown) {
	return (task: Task, paneId: string) =>
		typeof conversationId === "string" && conversationId !== "" &&
		(task.sessionState?.panes ?? []).some((pane) => pane.paneId === paneId && pane.sessionId === conversationId);
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
			log.warn("Claude PostToolUse status move failed", { taskId: String(params.taskId).slice(0, 8), error: out.moveError });
		}
		return { ...out, ...(await drainHookMailbox(params, taskId)) };
	},
	/**
	 * Cursor's postToolUse: the hook mailbox alone. Cursor's board status stays manual,
	 * so no move rides on it; the drained text goes back as `additional_context`.
	 */
	"task.cursorPostToolUse": async (params) =>
		drainHookMailbox(params, null, CURSOR_HOOK_MAX_CHARS, cursorConversationOwnsPane(params.conversationId)),
	/** The hook printed the drained mail: only now is it delivered. */
	"task.claudePostToolUseAck": async (params) => {
		const claimId = typeof params.claimId === "string" ? params.claimId : "";
		return { acknowledged: claimId !== "" && acknowledgeHookClaim(claimId) };
	},
};
