import type { AgentLaunchRequest, Project, Task } from "../shared/types";
import { ACTIVE_STATUSES, agentLaunchAutoApproveMs, buildTaskDialogSubject, DEFAULT_PRIORITY, getTaskTitle } from "../shared/types";
import type { AgentSessionAction, CliHibernateOutcome, CliWakeOutcome, HibernateRefusalReason } from "../shared/task-hibernate";
import { createAgentRequest, getAgentRequestState, setAgentLaunchDialog } from "./agent-requests";
import { resumeCliAgent } from "./cli-agent-resume";
import { getTask } from "./data";
import { loadSettings } from "./settings";
import { getPushMessage } from "./rpc-handlers/shared-pure";
import { hibernateTask } from "./rpc-handlers/task-lifecycle";
import { taskTerminalAlive, wakeTaskShell } from "./rpc-handlers/tmux-pty";
import { taskTerminalBackendIdentity } from "./task-terminal-backend";

interface SessionActionOptions {
	project: Project;
	task: Task;
	/** The task whose agent asked; null for a person at a terminal, who acts directly. */
	requester: Task | null;
}

function refused(task: Task, reason: HibernateRefusalReason, message: string): CliHibernateOutcome {
	return { outcome: "nothing-to-free", taskId: task.id, seq: task.seq, reason, message };
}

/** Everything that refuses without asking anybody: a dialog the user approves only to watch nothing happen. */
async function hibernatePreflight(task: Task): Promise<CliHibernateOutcome | null> {
	if (task.hibernated) return refused(task, "already-hibernated", "The task is already hibernated.");
	if (task.draft) return refused(task, "draft", "The task is a draft; it has never run.");
	if (!ACTIVE_STATUSES.includes(task.status)) return refused(task, "not-active", `The task is ${task.status}; only an active task has a session to free.`);
	if (!task.worktreePath) return refused(task, "no-worktree", "The task has no worktree.");
	if (!await taskTerminalAlive(task)) return refused(task, "not-running", "The task has no live terminal, so there is nothing running to free.");
	return null;
}

/**
 * Same dialog, queue and auto-approve countdown as an agent asking to launch or
 * resume another task: one `launch` request per task, so a hibernate and a
 * resume can never both be pending on the same session.
 */
async function askUser(project: Project, task: Task, requester: Task, action: AgentSessionAction): Promise<{ approved: boolean; stale?: boolean }> {
	const push = getPushMessage();
	if (!push) throw new Error("No app window is connected — cannot ask the user for approval");
	if (getAgentRequestState("launch", task.id).state === "pending") throw new Error("Another approval is pending for this task — answer it first.");
	const { requestId, decision, autoApproveAt } = createAgentRequest("launch", task.id, project.id, { autoApproveAfterMs: agentLaunchAutoApproveMs(await loadSettings()) });
	const request: AgentLaunchRequest = {
		requestId, taskId: task.id, projectId: project.id, taskTitle: getTaskTitle(task), targetStatus: task.status,
		scratch: false, requesterSeq: requester.seq, requesterTitle: getTaskTitle(requester),
		subject: buildTaskDialogSubject(task, project), defaultPriority: task.priority ?? DEFAULT_PRIORITY,
		canAddVariants: false, autoApproveAt, sessionAction: action,
	};
	setAgentLaunchDialog(request);
	push("agentLaunchRequested", request);
	const answer = await decision;
	return { approved: answer.approved, ...(answer.stale ? { stale: true } : {}) };
}

/** The approved request must still be about the run the dialog showed. */
async function sameRunAfterApproval(project: Project, task: Task): Promise<Task> {
	const current = await getTask(project, task.id);
	if (current.worktreePath !== task.worktreePath || current.lifecycleStartedAt !== task.lifecycleStartedAt) {
		throw new Error("The target task's run changed while waiting — nothing was done.");
	}
	return current;
}

async function performHibernate({ project, task, requester }: SessionActionOptions): Promise<CliHibernateOutcome> {
	const early = await hibernatePreflight(task);
	if (early) return early;
	let current = task;
	if (requester) {
		const answer = await askUser(project, task, requester, { kind: "hibernate", paneCount: task.sessionState?.panes?.length ?? 1 });
		if (!answer.approved) return { outcome: "declined", taskId: task.id, seq: task.seq, ...(answer.stale ? { stale: true } : {}) };
		current = await sameRunAfterApproval(project, task);
		const again = await hibernatePreflight(current);
		if (again) return again;
	}
	const { task: updated, freedRssBytes } = await hibernateTask({ taskId: current.id, projectId: project.id });
	return { outcome: "hibernated", taskId: updated.id, seq: updated.seq, freedRssBytes };
}

async function performWakeShell({ project, task, requester }: SessionActionOptions): Promise<CliWakeOutcome> {
	if (!task.hibernated) return { outcome: "not-hibernated", taskId: task.id, seq: task.seq };
	let current = task;
	if (requester) {
		const answer = await askUser(project, task, requester, { kind: "wake-shell" });
		if (!answer.approved) return { outcome: "declined", taskId: task.id, seq: task.seq, ...(answer.stale ? { stale: true } : {}) };
		current = await sameRunAfterApproval(project, task);
		if (!current.hibernated) return { outcome: "not-hibernated", taskId: current.id, seq: current.seq };
	}
	await wakeTaskShell({ taskId: current.id });
	return { outcome: "woke-shell", taskId: current.id, seq: current.seq, backend: taskTerminalBackendIdentity(current) };
}

const pendingByTask = new Map<string, { signature: string; result: Promise<unknown> }>();

/** Retries join the whole operation, approval included: one answer acts once. */
function joinOrRun<T>(task: Task, signature: string, run: () => Promise<T>): Promise<T> {
	const existing = pendingByTask.get(task.id);
	if (existing) {
		if (existing.signature !== signature) throw new Error("Another session request is pending for this task — wait for its answer first.");
		return existing.result as Promise<T>;
	}
	const result = run();
	pendingByTask.set(task.id, { signature, result });
	return result.finally(() => pendingByTask.delete(task.id));
}

/** `dev3 task hibernate`: what the session bar's Hibernate button does, asked first when an agent requests it. */
export function hibernateCliTask(opts: SessionActionOptions): Promise<CliHibernateOutcome> {
	return joinOrRun(opts.task, `hibernate:${opts.requester?.id ?? ""}`, () => performHibernate(opts));
}

/** `dev3 task wake --shell|--resume`: the wake screen's two buttons. */
export async function wakeCliTask(opts: SessionActionOptions & { mode: "shell" | "resume"; allowAgentLatest: boolean }): Promise<CliWakeOutcome> {
	if (opts.mode === "shell") return joinOrRun(opts.task, `wake-shell:${opts.requester?.id ?? ""}`, () => performWakeShell(opts));
	if (!opts.task.hibernated) return { outcome: "not-hibernated", taskId: opts.task.id, seq: opts.task.seq };
	return { outcome: "resume", resume: await resumeCliAgent({ project: opts.project, task: opts.task, requester: opts.requester, allowAgentLatest: opts.allowAgentLatest }) };
}
