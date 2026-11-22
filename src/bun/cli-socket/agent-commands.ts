import { getPrimaryStopTarget } from "../../shared/types";
import { AGENT_STATUS_HOOK_EVENTS, getAgentHookTargetStatus, type AgentStatusHookEvent } from "../../shared/agent-hooks";
import { CLAUDE_STOP_FAILURE_ERRORS, describeClaudeStopFailure, describeCodexTurnError, type ClaudeStopFailureError } from "../../shared/agent-stop-failure";
import type { Project, Task } from "../../shared/types";
import { getPushMessage, moveTask, notifyFromCliDesktop, isNotificationSuppressed, pushCliAttention, setFocusMode } from "../rpc-handlers";
import { recordTerminalPromptSubmission } from "../agent-terminal-prompt-log";
import type { PromptSubmitHarness } from "../../shared/agent-terminal-prompt";
import { loadSettings } from "../settings";
import { agentPromptLedger } from "../agent-prompt-ledger";
import { capturePaneSession, taskCodexHomes } from "./pane-sessions";
import { isInteractiveCodexConversation } from "../codex-resume-home";
import { agentSessionRecord, isLatestAgentLaunch, noteAgentExited, noteAgentSessionActive, noteAgentSessionStarted } from "../agent-session-receipts";
import { forgetApprovalResumeStatus, getApprovalResumeStatus, rememberResumeStatus } from "../approval-resume-status";
import { forgetAgyPane, addAgyPending, agyPendingSessionsOf, forgetReplacedAgyConversations, removeAgyPending } from "../agy-session-state";
import { forgetClaudeSessionDump } from "../rate-limit-monitor";
import { recordLaunchFailure } from "../agent-launch-failure";
import { log, type Handler, withSenderVariant } from "./shared";
import { requirePaneTask, resolveRequesterTask, resolveTaskFromParams, resumeAccountParam, senderRequester } from "./task-resolution";
import { claudeSessionWatches, type ClaudeIdleEvent } from "../claude-session-watch";
import { rememberTaskSession } from "../task-sessions";
import { claimFileForTask } from "../file-leases";
import { codexTurnWatches, type CodexTurnFailure } from "../codex-turn-watch";
import { approvalReasonFromParams } from "../../shared/approval-reason";
import { applyClaudeHookStatus, scheduleClaudeBackgroundExpiry } from "./claude-hook-status";
import { claudeApprovals } from "../claude-approval-state";
import { recordTaskActivity } from "../task-activity";

async function claudeReturnedToInput(event: ClaudeIdleEvent): Promise<void> {
	await agentPromptLedger.run(event.taskId, async () => {
		const { project, task } = await resolveTaskFromParams({ projectId: event.projectId, taskId: event.taskId });
		if (!claudeSessionWatches.isCurrentIdle(event)) return;
		if (task.status !== "in-progress" && task.status !== "review-by-ai") return;
		if (task.hibernated || task.worktreePath !== event.cwd) return;
		const panes = task.sessionState?.panes ?? [];
		if (!claudeSessionWatches.allIdle(task.id, panes)) return;
		// Stop runs while Claude is still busy and already chose the review lane.
		// An idle edge left in a working lane instead needs the user's next input.
		// The user just pressed Escape, so there is nothing new to call them about.
		await moveTask({ projectId: project.id, taskId: task.id, newStatus: "user-questions", ifStatus: task.status, skipQuestionsBadge: true });
	});
}

/** A turn that stopped on the user: badge it and tell the OS, since they have likely walked away. */
async function raiseTurnAttention(project: Project, task: Task, reason: string): Promise<void> {
	if ((await loadSettings()).focusMode) setFocusMode(true);
	if (isNotificationSuppressed()) {
		pushCliAttention({ taskId: task.id, projectId: task.projectId, reason });
	} else {
		getPushMessage()?.("cliAttention", { taskId: task.id, reason });
	}
	notifyFromCliDesktop({ task, body: reason, projectName: project.name });
}

async function parkFailedTurn(project: Project, task: Task, reason: string): Promise<Task> {
	let updated = task;
	if (task.status !== "user-questions" || task.customColumnId != null) {
		updated = await moveTask({ taskId: task.id, projectId: project.id, newStatus: "user-questions", ifStatus: task.status, skipQuestionsBadge: true });
	}
	await raiseTurnAttention(project, updated, reason);
	return updated;
}

async function codexTurnFailed(failure: CodexTurnFailure): Promise<void> {
	await agentPromptLedger.run(failure.taskId, async () => {
		const { project, task } = await resolveTaskFromParams({ projectId: failure.projectId, taskId: failure.taskId });
		if (task.status !== "in-progress" && task.status !== "review-by-ai") return;
		if (task.hibernated) return;
		// A subagent's or `codex exec`'s failed turn says nothing about the user's own conversation.
		if (!(await isInteractiveCodexConversation(failure.sessionId, await taskCodexHomes(project, task)))) return;
		log.info("Codex turn ended on an error", { taskId: task.id.slice(0, 8), sessionId: failure.sessionId });
		const updated = await parkFailedTurn(project, task, describeCodexTurnError(failure.message));
		if (updated.status === "user-questions") rememberResumeStatus(`${task.id}:${failure.sessionId}`, task.status);
	});
}

/** An agy conversation id is spliced into the resume command line, so only a plain token is taken. */
const AGY_CONVERSATION_ID = /^[A-Za-z0-9._-]+$/;

export const agentHandlers: Record<string, Handler> = {
	"task.claudeTurnEnded": (params) => agentPromptLedger.run(String(params.taskId), async () => {
		const { task } = await resolveTaskFromParams(params);
		if (typeof params.sessionId === "string") {
			const sessionId = params.sessionId;
			await claudeApprovals.run(task.id, async () => {
				const { task: current } = await resolveTaskFromParams(params);
				let target: Task["status"] | null = null;
				const stopTarget = params.stopTarget;
				if (params.sessionEnded === true) {
					const resumed = claudeApprovals.endSession(task.id, sessionId);
					// A nested SDK session can finish while the pane's own agent is still working.
					if (!params.paneId && current.status === "user-questions") target = resumed;
				} else if (params.paneId && (
					stopTarget === "review-by-user" || stopTarget === "review-by-ai" || stopTarget === "user-questions" || stopTarget === "in-progress"
				)) {
					target = claudeApprovals.stopParent(task.id, current.status, sessionId, stopTarget);
				}
				if (target && (target !== current.status || current.customColumnId != null)) {
					await moveTask({ projectId: task.projectId, taskId: task.id, newStatus: target, ifStatus: current.status });
				}
			}).finally(() => scheduleClaudeBackgroundExpiry(task.id, task.projectId));
		}
		if (typeof params.paneId === "string" && typeof params.sessionId === "string") {
			claudeSessionWatches.endTurn(task.id, params.paneId, params.sessionId);
			agentPromptLedger.claudeSessionReturned(task.id, params.sessionId);
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
	// The launch wrapper saw its agent exit. An agent that died — before Claude's
	// SessionStart, or with a non-zero code under any harness — fires no hook that
	// moves the card, so it would otherwise read "Agent is Working" forever.
	// `sessionId` is the launch id the wrapper was minted with.
	"agent.exited": (params) => agentPromptLedger.run(String(params.taskId), async () => {
		const { project, task } = await resolveTaskFromParams(params);
		const sessionId = typeof params.sessionId === "string" ? params.sessionId.trim() : "";
		if (!sessionId) throw new Error("sessionId is required");
		const exitCode = typeof params.exitCode === "number" ? params.exitCode : null;
		forgetClaudeSessionDump(task.id);
		// Judged before the exit is recorded: only the launch the task answers to may clear its pane's
		// agy state, so the late exit of a replaced or earlier agent cannot wipe the current one's.
		const answersForTask = isLatestAgentLaunch(task.id, sessionId);
		const exitedPane = typeof params.paneId === "string" && params.paneId.trim() ? params.paneId.trim() : null;
		if (answersForTask && exitedPane) {
			const conversationId = task.sessionState?.panes.find((pane) => pane.paneId === exitedPane)?.sessionId ?? null;
			forgetAgyPane(task.id, { paneId: exitedPane, conversationId });
		}
		// The agent is gone, and so is any menu it showed: nothing is left to answer.
		const promptPane = exitedPane ?? agentSessionRecord(task.id, sessionId)?.paneId ?? null;
		if (promptPane) agentPromptLedger.closePane(task.id, promptPane);
		const verdict = noteAgentExited(task.id, sessionId, exitCode);
		if (!verdict) return { moved: false };
		log.info("Launched agent exited", { taskId: task.id.slice(0, 8), verdict, exitCode });
		// Before the card moves: the pane still shows what the agent printed.
		const stillCurrent = await recordLaunchFailure(project, task, { exitCode, sessionId, neverStarted: verdict === "early" }, (payload) => getPushMessage()?.("taskUpdated", payload));
		// A launch that started during the capture replaced this agent: its exit says nothing about the new one.
		if (!stillCurrent) return { moved: false };
		if (task.status !== "in-progress" || task.hibernated) return { moved: false };
		await moveTask({ projectId: project.id, taskId: task.id, newStatus: "user-questions", ifStatus: "in-progress", skipQuestionsBadge: true });
		const code = exitCode === null ? "" : ` (exit code ${exitCode})`;
		pushCliAttention({
			taskId: task.id,
			projectId: task.projectId,
			reason: verdict === "early"
				? `The agent exited before it started${code}. Its terminal shows why.`
				: `The agent exited${code}. Its terminal shows why.`,
		});
		return { moved: true };
	}),
	"agent.list": async () => (await import("../cli-agent-spawn")).listCliAgents(),
	"agent.awsProfiles.list": async (params) => {
		if (params.agentId !== undefined && typeof params.agentId !== "string") throw new Error("agentId must be a string.");
		return (await import("../agent-aws-profiles")).listAgentAwsProfiles(params.agentId as string | undefined);
	},
	"agent.awsProfiles.set": async (params) => {
		if (typeof params.agentId !== "string" || !params.agentId) throw new Error("agentId is required.");
		const result = await (await import("../agent-aws-profiles")).setAgentAwsProfiles(params.agentId, params.profiles, params.defaultProfile);
		getPushMessage()?.("agentsUpdated", await (await import("../agents")).getAllAgents());
		// Any agent can call this, and it moves every later launch to another AWS account: say so on screen.
		(await import("../rpc-handlers/shared")).pushCliToast({
			taskId: null,
			projectId: null,
			level: "info",
			message: "The dev3 CLI changed an agent's AWS profiles, which decide the AWS account its launches use. Check them in Settings → Agents.",
			messageKey: "kanban.awsProfilesChangedFromCli",
		});
		return result;
	},
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
			...approvalReasonFromParams(params),
		});
	},
	...withSenderVariant("agent.resume", async (params) => {
		for (const key of ["agentId", "configId", "prompt"]) {
			if (key in params) throw new Error(`agent.resume takes no ${key} — it restores the saved harness and config.`);
		}
		const accountId = resumeAccountParam(params);
		const { project, task } = await requirePaneTask(params);
		const requester = senderRequester(params) ?? await resolveRequesterTask(params, "resume request");
		const { resumeCliAgent } = await import("../cli-agent-resume");
		return resumeCliAgent({ project, task, requester, allowAgentLatest: params.allowAgentLatest === true, ...(accountId !== undefined ? { accountId } : {}), ...approvalReasonFromParams(params) });
	}),

	"task.agentHook": (params) => agentPromptLedger.run(String(params.taskId), async () => {
		const { project, task } = await resolveTaskFromParams(params);
		const event = params.event as AgentStatusHookEvent;
		if (!AGENT_STATUS_HOOK_EVENTS.includes(event)) {
			throw new Error(`Unsupported status hook event: ${String(params.event)}`);
		}
		// The CLI that reports is the managed copy under ~/.dev3.0/bin, which a
		// worktree build does not replace; one from before Copilot names no harness.
		const harness: PromptSubmitHarness = params.harness === "omp" || params.harness === "pi" || params.harness === "copilot" || params.harness === "agy"
			? params.harness
			: "codex";
		let sessionId = typeof params.sessionId === "string" ? params.sessionId : null;
		if (harness === "agy" && sessionId && !AGY_CONVERSATION_ID.test(sessionId)) sessionId = null;
		// A wait that goes on: refresh its liveness, move nothing. One the app no longer holds (expired
		// meanwhile) is a wait coming back, and takes the ordinary PermissionRequest path below.
		if (params.heartbeat === true) {
			if (harness !== "agy") return task;
			const heartbeatPane = typeof params.paneId === "string" ? params.paneId : null;
			const heartbeatKey = sessionId ?? heartbeatPane ?? "unknown";
			if (agyPendingSessionsOf(task.id).has(heartbeatKey)) {
				addAgyPending(task.id, heartbeatKey, Date.now(), heartbeatPane);
				return task;
			}
		}
		// A conversation starting in a pane ends whatever an earlier agent in that pane was waiting on.
		if (harness === "agy" && event === "SessionStart" && sessionId && typeof params.paneId === "string" && params.paneId) {
			forgetReplacedAgyConversations(task.id, params.paneId, sessionId);
		}
		// A report that only names the session: record it on the pane, move nothing.
		if (params.captureOnly === true) {
			if (!sessionId) return task;
			const paneId = typeof params.paneId === "string" ? params.paneId : null;
			await capturePaneSession(project, task.id, paneId, sessionId, harness);
			rememberTaskSession(project, task, sessionId);
			return task;
		}
		recordTaskActivity(task.id);
		// The prompt gate first: agy's PostToolUse branch below may return before the card logic.
		const hookPane = typeof params.paneId === "string" && params.paneId ? params.paneId : null;
		agentPromptLedger.applyStatusHookGate({
			taskId: task.id,
			// With no session id, one pane's events must not close another pane's prompt.
			sessionId: sessionId ?? (hookPane ? `pane:${hookPane}` : "unknown"),
			event,
			harness,
			paneId: hookPane,
			toolName: typeof params.toolName === "string" ? params.toolName : undefined,
			toolUseId: typeof params.toolUseId === "string" ? params.toolUseId : undefined,
			promptEnd: params.promptEnd === true,
			heartbeat: params.heartbeat === true,
		});
		const resumeKey = sessionId ? `${task.id}:${sessionId}` : null;
		const agyWaitKey = sessionId ?? (typeof params.paneId === "string" ? params.paneId : "unknown");
		if (harness === "agy" && event === "PermissionRequest" && resumeKey && task.status === "user-questions"
			&& !getApprovalResumeStatus(resumeKey)) {
			// A second pane's wait joins one already parked: its end hands the card back the same way.
			for (const other of agyPendingSessionsOf(task.id)) {
				const inherited = getApprovalResumeStatus(`${task.id}:${other}`);
				if (inherited) { rememberResumeStatus(resumeKey, inherited); break; }
			}
		}
		let rememberedResumeStatus = getApprovalResumeStatus(resumeKey);
		let agyHold = false;
		if (harness === "agy") {
			if (event === "PermissionRequest") addAgyPending(task.id, agyWaitKey, Date.now(), typeof params.paneId === "string" ? params.paneId : null);
			if (event === "Stop" || event === "SessionEnd" || event === "Interrupt" || event === "SessionStart") {
				removeAgyPending(task.id, agyWaitKey);
				if (resumeKey) forgetApprovalResumeStatus(resumeKey);
			}
			// A started session has no tool waiting: a resumed, idle agy leaves a parked card where it is.
			if (event === "SessionStart") rememberedResumeStatus = undefined;
			// This session's own turn moves on, but another pane's wait still parks the card.
			if (event === "UserPromptSubmit" && removeAgyPending(task.id, agyWaitKey) > 0 && task.status === "user-questions") {
				agyHold = true;
				if (resumeKey) forgetApprovalResumeStatus(resumeKey);
			}
			// The statusLine says a tool wait ended, and can say it late (after Esc or a reject, or once the
			// agent finished): the wait is dropped first, then only a card parked by that very wait goes
			// back, and only when no other pane of the task still waits.
			if (event === "PostToolUse") {
				const stillWaiting = removeAgyPending(task.id, agyWaitKey);
				if (task.status !== "user-questions" || !rememberedResumeStatus) return task;
				if (stillWaiting > 0) {
					if (resumeKey) forgetApprovalResumeStatus(resumeKey);
					return task;
				}
			}
		}

		const questionState = agentPromptLedger.applyStatusHook({
			taskId: task.id,
			sessionId: sessionId ?? "unknown",
			event,
			status: task.status === "user-questions" ? rememberedResumeStatus ?? task.status : task.status,
			harness,
			paneId: hookPane,
			toolName: typeof params.toolName === "string" ? params.toolName : undefined,
			toolUseId: typeof params.toolUseId === "string" ? params.toolUseId : undefined,
			questionIds: Array.isArray(params.questionIds) ? params.questionIds.filter((id): id is string => typeof id === "string") : undefined,
			answeredQuestionId: typeof params.answeredQuestionId === "string" ? params.answeredQuestionId : undefined,
		});
		const currentStatus = questionState.resumeStatus && task.status === "user-questions"
			? questionState.resumeStatus : task.status;
		let target = getAgentHookTargetStatus(event, currentStatus, getPrimaryStopTarget(project.autoReviewEnabled, task.taskType), rememberedResumeStatus);
		// Only a Stop that would have moved the card may park it; a finished task stays finished.
		const approvalHold = event === "Stop" && harness === "codex" && typeof params.approvalHold === "string"
			&& (target !== null || task.status === "user-questions") ? params.approvalHold : null;
		if (questionState.pending || approvalHold) target = "user-questions";
		else if (questionState.resumeStatus && task.status === "user-questions" && event !== "Stop") {
			target = event === "Interrupt" || event === "SessionEnd" ? "review-by-user" : questionState.resumeStatus;
		}
		// A To Do card has no run to report on — not even a pending question.
		if (task.status === "todo" || agyHold) target = null;
		const resumeStatus = (event === "PermissionRequest" || approvalHold)
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
				skipQuestionsBadge: Boolean(approvalHold),
			});
			moveAccepted = updated.status === target && updated.customColumnId == null;
		}
		if (resumeKey && resumeStatus && moveAccepted) {
			rememberResumeStatus(resumeKey, resumeStatus);
		} else if (resumeKey && clearResumeStatus && moveAccepted) {
			forgetApprovalResumeStatus(resumeKey);
		}

		if (approvalHold && updated.status === "user-questions") {
			await raiseTurnAttention(project, updated, `Security hold — reply "${approvalHold}" in the terminal`);
		}

		if (harness === "codex" && sessionId) {
			// Codex names the rollout after its session, so a path that is not that session's file is ignored.
			if ((event === "SessionStart" || event === "UserPromptSubmit") && typeof params.transcriptPath === "string"
				&& params.transcriptPath.endsWith(`${sessionId}.jsonl`)) {
				codexTurnWatches.observe({ projectId: project.id, taskId: task.id, sessionId, transcriptPath: params.transcriptPath }, codexTurnFailed);
			} else if (event === "Stop" || event === "SessionEnd" || event === "Interrupt") {
				codexTurnWatches.endTurn(task.id, sessionId);
			}
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
	"task.promptSubmitted": (params) => agentPromptLedger.run(String(params.taskId), async () => {
		const { project, task } = await resolveTaskFromParams(params);
		recordTaskActivity(task.id);
		const harness: PromptSubmitHarness = params.harness === "codex" || params.harness === "copilot"
			? params.harness
			: "claude";
		const sessionId = typeof params.sessionId === "string" ? params.sessionId : null;
		rememberTaskSession(project, task, sessionId);

		// Claude starts a new conversation on `/clear` and switches on `/resume`;
		// the pane's resume pointer follows whichever one this prompt went to.
		if (harness === "claude" && sessionId) {
			agentPromptLedger.claudeSessionReturned(task.id, sessionId);
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
			await applyClaudeHookStatus({ ...params, event: "UserPromptSubmit" });
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

		const updated = await parkFailedTurn(project, task, reason);
		return { task: updated, moved: updated.status === "user-questions", reason };
	},
};
