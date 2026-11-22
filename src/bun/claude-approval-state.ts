import type { ClaudeHookOwner, ClaudeToolStatusEvent } from "../shared/claude-status-hook";
import type { TaskStatus } from "../shared/types";

/**
 * How long a background agent may stay silent after its parent stopped before it counts
 * as gone. Its stop event can be lost (an interrupt, a Claude that omits `agent_id`), and
 * nothing else would ever let the card leave Agent is Working.
 */
export const CLAUDE_BACKGROUND_STALE_MS = 5 * 60_000;

interface ClaudeActivity {
	waiting: Set<string>;
	/** Background owner → when it was last heard from. */
	background: Map<string, number>;
	resumeStatus: "in-progress" | "review-by-ai";
	stoppedStatus?: TaskStatus;
}

function inactive(status: TaskStatus): boolean {
	return status === "todo" || status === "completed" || status === "cancelled";
}

/** Only the conversation or background agent that raised a wait may clear it. */
export class ClaudeApprovalState {
	private tasks = new Map<string, ClaudeActivity>();
	private queues = new Map<string, Promise<unknown>>();
	private expiryTimers = new Map<string, ReturnType<typeof setTimeout>>();

	async run<T>(taskId: string, action: () => Promise<T>): Promise<T> {
		const previous = this.queues.get(taskId) ?? Promise.resolve();
		const next = previous.catch(() => {}).then(async () => {
			const activity = this.tasks.get(taskId);
			const snapshot = activity ? { ...activity, waiting: new Set(activity.waiting), background: new Map(activity.background) } : undefined;
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

	apply(
		taskId: string,
		status: TaskStatus,
		event: ClaudeToolStatusEvent | "UserPromptSubmit",
		owner: ClaudeHookOwner,
		now = Date.now(),
	): TaskStatus | null {
		if (inactive(status)) {
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
			activity = { waiting: new Set(), background: new Map(), resumeStatus: status === "review-by-ai" ? status : "in-progress" };
			this.tasks.set(taskId, activity);
		}
		if (activity) {
			if (owner.agentId) {
				if (stopped) activity.background.delete(key);
				else activity.background.set(key, now);
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
		if (inactive(status)) {
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
		for (const key of [...activity.waiting]) if (JSON.parse(key)[0] === sessionId) activity.waiting.delete(key);
		for (const key of [...activity.background.keys()]) if (JSON.parse(key)[0] === sessionId) activity.background.delete(key);
		this.forgetEmpty(taskId, activity);
		if (activity.waiting.size) return null;
		if (!activity.background.size && activity.stoppedStatus) return activity.stoppedStatus;
		return activity.waiting.size < waitingBefore ? activity.resumeStatus : null;
	}

	/**
	 * When the card of a stopped parent is held in Agent is Working only by background
	 * agents, the moment the quietest of them goes stale. Null when nothing can expire.
	 */
	nextExpiry(taskId: string): number | null {
		const activity = this.tasks.get(taskId);
		if (!activity?.stoppedStatus || activity.waiting.size || !activity.background.size) return null;
		return Math.min(...activity.background.values()) + CLAUDE_BACKGROUND_STALE_MS;
	}

	/** Forget background agents silent past the stale window; the stopped lane once none is left. */
	expireStale(taskId: string, status: TaskStatus, now = Date.now()): TaskStatus | null {
		const activity = this.tasks.get(taskId);
		if (!activity?.stoppedStatus || activity.waiting.size) return null;
		for (const [key, seen] of [...activity.background]) {
			if (now - seen >= CLAUDE_BACKGROUND_STALE_MS) activity.background.delete(key);
		}
		if (activity.background.size) return null;
		const stoppedStatus = activity.stoppedStatus;
		this.tasks.delete(taskId);
		return status === "in-progress" ? stoppedStatus : null;
	}

	/** Replace the task's one expiry timer; `fire` runs once after `delayMs`. */
	armExpiry(taskId: string, delayMs: number, fire: () => void): void {
		this.cancelExpiry(taskId);
		const timer = setTimeout(() => {
			this.expiryTimers.delete(taskId);
			fire();
		}, delayMs);
		(timer as { unref?: () => void }).unref?.();
		this.expiryTimers.set(taskId, timer);
	}

	cancelExpiry(taskId: string): void {
		const timer = this.expiryTimers.get(taskId);
		if (timer) clearTimeout(timer);
		this.expiryTimers.delete(taskId);
	}

	/** Everything the task's agents left behind: owners, waits and the pending expiry. */
	forgetTask(taskId: string): void {
		this.tasks.delete(taskId);
		this.cancelExpiry(taskId);
	}

	private forgetEmpty(taskId: string, activity: ClaudeActivity): void {
		if (!activity.waiting.size && !activity.background.size) this.tasks.delete(taskId);
	}
}

export const claudeApprovals = new ClaudeApprovalState();
