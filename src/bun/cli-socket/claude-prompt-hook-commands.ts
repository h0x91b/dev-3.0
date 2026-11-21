import type { ClaudeToolInput } from "../agent-prompt-ledger";
import { agentPromptLedger } from "../agent-prompt-ledger";
import { log, type Handler } from "./shared";
import { taskHandlers } from "./task-commands";
import { resolveTaskFromParams } from "./task-resolution";

function text(value: unknown): string | null {
	return typeof value === "string" && value.trim() ? value.trim() : null;
}

/**
 * The ledger input a Claude tool hook sent, or null when it cannot name its session
 * and tool. The pane is optional: without one the prompt is tracked but gates nothing.
 */
export function claudeToolInput(taskId: string, params: Record<string, unknown>): ClaudeToolInput | null {
	const sessionId = text(params.sessionId);
	const toolName = text(params.toolName);
	if (!sessionId || !toolName) return null;
	return {
		taskId,
		sessionId,
		toolName,
		...(text(params.toolUseId) ? { toolUseId: text(params.toolUseId)! } : {}),
		paneId: text(params.paneId),
		agentId: text(params.agentId),
	};
}

/** The hook's status move; returns the error it failed with, if any. */
async function move(params: Record<string, unknown>, ctx: Parameters<Handler>[1], newStatus: string, ifStatusNot?: string): Promise<{ error?: string }> {
	try {
		await taskHandlers["task.move"]({
			taskId: params.taskId,
			...(params.projectId ? { projectId: params.projectId } : {}),
			newStatus,
			...(ifStatusNot ? { ifStatusNot } : {}),
			sourceTaskId: params.taskId,
		}, ctx);
		return {};
	} catch (err) {
		const error = err instanceof Error ? err.message : String(err);
		log.warn("Claude prompt hook status move failed", { taskId: String(params.taskId).slice(0, 8), newStatus, error });
		return { error };
	}
}

/**
 * Update the ledger BEFORE the status move, one hook at a time per task. A slow move must
 * never let a later hook (the PermissionRequest after this PreToolUse) reach the ledger
 * first: the CLI gives up after 3 s and Claude moves on, but this queue keeps the order.
 */
async function updateLedger(params: Record<string, unknown>, what: string, apply: (taskId: string) => void): Promise<void> {
	await agentPromptLedger.run(String(params.taskId), async () => {
		try {
			apply((await resolveTaskFromParams(params)).task.id);
		} catch (err) {
			log.warn(`Claude ${what} ledger update failed`, { taskId: String(params.taskId).slice(0, 8), error: String(err) });
		}
	});
}

export const claudePromptHookHandlers: Record<string, Handler> = {
	/**
	 * Claude's PreToolUse: the prompt ledger (an AskUserQuestion opens a picker; the call id
	 * waits for the PermissionRequest that may follow), then the working-status move.
	 */
	"task.claudePreToolUse": async (params, ctx) => {
		await updateLedger(params, "PreToolUse", (taskId) => {
			const input = claudeToolInput(taskId, params);
			if (input) agentPromptLedger.claudePreToolUse(input);
		});
		const moved = await move(params, ctx, "in-progress", "review-by-ai");
		return moved.error ? { moveError: moved.error } : {};
	},
	/**
	 * Claude's PermissionRequest: a permission menu, plan approval or question picker
	 * is on screen. Nothing may be typed into that pane until it is answered.
	 */
	"task.claudePermissionRequest": async (params, ctx) => {
		await updateLedger(params, "PermissionRequest", (taskId) => {
			const input = claudeToolInput(taskId, params);
			if (input) agentPromptLedger.claudePermissionRequest(input);
		});
		const moved = await move(params, ctx, "user-questions");
		return moved.error ? { moveError: moved.error } : {};
	},
};
