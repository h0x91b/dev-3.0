import type { AgentLaunchRequest, Project, Task } from "../shared/types";
import { ACTIVE_STATUSES, agentLaunchAutoApproveMs, buildTaskDialogSubject, DEFAULT_PRIORITY, getTaskTitle } from "../shared/types";
import type { CliResumeOutcome, ResumeDialogPane, ResumeUnavailableReason, ResumePaneReport } from "../shared/agent-resume";
import { createAgentRequest, getAgentRequestState, setAgentLaunchDialog } from "./agent-requests";
import { getTask } from "./data";
import { loadSettings } from "./settings";
import { getPushMessage } from "./rpc-handlers/shared-pure";
import { ResumeUnavailableError, resumeTaskSession, sessionStateOrLostCodexPane, taskTerminalAlive } from "./rpc-handlers/tmux-pty";
import { taskTerminalBackendIdentity } from "./task-terminal-backend";
import { assertTaskWorkspacePresent } from "./task-workspace-guard";

interface ResumeOptions {
	project: Project;
	task: Task;
	/** The task whose agent asked; null for a person at a terminal, who is the one clicking. */
	requester: Task | null;
	/** Let a pane with no saved id resume the harness's own latest conversation. */
	allowAgentLatest: boolean;
}

const pendingResumes = new Map<string, { signature: string; result: Promise<CliResumeOutcome> }>();

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
	assertTaskWorkspacePresent(project, task.worktreePath);
	if (await taskTerminalAlive(task)) {
		return { refused: { outcome: "already-running", taskId: task.id, seq: task.seq, backend: taskTerminalBackendIdentity(task) } };
	}
	const saved = await sessionStateOrLostCodexPane(project, task);
	if (!saved?.panes.length) {
		return { refused: unavailable(task, "no-saved-session", "The task has no saved agent session. Start Fresh in the app or `dev3 task move` are the ways to begin a new one.") };
	}
	return { panes: saved.panes.map(({ agentId, configId, sessionId }) => ({ agentId, configId, sessionId })) };
}

async function askUser(project: Project, task: Task, requester: Task, panes: ResumeDialogPane[]): Promise<{ approved: boolean; stale?: boolean }> {
	const push = getPushMessage();
	if (!push) throw new Error("No app window is connected — cannot ask the user for approval");
	if (getAgentRequestState("launch", task.id).state === "pending") throw new Error("Another launch approval is pending for this task — answer it before resuming.");
	const { requestId, decision, autoApproveAt } = createAgentRequest("launch", task.id, project.id, { autoApproveAfterMs: agentLaunchAutoApproveMs(await loadSettings()) });
	const request: AgentLaunchRequest = {
		requestId, taskId: task.id, projectId: project.id, taskTitle: getTaskTitle(task), targetStatus: task.status,
		scratch: false, requesterSeq: requester.seq, requesterTitle: getTaskTitle(requester),
		subject: buildTaskDialogSubject(task, project), defaultPriority: task.priority ?? DEFAULT_PRIORITY,
		canAddVariants: false, autoApproveAt, resume: { panes },
	};
	setAgentLaunchDialog(request);
	push("agentLaunchRequested", request);
	// Any agent pick a dialog reports back is ignored: a resume restores the saved harness, config and account.
	const answer = await decision;
	return { approved: answer.approved, ...(answer.stale ? { stale: true } : {}) };
}

async function performResume(opts: ResumeOptions): Promise<CliResumeOutcome> {
	const { project, task, requester } = opts;
	const checked = await preflight(project, task);
	if ("refused" in checked) return checked.refused;
	let current = task;
	if (requester) {
		const answer = await askUser(project, task, requester, checked.panes);
		if (!answer.approved) return { outcome: "declined", taskId: task.id, seq: task.seq, ...(answer.stale ? { stale: true } : {}) };
		current = await getTask(project, task.id);
		if (current.worktreePath !== task.worktreePath || current.lifecycleStartedAt !== task.lifecycleStartedAt) {
			throw new Error("The target task's run changed while waiting — nothing was resumed.");
		}
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

/** Retries join the whole operation, approval included: one answer resumes once. */
export async function resumeCliAgent(opts: ResumeOptions): Promise<CliResumeOutcome> {
	const signature = JSON.stringify({ requester: opts.requester?.id ?? null, allowAgentLatest: opts.allowAgentLatest });
	const existing = pendingResumes.get(opts.task.id);
	if (existing) {
		if (existing.signature !== signature) throw new Error("Another resume request is pending for this task — wait for its answer first.");
		return existing.result;
	}
	const result = performResume(opts);
	pendingResumes.set(opts.task.id, { signature, result });
	try { return await result; } finally { pendingResumes.delete(opts.task.id); }
}
