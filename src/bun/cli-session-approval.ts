import type { AgentLaunchRequest, Project, Task } from "../shared/types";
import { agentLaunchAutoApproveMs, buildTaskDialogSubject, DEFAULT_PRIORITY, getTaskTitle } from "../shared/types";
import { createAgentRequest, getAgentRequestState, setAgentLaunchDialog } from "./agent-requests";
import { getTask } from "./data";
import { loadSettings } from "./settings";
import { getPushMessage } from "./rpc-handlers/shared-pure";

/** What this request is about, beyond the task: the only field that differs per command. */
export type SessionApprovalSubject = Pick<AgentLaunchRequest, "resume"> | Pick<AgentLaunchRequest, "sessionAction">;

export interface SessionApprovalAnswer {
	approved: boolean;
	stale?: boolean;
}

/**
 * Ask the user about something an agent wants done to ANOTHER task's session,
 * and block until they answer.
 *
 * One `launch`-kind request per task, shared by `dev3 agent resume`,
 * `dev3 task hibernate` and `dev3 task wake --shell`: the queue, the
 * replay-on-reconnect, the auto-approve countdown and the hold-on-touch come
 * with it, and a resume can never be pending alongside a hibernate.
 *
 * Any agent pick a dialog reports back is ignored — none of these commands
 * offers an agent choice.
 */
export async function askSessionApproval(opts: {
	project: Project;
	task: Task;
	requester: Task;
	subject: SessionApprovalSubject;
	/** Raised when a request of this kind is already waiting for this task. */
	alreadyPending: string;
}): Promise<SessionApprovalAnswer> {
	const { project, task, requester } = opts;
	const push = getPushMessage();
	if (!push) throw new Error("No app window is connected — cannot ask the user for approval");
	const autoApproveAfterMs = agentLaunchAutoApproveMs(await loadSettings());
	// Checked in the same tick as the create: across an await a second request would
	// pass too, then JOIN the first one's decision — one approval acting twice.
	if (getAgentRequestState("launch", task.id).state === "pending") throw new Error(opts.alreadyPending);
	const { requestId, decision, autoApproveAt } = createAgentRequest("launch", task.id, project.id, { autoApproveAfterMs });
	const request: AgentLaunchRequest = {
		requestId, taskId: task.id, projectId: project.id, taskTitle: getTaskTitle(task), targetStatus: task.status,
		scratch: false, requesterSeq: requester.seq, requesterTitle: getTaskTitle(requester),
		subject: buildTaskDialogSubject(task, project), defaultPriority: task.priority ?? DEFAULT_PRIORITY,
		canAddVariants: false, autoApproveAt, ...opts.subject,
	};
	setAgentLaunchDialog(request);
	push("agentLaunchRequested", request);
	const answer = await decision;
	return { approved: answer.approved, ...(answer.stale ? { stale: true } : {}) };
}

/** The approved request must still be about the run the dialog showed. */
export async function sameRunAfterApproval(project: Project, task: Task, changed: string): Promise<Task> {
	const current = await getTask(project, task.id);
	if (current.worktreePath !== task.worktreePath || current.lifecycleStartedAt !== task.lifecycleStartedAt) {
		throw new Error(changed);
	}
	return current;
}

/**
 * One in-flight operation per task. An agent that re-asks after its own tool
 * timeout joins the whole operation, approval included, so one answer acts once;
 * a different request for the same task is refused rather than queued behind it.
 */
export function perTaskJoiner(conflict: string): <T>(taskId: string, signature: string, run: () => Promise<T>) => Promise<T> {
	const pending = new Map<string, { signature: string; result: Promise<unknown> }>();
	return <T>(taskId: string, signature: string, run: () => Promise<T>): Promise<T> => {
		const existing = pending.get(taskId);
		if (existing) {
			if (existing.signature !== signature) return Promise.reject(new Error(conflict));
			return existing.result as Promise<T>;
		}
		const result = run();
		pending.set(taskId, { signature, result });
		return result.finally(() => pending.delete(taskId));
	};
}
