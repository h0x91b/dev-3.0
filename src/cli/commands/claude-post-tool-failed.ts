import type { CliContext } from "../context";
import { sendRequest } from "../socket-client";
import { claudeToolHookFields } from "./claude-tool-fields";

/**
 * `dev3 hook claude-post-tool-failed`: Claude's PostToolUseFailure. The call is over, so
 * dev3 drops it from the prompt ledger; nothing else. No status move (an interrupted call
 * leaves the agent idle), no pane and no mail. Its own subcommand, so a CLI that predates
 * it exits non-zero, which Claude ignores, instead of reporting a plain PostToolUse.
 * Prints nothing and exits 0 every time.
 */
export async function handleClaudePostToolFailed(
	rawInput: string,
	socketPath: string | null,
	context: CliContext | null,
	env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
	if (!socketPath || !context?.taskId) return;
	const { paneId: _pane, ...fields } = claudeToolHookFields(rawInput, env);
	if (!fields.toolUseId || !fields.sessionId) return;
	try {
		const response = await sendRequest(socketPath, "task.claudePostToolUseFailure", {
			taskId: context.taskId,
			...(context.projectId ? { projectId: context.projectId } : {}),
			...fields,
		}, { timeoutMs: 3_000, connectAttempts: 2, retryDelayMs: 50 });
		if (!response.ok) process.stderr.write(`dev3 tool failure hook: ${response.error || "request failed"}\n`);
	} catch (error) {
		process.stderr.write(`dev3 tool failure hook: ${error instanceof Error ? error.message : String(error)}\n`);
	}
}
