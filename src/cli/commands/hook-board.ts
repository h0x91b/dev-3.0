/**
 * `dev3 hook board` — internal. Prints the `<dev3-board>` snapshot on stdout so
 * the harness folds it into the agent's context for this turn.
 *
 * Installed on `UserPromptSubmit` for every task, not only coordinators: the
 * server decides whether this task is one, so `dev3 task update --type
 * coordinator` starts working mid-session with no hook rewrite. A non-coordinator
 * gets an empty answer and this prints nothing.
 *
 * Silent and successful whatever happens. Claude Code treats a `UserPromptSubmit`
 * hook exiting non-zero as a BLOCKING error that erases the user's prompt, so a
 * missing snapshot must never be worse than no snapshot at all. Nothing is
 * written to stderr either — on this event Claude shows stderr to the user, and
 * a warning on every turn about an optional convenience is pure noise.
 */

import type { CliContext } from "../context";
import { sendRequest } from "../socket-client";

/** Well under Claude's own hook timeout: a late board is worth less than a fast turn. */
const BOARD_TIMEOUT_MS = 3_000;

export async function handleBoardHook(
	socketPath: string | null,
	context: CliContext | null,
): Promise<void> {
	if (!socketPath || !context?.taskId || !context.projectId) return;

	try {
		const response = await sendRequest(socketPath, "board.snapshot", {
			taskId: context.taskId,
			projectId: context.projectId,
		}, { timeoutMs: BOARD_TIMEOUT_MS, connectAttempts: 2, retryDelayMs: 50 });

		if (!response.ok) return;
		const text = (response.data as { text?: unknown } | undefined)?.text;
		if (typeof text === "string" && text.length > 0) process.stdout.write(`${text}\n`);
	} catch {
		// The app is closed, the socket is stale, or the board took too long.
		// All three mean the same thing here: no snapshot this turn.
	}
}
