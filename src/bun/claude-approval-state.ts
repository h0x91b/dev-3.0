import type { ClaudeHookOwner, ClaudeToolStatusEvent } from "../shared/claude-status-hook";
import type { TaskStatus } from "../shared/types";

interface ClaudeActivity {
	waiting: Set<string>;
	background: Set<string>;
	resumeStatus: "in-progress" | "review-by-ai";
	stoppedStatus?: TaskStatus;
}

/** Only the conversation or background agent that raised a wait may clear it. */
export class ClaudeApprovalState {
	private tasks = new Map<string, ClaudeActivity>();
	private queues = new Map<string, Promise<unknown>>();

	async run<T>(taskId: string, action: () => Promise<T>): Promise<T> {
		const previous = this.queues.get(taskId) ?? Promise.resolve();
		const next = previous.catch(() => {}).then(async () => {
			const activity = this.tasks.get(taskId);
			const snapshot = activity ? { ...activity, waiting: new Set(activity.waiting), background: new Set(activity.background) } : undefined;
			try { return await action(); }
			catch (error) {
				if (snapshot) this.tasks.set(taskId, snapshot);
				else this.tasks.delete(taskId);
				throw error;
			}
		});
		this.queues.set(taskId, next);
		try { return await next; }
		finally { if (this.queues.get(taskId) === next) this.queues.delete(taskId); }
	}

	apply(taskId: string, status: TaskStatus, event: ClaudeToolStatusEvent | "UserPromptSubmit", owner: ClaudeHookOwner): TaskStatus | null {
		if (status === "todo" || status === "completed" || status === "cancelled") {
			this.tasks.delete(taskId);
			return null;
		}
		const key = JSON.stringify([owner.sessionId ?? "unknown", owner.agentId ?? null]);
		const waiting = event === "PermissionRequest" || event === "Notification";
		const stopped = event === "SubagentStop" || event === "TeammateIdle";
		// An interrupted parent call leaves the agent idle: it ends a wait but resumes nothing.
		const failedParent = event === "PostToolUseFailure" && !owner.agentId;
		let activity = this.tasks.get(taskId);
		if (!activity && (waiting || owner.agentId)) {
			activity = { waiting: new Set(), background: new Set(), resumeStatus: status === "review-by-ai" ? status : "in-progress" };
			this.tasks.set(taskId, activity);
		}
		if (activity) {
			if (owner.agentId) {
				if (stopped) activity.background.delete(key);
				else activity.background.add(key);
				if (status === "review-by-user" && !stopped) activity.stoppedStatus = status;
			} else if (!failedParent) {
				activity.stoppedStatus = undefined;
			}
			if (waiting) {
				if (!activity.waiting.size) activity.resumeStatus = status === "review-by-ai" ? status : "in-progress";
				activity.waiting.add(key);
				return "user-questions";
			}
			const resumed = activity.waiting.delete(key);
			if (activity.waiting.size) return "user-questions";
			const stoppedStatus = activity.stoppedStatus;
			this.forgetEmpty(taskId, activity);
			if (failedParent) return null;
			if (stopped) {
				if (stoppedStatus) return activity.background.size ? "in-progress" : stoppedStatus;
				return resumed && status === "user-questions" ? activity.resumeStatus : null;
			}
			if (resumed && status === "user-questions") return activity.resumeStatus;
		}
		if (failedParent) return null;
		if (owner.agentId && status === "user-questions") return null;
		return status === "review-by-ai" ? null : "in-progress";
	}

	stopParent(taskId: string, status: TaskStatus, sessionId: string, stopTarget: TaskStatus): TaskStatus | null {
		if (status === "todo" || status === "completed" || status === "cancelled") {
			this.tasks.delete(taskId);
			return null;
		}
		const activity = this.tasks.get(taskId);
		if (!activity) return status === "in-progress" ? stopTarget : status === "review-by-ai" ? "review-by-user" : null;
		const wasReviewing = status === "review-by-ai" || (status === "user-questions" && activity.resumeStatus === "review-by-ai");
		activity.stoppedStatus = wasReviewing ? "review-by-user" : stopTarget;
		activity.waiting.delete(JSON.stringify([sessionId, null]));
		this.forgetEmpty(taskId, activity);
		if (activity.waiting.size) return "user-questions";
		return activity.background.size ? "in-progress" : activity.stoppedStatus;
	}

	endSession(taskId: string, sessionId: string): TaskStatus | null {
		const activity = this.tasks.get(taskId);
		if (!activity) return null;
		const waitingBefore = activity.waiting.size;
		for (const owners of [activity.waiting, activity.background]) {
			for (const key of owners) if (JSON.parse(key)[0] === sessionId) owners.delete(key);
		}
		this.forgetEmpty(taskId, activity);
		if (activity.waiting.size) return null;
		if (!activity.background.size && activity.stoppedStatus) return activity.stoppedStatus;
		return activity.waiting.size < waitingBefore ? activity.resumeStatus : null;
	}

	private forgetEmpty(taskId: string, activity: ClaudeActivity): void {
		if (!activity.waiting.size && !activity.background.size) this.tasks.delete(taskId);
	}
}

export const claudeApprovals = new ClaudeApprovalState();
