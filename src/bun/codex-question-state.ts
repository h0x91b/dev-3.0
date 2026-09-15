import type { AgentStatusHookEvent } from "../shared/agent-hooks";
import type { TaskStatus } from "../shared/types";

interface SessionQuestions {
	blocking: Set<string>;
	queued: Map<string, string[]>;
}

interface TaskQuestions {
	sessions: Map<string, SessionQuestions>;
	resumeStatus: "in-progress" | "review-by-ai";
}

/** Questions outlive ordinary tool calls; async questions also outlive Stop. */
export class CodexQuestionState {
	private tasks = new Map<string, TaskQuestions>();
	private queues = new Map<string, Promise<unknown>>();

	/** Keep the pending registry and asynchronous board moves in arrival order. */
	async run<T>(taskId: string, action: () => Promise<T>): Promise<T> {
		const previous = this.queues.get(taskId) ?? Promise.resolve();
		const next = previous.catch(() => {}).then(action);
		this.queues.set(taskId, next);
		try {
			return await next;
		} finally {
			if (this.queues.get(taskId) === next) this.queues.delete(taskId);
		}
	}

	apply(taskId: string, sessionId: string, event: AgentStatusHookEvent, status: TaskStatus, toolName?: string, toolUseId?: string, questionIds?: string[], answeredQuestionId?: string) {
		if (status === "completed" || status === "cancelled") {
			this.tasks.delete(taskId);
			return { pending: false };
		}
		const name = toolName?.replace(/^functions\./, "");
		const startsBlocking = event === "PreToolUse" && name === "request_user_input";
		const queuesQuestion = event === "PostToolUse" && name === "request_user_input_async";
		let task = this.tasks.get(taskId);
		if (!task && (startsBlocking || queuesQuestion)) {
			task = { sessions: new Map(), resumeStatus: status === "review-by-ai" ? status : "in-progress" };
			this.tasks.set(taskId, task);
		}
		if (!task) return { pending: false };
		let state = task.sessions.get(sessionId);
		if (!state && (startsBlocking || queuesQuestion)) {
			state = { blocking: new Set(), queued: new Map() };
			task.sessions.set(sessionId, state);
		}
		if (state) {
			if (startsBlocking) state.blocking.add(toolUseId ?? "unknown");
			if (queuesQuestion) state.queued.set(toolUseId ?? "unknown", questionIds?.length ? [...questionIds] : ["unknown"]);
			if (event === "PostToolUse" && name === "request_user_input") {
				state.blocking.delete(toolUseId ?? "unknown");
			}
			// Async answers arrive as a new prompt. Stop also cleans up a failed or
			// cancelled blocking call, for which Codex emits no PostToolUse.
			if (event === "UserPromptSubmit") {
				let matched = false;
				if (answeredQuestionId) {
					for (const [callId, ids] of state.queued) {
						const index = ids.indexOf(answeredQuestionId);
						if (index < 0) continue;
						ids.splice(index, 1);
						if (ids.length === 0) state.queued.delete(callId);
						matched = true;
						break;
					}
				}
				if (!matched) state.queued.clear();
				state.blocking.clear();
			}
			if (event === "Stop" || event === "Interrupt" || event === "SessionEnd") state.blocking.clear();
			if (event === "SessionEnd") state.queued.clear();
			if (state.queued.size === 0 && state.blocking.size === 0) task.sessions.delete(sessionId);
		}
		if (task.sessions.size > 0) return { pending: true };
		this.tasks.delete(taskId);
		return { pending: false, resumeStatus: task.resumeStatus };
	}
}
