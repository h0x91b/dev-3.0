import type { CliContext } from "../context";
import { sendRequest } from "../socket-client";
import { claudeToolHookFields } from "./claude-tool-fields";

/**
 * `dev3 hook claude-permission`: Claude's PermissionRequest — a permission menu, plan
 * approval or AskUserQuestion picker is on screen. Moves the card to Has Questions, as
 * the plain move did, and tells dev3 which pane must get nothing typed into it until
 * the prompt is answered. Prints nothing (no decision: Claude asks the user as usual)
 * and exits 0 every time, so a closed app never blocks the prompt.
 */
export async function handleClaudePermission(
	rawInput: string,
	socketPath: string | null,
	context: CliContext | null,
	env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
	if (!socketPath || !context?.taskId) return;
	try {
		const response = await sendRequest(socketPath, "task.claudePermissionRequest", {
			taskId: context.taskId,
			...(context.projectId ? { projectId: context.projectId } : {}),
			...claudeToolHookFields(rawInput, env),
		}, { timeoutMs: 3_000, connectAttempts: 2, retryDelayMs: 50 });
		const moveError = (response.data as { moveError?: unknown } | undefined)?.moveError;
		if (!response.ok) process.stderr.write(`dev3 permission hook: ${response.error || "request failed"}\n`);
		else if (typeof moveError === "string") process.stderr.write(`dev3 permission hook: ${moveError}\n`);
	} catch (error) {
		process.stderr.write(`dev3 permission hook: ${error instanceof Error ? error.message : String(error)}\n`);
	}
}
