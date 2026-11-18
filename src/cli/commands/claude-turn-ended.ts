import type { CliContext } from "../context";
import { sendRequest } from "../socket-client";
import { claudeHookPaneId } from "./claude-prompt";

/** Apply Stop atomically with approval ownership and record normal turn/exit observation. */
export async function handleClaudeTurnEnded(
	raw: string,
	socketPath: string | null,
	context: CliContext | null,
	env: NodeJS.ProcessEnv = process.env,
	stopTarget?: string,
): Promise<void> {
	try {
		const paneId = claudeHookPaneId(env);
		if (!socketPath || !context?.taskId) return;
		const payload = JSON.parse(raw);
		if (!["Stop", "SessionEnd"].includes(payload?.hook_event_name) || typeof payload.session_id !== "string") return;
		if (!paneId && payload.hook_event_name !== "SessionEnd") return;
		await sendRequest(socketPath, "task.claudeTurnEnded", {
			projectId: context.projectId, taskId: context.taskId,
			...(paneId ? { paneId } : {}), sessionId: payload.session_id,
			...(payload.hook_event_name === "SessionEnd" ? { sessionEnded: true } : {}),
			...(stopTarget ? { stopTarget } : {}),
		}, { timeoutMs: 3_000, connectAttempts: 2, retryDelayMs: 50 });
	} catch { /* Observation must never block Claude's Stop or exit. */ }
}
