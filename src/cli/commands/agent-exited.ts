import type { ParsedArgs } from "../args";
import type { CliContext } from "../context";
import { sendRequest } from "../socket-client";

/**
 * Internal: the launch wrapper's report that the agent it ran has exited —
 * `dev3 hook agent-exited --task <id> --session <id> <exit code>`. Silent and
 * successful on every path: it runs in the pane right before the shell hand-over.
 */
export async function handleAgentExitedHook(
	args: ParsedArgs,
	socketPath: string | null,
	context: CliContext | null,
): Promise<void> {
	try {
		const taskId = args.flags.task || context?.taskId;
		const sessionId = args.flags.session;
		const exitCode = Number.parseInt(args.positional[0] ?? "", 10);
		if (!socketPath || !taskId || !sessionId || taskId === "true" || sessionId === "true") return;
		await sendRequest(socketPath, "agent.exited", {
			taskId,
			...(context?.projectId ? { projectId: context.projectId } : {}),
			sessionId,
			exitCode: Number.isFinite(exitCode) ? exitCode : null,
		}, { timeoutMs: 3_000, connectAttempts: 2, retryDelayMs: 50 });
	} catch {
		// The pane still drops to its shell; the card just keeps its old status.
	}
}
