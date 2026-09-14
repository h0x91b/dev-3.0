import type { StatusHookEvent } from "../../shared/agent-hooks";
import type { PromptSubmitHarness } from "../../shared/agent-terminal-prompt";
import type { CliContext } from "../context";
import { sendRequest } from "../socket-client";

export interface StatusHookReport {
	harness: Exclude<PromptSubmitHarness, "claude">;
	event: StatusHookEvent;
	sessionId?: string;
	/** The submitted text, on `UserPromptSubmit` only. */
	prompt?: string;
	/** The harness's own per-submission identity — how a redelivered report is recognised. */
	submissionId?: string;
}

/**
 * Forward one lifecycle report to the app's atomic `task.agentHook` handler.
 *
 * Shared by every harness whose status arrives through a `dev3 hook <harness>`
 * process (Codex, omp). It never throws and never exits non-zero: board
 * synchronization must not block the agent when dev3 is offline or a status
 * update fails, so a failure is one stderr line and nothing more.
 */
export async function reportStatusHookEvent(
	report: StatusHookReport,
	socketPath: string | null,
	context: CliContext | null,
): Promise<void> {
	if (!socketPath || !context?.taskId) return;

	// The hook runs inside the agent's pane, so $TMUX_PANE identifies which pane
	// this session belongs to. Combined with the payload's session id (the
	// resumable one), it lets dev3 record each pane's session for targeted
	// recovery — essential when several sessions (e.g. multiple bug hunters)
	// share one worktree. Neither Codex nor omp takes a session id at launch, so
	// this post-hoc capture is the only way to resume the exact session per pane.
	const paneId = typeof process.env.TMUX_PANE === "string" && process.env.TMUX_PANE
		? process.env.TMUX_PANE
		: undefined;
	try {
		const response = await sendRequest(socketPath, "task.agentHook", {
			taskId: context.taskId,
			projectId: context.projectId,
			harness: report.harness,
			event: report.event,
			...(report.sessionId ? { sessionId: report.sessionId } : {}),
			...(paneId ? { paneId } : {}),
			// Carried on the status hook so a submitted prompt costs the pane no
			// second dev3 process; what happens to it is decided app-side.
			...(report.event === "UserPromptSubmit" && report.prompt ? { prompt: report.prompt } : {}),
			...(report.submissionId ? { submissionId: report.submissionId } : {}),
		}, { timeoutMs: 3_000, connectAttempts: 2, retryDelayMs: 50 });
		if (!response.ok) {
			process.stderr.write(`dev3 ${report.harness} hook: ${response.error || "status update failed"}\n`);
		}
	} catch (error) {
		process.stderr.write(
			`dev3 ${report.harness} hook: ${error instanceof Error ? error.message : String(error)}\n`,
		);
	}
}
