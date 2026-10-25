import type { CliContext } from "../context";
import { sendRequest } from "../socket-client";
import { claudeHookPaneId } from "./claude-prompt";

/** Normal Stop/exit must not become an interruption when the native state turns idle. */
export async function handleClaudeTurnEnded(
	raw: string,
	socketPath: string | null,
	context: CliContext | null,
	env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
	try {
		const paneId = claudeHookPaneId(env);
		if (!socketPath || !context?.taskId || !paneId) return;
		const payload = JSON.parse(raw);
		if (!["Stop", "SessionEnd"].includes(payload?.hook_event_name) || typeof payload.session_id !== "string") return;
		await sendRequest(socketPath, "task.claudeTurnEnded", {
			projectId: context.projectId, taskId: context.taskId,
			paneId, sessionId: payload.session_id,
		}, { timeoutMs: 3_000, connectAttempts: 2, retryDelayMs: 50 });
	} catch { /* Observation must never block Claude's Stop or exit. */ }
}
