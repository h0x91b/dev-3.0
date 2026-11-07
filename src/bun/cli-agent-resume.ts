import type { Project, Task } from "../shared/types";
import { ACTIVE_STATUSES } from "../shared/types";
import type { CliResumeOutcome, ResumeDialogPane, ResumeUnavailableReason, ResumePaneReport } from "../shared/agent-resume";
import { askSessionApproval, type LaunchRequester, launchRequesterKey, perTaskJoiner, sameRunAfterApproval } from "./cli-session-approval";
import { ResumeUnavailableError, resumeTaskSession, sessionStateOrLostCodexPane, taskTerminalAlive } from "./rpc-handlers/tmux-pty";
import { taskTerminalBackendIdentity } from "./task-terminal-backend";
import { assertTaskWorkspacePresent } from "./task-workspace-guard";

interface ResumeOptions {
	project: Project;
	task: Task;
	/** The task's agent or external sender that asked; null for a person at a terminal, who is the one clicking. */
	requester: LaunchRequester | null;
	/** Let a pane with no saved id resume the harness's own latest conversation. */
	allowAgentLatest: boolean;
}

function unavailable(task: Task, reason: ResumeUnavailableReason, message: string, panes?: ResumePaneReport[]): CliResumeOutcome {
	return { outcome: "unavailable", taskId: task.id, seq: task.seq, reason, message, ...(panes ? { panes } : {}) };
}

/** Everything that refuses without asking anybody: a resume the user would approve only to watch fail. */
async function preflight(project: Project, task: Task): Promise<{ refused: CliResumeOutcome } | { panes: ResumeDialogPane[] }> {
	if (task.draft) return { refused: unavailable(task, "draft", "The task is a draft; it has never run, so there is no session to resume.") };
	if (!ACTIVE_STATUSES.includes(task.status)) {
		return { refused: unavailable(task, "not-active", `The task is ${task.status}; only an active task has a session to resume. Starting it is \`dev3 task move\`.`) };
	}
	if (!task.worktreePath) return { refused: unavailable(task, "no-worktree", "The task has no worktree, so there is nothing to resume.") };
	assertTaskWorkspacePresent(project, task.worktreePath, task);
	if (await taskTerminalAlive(task)) {
		return { refused: { outcome: "already-running", taskId: task.id, seq: task.seq, backend: taskTerminalBackendIdentity(task) } };
	}
	const saved = await sessionStateOrLostCodexPane(project, task);
	if (!saved?.panes.length) {
		return { refused: unavailable(task, "no-saved-session", "The task has no saved agent session. Start Fresh in the app or `dev3 task move` are the ways to begin a new one.") };
	}
	return { panes: saved.panes.map(({ agentId, configId, sessionId }) => ({ agentId, configId, sessionId })) };
}

/** A resume restores the saved harness, config and account, so the dialog offers no agent choice. */
function askUser(project: Project, task: Task, requester: LaunchRequester, panes: ResumeDialogPane[]) {
	return askSessionApproval({
		project, task, requester,
		subject: { resume: { panes } },
		alreadyPending: "Another launch approval is pending for this task — answer it before resuming.",
	});
}

async function performResume(opts: ResumeOptions): Promise<CliResumeOutcome> {
	const { project, task, requester } = opts;
	const checked = await preflight(project, task);
	if ("refused" in checked) return checked.refused;
	let current = task;
	if (requester) {
		const answer = await askUser(project, task, requester, checked.panes);
		if (!answer.approved) return { outcome: "declined", taskId: task.id, seq: task.seq, ...(answer.stale ? { stale: true } : {}) };
		current = await sameRunAfterApproval(project, task, "The target task's run changed while waiting — nothing was resumed.");
		// Somebody may have clicked Resume Session while the dialog was open.
		const again = await preflight(project, current);
		if ("refused" in again) return again.refused;
	}
	try {
		const outcome = await resumeTaskSession(current.id, { refuseLive: true, refuseFresh: true, requireSessionIds: !opts.allowAgentLatest });
		if (outcome.kind === "already-running") return { outcome: "already-running", taskId: current.id, seq: current.seq, backend: outcome.backend };
		return { outcome: "resumed", resume: outcome.result };
	} catch (err) {
		if (err instanceof ResumeUnavailableError) return unavailable(current, err.reason, err.message, err.panes);
		throw err;
	}
}

const joinOrRun = perTaskJoiner("Another resume request is pending for this task — wait for its answer first.");

/** Retries join the whole operation, approval included: one answer resumes once. */
export function resumeCliAgent(opts: ResumeOptions): Promise<CliResumeOutcome> {
	const signature = JSON.stringify({ requester: launchRequesterKey(opts.requester), allowAgentLatest: opts.allowAgentLatest });
	return joinOrRun(opts.task.id, signature, () => performResume(opts));
}
