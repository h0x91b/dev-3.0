import { AGENT_STATUS_HOOK_EVENTS, getAgentHookTargetStatus, type AgentStatusHookEvent } from "../../shared/agent-hooks";
import { CLAUDE_STOP_FAILURE_ERRORS, describeClaudeStopFailure, type ClaudeStopFailureError } from "../../shared/agent-stop-failure";
import { getPushMessage, moveTask, notifyFromCliDesktop, isNotificationSuppressed, pushCliAttention, setFocusMode } from "../rpc-handlers";
import { recordTerminalPromptSubmission } from "../agent-terminal-prompt-log";
import type { PromptSubmitHarness } from "../../shared/agent-terminal-prompt";
import { loadSettings } from "../settings";
import { CodexQuestionState } from "../codex-question-state";
import { capturePaneSession } from "./pane-sessions";
import { noteAgentExited, noteAgentSessionActive, noteAgentSessionStarted } from "../agent-session-receipts";
import { log, type Handler, withSenderVariant } from "./shared";
import { requirePaneTask, resolveRequesterTask, resolveTaskFromParams, senderRequester } from "./task-resolution";
import { claudeSessionWatches, type ClaudeIdleEvent } from "../claude-session-watch";
import { rememberTaskSession } from "../task-sessions";
import { claimFileForTask } from "../file-leases";

const codexQuestions = new CodexQuestionState();

async function claudeReturnedToInput(event: ClaudeIdleEvent): Promise<void> {
	await codexQuestions.run(event.taskId, async () => {
		const { project, task } = await resolveTaskFromParams({ projectId: event.projectId, taskId: event.taskId });
		if (!claudeSessionWatches.isCurrentIdle(event)) return;
		if (task.status !== "in-progress" && task.status !== "review-by-ai") return;
		if (task.hibernated || task.worktreePath !== event.cwd) return;
		const panes = task.sessionState?.panes ?? [];
		if (!claudeSessionWatches.allIdle(task.id, panes)) return;
		// Stop runs while Claude is still busy and already chose the review lane.
		// An idle edge left in a working lane instead needs the user's next input.
		await moveTask({ projectId: project.id, taskId: task.id, newStatus: "user-questions", ifStatus: task.status });
	});
}

// An approval temporarily moves a task to user-questions. Remember which
// active lane that Codex/omp session came from so PostToolUse can restore a
// review agent to review-by-ai instead of misclassifying it as the primary agent.
const APPROVAL_RESUME_TTL_MS = 24 * 60 * 60 * 1000;

const approvalResumeStatuses = new Map<
	string,
	{ status: "in-progress" | "review-by-ai"; expiresAt: number }
>();

function getApprovalResumeStatus(
	key: string | null,
): "in-progress" | "review-by-ai" | undefined {
	if (!key) return undefined;
	const entry = approvalResumeStatuses.get(key);
	if (!entry) return undefined;
	if (entry.expiresAt <= Date.now()) {
		approvalResumeStatuses.delete(key);
		return undefined;
	}
	return entry.status;
}

export const agentHandlers: Record<string, Handler> = {
	"task.claudeTurnEnded": (params) => codexQuestions.run(String(params.taskId), async () => {
		const { task } = await resolveTaskFromParams(params);
		if (typeof params.paneId === "string" && typeof params.sessionId === "string") {
			claudeSessionWatches.endTurn(task.id, params.paneId, params.sessionId);
			noteAgentSessionActive(task.id, params.sessionId, params.paneId);
		}
		return { ok: true };
	}),
	// Claude's SessionStart from a launched pane: the evidence the launch handoff
	// waits for. Moves no status — an opened session is not work.
	"agent.sessionStarted": async (params) => {
		const { task } = await resolveTaskFromParams(params);
		const sessionId = typeof params.sessionId === "string" ? params.sessionId.trim() : "";
		if (!sessionId) throw new Error("sessionId is required");
		const paneId = typeof params.paneId === "string" && params.paneId.trim() ? params.paneId.trim() : null;
		noteAgentSessionStarted(task.id, sessionId, paneId);
		return { ok: true };
	},
	// The launch wrapper saw its agent exit. Only an agent this app launched that
	// never reached SessionStart (declined trust, a crash at boot) moves the card:
	// no hook fires for it, so it would otherwise read "Agent is Working" forever.
	"agent.exited": (params) => codexQuestions.run(String(params.taskId), async () => {
		const { project, task } = await resolveTaskFromParams(params);
		const sessionId = typeof params.sessionId === "string" ? params.sessionId.trim() : "";
		if (!sessionId) throw new Error("sessionId is required");
		const exitCode = typeof params.exitCode === "number" ? params.exitCode : null;
		if (!noteAgentExited(task.id, sessionId, exitCode)) return { moved: false };
		log.info("Agent exited before its session started", { taskId: task.id.slice(0, 8), exitCode });
		if (task.status !== "in-progress" || task.hibernated) return { moved: false };
		await moveTask({ projectId: project.id, taskId: task.id, newStatus: "user-questions", ifStatus: "in-progress" });
		const code = exitCode === null ? "" : ` (exit code ${exitCode})`;
		pushCliAttention({
			taskId: task.id,
			projectId: task.projectId,
			reason: `The agent exited before it started${code}. Its terminal shows why.`,
		});
		return { moved: true };
	}),
	"agent.list": async () => (await import("../cli-agent-spawn")).listCliAgents(),
	"agent.spawn": async (params) => {
		if ("accountId" in params) throw new Error("Account selection is not supported by agent.spawn — the default account is used unless the user changes it in the approval dialog.");
		const { project, task } = await requirePaneTask(params);
		const requester = await resolveRequesterTask(params, "launch request");
		for (const key of ["agentId", "configId", "prompt"]) {
			if (params[key] !== undefined && params[key] !== null && typeof params[key] !== "string") throw new Error(`${key} must be a string.`);
		}
		if (typeof params.prompt === "string" && !params.prompt.trim()) throw new Error("prompt must not be empty.");
		if (params.configId && !params.agentId) throw new Error("configId requires agentId.");
		const { spawnCliAgent } = await import("../cli-agent-spawn");
		return spawnCliAgent({
			project, task, requester,
			choice: { agentId: (params.agentId as string | null) ?? null, configId: (params.configId as string | null) ?? null },
			prompt: typeof params.prompt === "string" ? params.prompt : undefined, handoff: params.handoff === true,
		});
	},
	...withSenderVariant("agent.resume", async (params) => {
		for (const key of ["agentId", "configId", "accountId", "prompt"]) {
			if (key in params) throw new Error(`agent.resume takes no ${key} — it restores the saved harness, config and account.`);
		}
		const { project, task } = await requirePaneTask(params);
		const requester = senderRequester(params) ?? await resolveRequesterTask(params, "resume request");
		const { resumeCliAgent } = await import("../cli-agent-resume");
		return resumeCliAgent({ project, task, requester, allowAgentLatest: params.allowAgentLatest === true });
	}),

	"task.agentHook": (params) => codexQuestions.run(String(params.taskId), async () => {
		const { project, task } = await resolveTaskFromParams(params);
		const event = params.event as AgentStatusHookEvent;
		if (!AGENT_STATUS_HOOK_EVENTS.includes(event)) {
			throw new Error(`Unsupported status hook event: ${String(params.event)}`);
		}
		// The CLI that reports is the managed copy under ~/.dev3.0/bin, which a
		// worktree build does not replace; one from before Copilot names no harness.
		const harness: PromptSubmitHarness = params.harness === "omp" || params.harness === "pi" || params.harness === "copilot"
			? params.harness
			: "codex";
		const sessionId = typeof params.sessionId === "string" ? params.sessionId : null;
		const resumeKey = sessionId ? `${task.id}:${sessionId}` : null;
		const rememberedResumeStatus = getApprovalResumeStatus(resumeKey);

		const questionState = codexQuestions.apply(
			task.id,
			sessionId ?? "unknown",
			event,
			task.status === "user-questions" ? rememberedResumeStatus ?? task.status : task.status,
			typeof params.toolName === "string" ? params.toolName : undefined,
			typeof params.toolUseId === "string" ? params.toolUseId : undefined,
			Array.isArray(params.questionIds) ? params.questionIds.filter((id): id is string => typeof id === "string") : undefined,
			typeof params.answeredQuestionId === "string" ? params.answeredQuestionId : undefined,
		);
		const currentStatus = questionState.resumeStatus && task.status === "user-questions"
			? questionState.resumeStatus : task.status;
		let target = getAgentHookTargetStatus(event, currentStatus, project.autoReviewEnabled === true, rememberedResumeStatus);
		if (questionState.pending) target = "user-questions";
		else if (questionState.resumeStatus && task.status === "user-questions" && event !== "Stop") {
			target = event === "Interrupt" || event === "SessionEnd" ? "review-by-user" : questionState.resumeStatus;
		}
		// A To Do card has no run to report on — not even a pending question.
		if (task.status === "todo") target = null;
		const resumeStatus = event === "PermissionRequest"
			&& (task.status === "in-progress" || task.status === "review-by-ai")
			? task.status
			: null;
		const clearResumeStatus = rememberedResumeStatus !== undefined
			&& task.status === "user-questions"
			&& target === rememberedResumeStatus;
		let updated = task;
		let moveAccepted = false;
		if (target !== null && (task.status !== target || task.customColumnId != null)) {
			updated = await moveTask({
				taskId: task.id,
				projectId: project.id,
				newStatus: target,
				ifStatus: event === "Stop" && task.status === "in-progress"
					? "in-progress,user-questions"
					: task.status,
			});
			moveAccepted = updated.status === target && updated.customColumnId == null;
		}
		if (resumeKey && resumeStatus && moveAccepted) {
			approvalResumeStatuses.set(resumeKey, {
				status: resumeStatus,
				expiresAt: Date.now() + APPROVAL_RESUME_TTL_MS,
			});
		} else if (resumeKey && clearResumeStatus && moveAccepted) {
			approvalResumeStatuses.delete(resumeKey);
		}

		// Record the session id for this pane (targeted per-pane recovery).
		// A Codex hook without a pane id (a native session with no pane suffix) is
		// still placed when the task has only one pane; other harnesses need the id.
		const paneId = typeof params.paneId === "string" ? params.paneId : null;
		if (sessionId && (paneId || harness === "codex")) {
			await capturePaneSession(project, task.id, paneId, sessionId, harness);
		}
		rememberTaskSession(project, task, sessionId);

		// The submitted text rides on the same payload, so recording costs the
		// pane no second dev3 process.
		if (event === "UserPromptSubmit" && typeof params.prompt === "string") {
			recordTerminalPromptSubmission({
				project,
				task: updated,
				harness,
				prompt: params.prompt,
				sessionId,
				submissionId: typeof params.turnId === "string" ? params.turnId : null,
			});
		}

		const hookTrace = {
			taskId: task.id,
			harness,
			sessionId,
			event,
			toolName: typeof params.toolName === "string" ? params.toolName : null,
			toolUseId: typeof params.toolUseId === "string" ? params.toolUseId : null,
			pendingQuestions: questionState.pending,
			previousStatus: task.status,
			targetStatus: target,
			actualStatus: updated.status,
			moveAccepted,
		};
		if (questionState.pending || questionState.resumeStatus || event === "SessionStart" || event === "Stop") {
			log.info("Codex lifecycle hook", hookTrace);
		} else {
			log.debug("Codex lifecycle hook", hookTrace);
		}

		return updated;
	}),

	/**
	 * A harness reported that a prompt was submitted in a task's pane. Whether
	 * that was the human is decided in `recordTerminalPromptSubmission`, which
	 * throws out everything dev3 itself typed before writing anything.
	 *
	 * Returns the verdict rather than a bare ok, so a suppressed submission is
	 * distinguishable from a recorded one in the hook's own logs and tests.
	 */
	"task.promptSubmitted": (params) => codexQuestions.run(String(params.taskId), async () => {
		const { project, task } = await resolveTaskFromParams(params);
		const harness: PromptSubmitHarness = params.harness === "codex" || params.harness === "copilot"
			? params.harness
			: "claude";
		const sessionId = typeof params.sessionId === "string" ? params.sessionId : null;
		rememberTaskSession(project, task, sessionId);

		// Claude starts a new conversation on `/clear` and switches on `/resume`;
		// the pane's resume pointer follows whichever one this prompt went to.
		if (harness === "claude" && sessionId) {
			noteAgentSessionActive(task.id, sessionId, typeof params.paneId === "string" && params.paneId ? params.paneId : null);
		}
		if (harness === "claude" && sessionId && typeof params.paneId === "string" && params.paneId) {
			await capturePaneSession(project, task.id, params.paneId, sessionId, harness);
			if (task.worktreePath && typeof params.sessionStateDirectory === "string") {
				claudeSessionWatches.observe({
					projectId: project.id, taskId: task.id, sessionId, paneId: params.paneId,
					directory: params.sessionStateDirectory, cwd: task.worktreePath,
				}, claudeReturnedToInput);
			}
		}
		if (harness === "claude") {
			const target = getAgentHookTargetStatus("UserPromptSubmit", task.status, project.autoReviewEnabled === true);
			if (target && (task.status !== target || task.customColumnId != null)) {
				await moveTask({ projectId: project.id, taskId: task.id, newStatus: target, ifStatus: task.status });
			}
		}
		const outcome = recordTerminalPromptSubmission({
			project,
			task,
			harness,
			prompt: typeof params.prompt === "string" ? params.prompt : "",
			sessionId,
			submissionId: typeof params.submissionId === "string" ? params.submissionId : null,
		});
		return { outcome };
	}),

	// Claude Code's PreToolUse hook on its edit tools, in a folder other tasks
	// share. Answers the live task that holds the file, or no conflict.
	"task.claimFile": async (params) => {
		const { project, task } = await resolveTaskFromParams(params);
		if (typeof params.path !== "string" || !params.path) return { conflict: null };
		return { conflict: await claimFileForTask(project, task, params.path) };
	},

	// Claude Code's StopFailure hook: an API error ended the turn, so the agent is
	// parked at its prompt with nothing to show for it. Park the task in front of
	// the user too — the board would otherwise keep claiming the agent is working.
	"task.claudeStopFailure": async (params) => {
		const { project, task } = await resolveTaskFromParams(params);
		const rawError = params.error;
		const error: ClaudeStopFailureError = CLAUDE_STOP_FAILURE_ERRORS.includes(rawError as ClaudeStopFailureError)
			? rawError as ClaudeStopFailureError
			: "unknown";
		const reason = describeClaudeStopFailure({
			error,
			...(typeof params.errorDetails === "string" ? { errorDetails: params.errorDetails } : {}),
			...(typeof params.lastAssistantMessage === "string" ? { lastAssistantMessage: params.lastAssistantMessage } : {}),
		});

		// A To Do task has no turn to park: the failing agent outlived its run.
		if (task.status === "completed" || task.status === "cancelled" || task.status === "todo") {
			return { task, moved: false, reason };
		}

		let updated = task;
		if (task.status !== "user-questions" || task.customColumnId != null) {
			updated = await moveTask({
				taskId: task.id,
				projectId: project.id,
				newStatus: "user-questions",
				ifStatus: task.status,
			});
		}

		if ((await loadSettings()).focusMode) setFocusMode(true);
		if (isNotificationSuppressed()) {
			pushCliAttention({ taskId: task.id, projectId: task.projectId, reason });
		} else {
			getPushMessage()?.("cliAttention", { taskId: task.id, reason });
		}
		// A dead turn is precisely the case where the user has walked away, so this
		// goes to the OS rather than an in-app toast nobody is looking at.
		notifyFromCliDesktop({ task: updated, body: reason, projectName: project.name });

		return { task: updated, moved: updated.status === "user-questions", reason };
	},
};
