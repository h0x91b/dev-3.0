import type { CliContext } from "../context";
import { sendRequest } from "../socket-client";

/** The Cursor conversation that ran the tool; the app drains only for the pane's own one. */
function payloadConversationId(rawInput: string): string | undefined {
	try {
		const id = (JSON.parse(rawInput) as Record<string, unknown>).conversation_id;
		return typeof id === "string" && id !== "" ? id : undefined;
	} catch {
		return undefined;
	}
}

/**
 * `dev3 hook cursor-post-tool`: Cursor's postToolUse hook. Cursor queues anything
 * typed mid-turn as a follow-up until the turn ends, so a busy agent takes its held
 * `dev3 message`s here instead, as `additional_context` after the tool result.
 * Prints nothing and exits 0 when there is no mail or the app is closed.
 */
export async function handleCursorPostTool(
	rawInput: string,
	socketPath: string | null,
	context: CliContext | null,
	env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
	const paneId = env.DEV3_PANE_ID?.trim() || env.TMUX_PANE?.trim();
	const conversationId = payloadConversationId(rawInput);
	if (!socketPath || !context?.taskId || !paneId || !conversationId) return;
	try {
		const response = await sendRequest(socketPath, "task.cursorPostToolUse", {
			taskId: context.taskId,
			...(context.projectId ? { projectId: context.projectId } : {}),
			paneId,
			conversationId,
		});
		const data = (response.ok ? response.data ?? {} : {}) as { context?: unknown; claimId?: unknown };
		if (typeof data.context !== "string" || !data.context) return;
		await new Promise<void>((resolve, reject) => {
			process.stdout.write(JSON.stringify({ additional_context: data.context }), (err) => (err ? reject(err) : resolve()));
		});
		// Unacknowledged mail is held again by the app: a hook that dies first costs a duplicate, never a loss.
		if (typeof data.claimId === "string") await sendRequest(socketPath, "task.claudePostToolUseAck", { claimId: data.claimId });
	} catch (error) {
		process.stderr.write(`dev3 Cursor tool hook: ${error instanceof Error ? error.message : String(error)}\n`);
	}
}
