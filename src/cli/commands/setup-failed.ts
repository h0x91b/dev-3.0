import { sendRequest } from "../socket-client";
import type { CliContext } from "../context";

/**
 * Internal: the setup wrapper calls this when a project's `setupScript` exits
 * non-zero. The wrapper has already written the exit code next to the task's
 * launch scripts; this only tells the app to read it, so the pane can offer to
 * start the agent anyway.
 *
 * It runs inside a dying launch, so it never fails loudly: no app, no socket, no
 * task context all resolve to a silent success. The user still has the setup log
 * in front of them either way.
 */
export async function handleSetupFailed(
	socketPath: string | null,
	context: CliContext | null,
): Promise<void> {
	const taskId = context?.taskId;
	if (!socketPath || !taskId) return;
	try {
		await sendRequest(socketPath, "task.setupFailed", { taskId });
	} catch {
		// Deliberately silent — see the doc comment.
	}
}
