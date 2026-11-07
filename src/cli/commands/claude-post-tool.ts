import type { CliContext } from "../context";
import { sendRequest } from "../socket-client";
import { claudeHookPaneId } from "./claude-prompt";

/**
 * What matters in Claude Code's `PostToolUse` payload. `agent_id` is present only
 * when the tool ran inside a subagent or an in-process teammate: that agent is not
 * the pane's own conversation, so it never takes the pane's held messages.
 */
function parsePayload(rawInput: string): { subagent: boolean } | null {
	try {
		const parsed = JSON.parse(rawInput) as Record<string, unknown>;
		if (parsed.hook_event_name !== "PostToolUse") return null;
		return { subagent: typeof parsed.agent_id === "string" && parsed.agent_id !== "" };
	} catch {
		return null;
	}
}

/**
 * The hook output that hands Claude the drained messages next to the tool result.
 * `systemMessage` is the user's view of them: `additionalContext` never shows in the pane.
 */
export function postToolUseContextOutput(context: string, notice?: string): string {
	return JSON.stringify({
		...(notice ? { systemMessage: notice } : {}),
		hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: context },
	});
}

function writeStdout(text: string): Promise<void> {
	return new Promise((resolve, reject) => {
		process.stdout.write(text, (err) => (err ? reject(err) : resolve()));
	});
}

/**
 * `dev3 hook claude-post-tool`: Claude's PostToolUse hook. One request does the
 * status move the hook always made and drains any `dev3 message` held for this
 * pane, so a busy agent reads its mail at its next tool call. Exits 0 every time:
 * a closed app or a failed move must not block the agent.
 */
export async function handleClaudePostTool(
	rawInput: string,
	socketPath: string | null,
	context: CliContext | null,
	env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
	if (!socketPath || !context?.taskId) return;
	const payload = parsePayload(rawInput);
	const paneId = payload && !payload.subagent ? claudeHookPaneId(env) : undefined;
	try {
		const response = await sendRequest(socketPath, "task.claudePostToolUse", {
			taskId: context.taskId,
			...(context.projectId ? { projectId: context.projectId } : {}),
			...(paneId ? { paneId } : {}),
		});
		if (!response.ok) {
			process.stderr.write(`dev3 Claude tool hook: ${response.error || "request failed"}\n`);
			return;
		}
		const data = (response.data ?? {}) as { context?: unknown; notice?: unknown; claimId?: unknown; moveError?: unknown };
		if (typeof data.moveError === "string") process.stderr.write(`dev3 Claude tool hook: ${data.moveError}\n`);
		if (typeof data.context !== "string" || !data.context) return;
		await writeStdout(postToolUseContextOutput(data.context, typeof data.notice === "string" ? data.notice : undefined));
		// Unacknowledged mail is held again by the app, so a hook that dies before this
		// line costs a duplicate, never a lost message.
		if (typeof data.claimId === "string") await sendRequest(socketPath, "task.claudePostToolUseAck", { claimId: data.claimId });
	} catch (error) {
		process.stderr.write(`dev3 Claude tool hook: ${error instanceof Error ? error.message : String(error)}\n`);
	}
}
