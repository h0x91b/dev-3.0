/**
 * Which agent panes are showing an interactive prompt right now — a tool-permission
 * menu, a plan approval, an AskUserQuestion picker, a blocking Codex question — learned
 * from the hooks the agents already fire (issue #2342).
 *
 * The one registry for every harness. The message hold asks it before typing anything
 * ({@link isPromptOpen}): a digit typed into a Claude menu picks a row without an Enter,
 * and the Enter after a message approves whatever is highlighted. Codex question status
 * (`resumeStatus`, async questions) is a consumer of the same entries, not a second store.
 *
 * Rules:
 *  - A prompt with no pane is tracked for status but gates nothing: dev3 cannot tell
 *    which pane would have to wait.
 *  - Claude's `PermissionRequest` carries no `tool_use_id` (verified on Claude Code
 *    2.1.330, `decisions/2026/11/21/hold-agent-messages-behind-open-prompts.md`). Its
 *    prompt waits for EVERY call of that tool still in flight for the same agent: with
 *    parallel calls dev3 cannot tell which one asked, and closing late is safe while
 *    closing early types into the menu. A later tool call never closes a prompt.
 *  - Esc and "No" on a Claude prompt fire no hook. Such an entry stays open until the
 *    session's next event or the user's "send now" — held late, never typed into a menu.
 *  - In memory, like the hold. A restart forgets every open prompt.
 */

import type { AgentStatusHookEvent } from "../shared/agent-hooks";
import type { PromptSubmitHarness } from "../shared/agent-terminal-prompt";
import type { TaskStatus } from "../shared/types";

/** Every harness that reports prompt events through hooks. */
export type PromptHarness = PromptSubmitHarness;

interface OpenPrompt {
	id: string;
	sessionId: string;
	toolName: string;
	harness: PromptHarness;
	paneId: string | null;
	/** Claude's `agent_id`: set when a subagent or teammate raised it. */
	agentId: string | null;
	/** Opened through the status-hook path; counts as a pending question for the card. */
	statusTracked: boolean;
	/**
	 * Claude calls whose PostToolUse closes this prompt, all of them. Empty for a prompt
	 * no PreToolUse announced: the next PostToolUse of its tool closes it.
	 */
	waitingFor: Set<string>;
	openedAt: number;
}

interface TaskPrompts {
	open: Map<string, OpenPrompt>;
	/** Codex `request_user_input_async` cards: answered by a new prompt, never a gate. */
	queued: Map<string, Map<string, string[]>>;
	/** Set while the status-hook path has something pending: the lane to return to. */
	resumeStatus: "in-progress" | "review-by-ai" | null;
	/** Claude calls between PreToolUse and PostToolUse, per session and agent: id → tool. */
	inFlight: Map<string, Map<string, string>>;
}

export interface StatusHookPromptInput {
	taskId: string;
	sessionId: string;
	event: AgentStatusHookEvent;
	status: TaskStatus;
	harness: PromptHarness;
	paneId?: string | null;
	toolName?: string;
	toolUseId?: string;
	questionIds?: string[];
	answeredQuestionId?: string;
}

export interface ClaudeToolInput {
	taskId: string;
	sessionId: string;
	toolName: string;
	toolUseId?: string;
	paneId?: string | null;
	agentId?: string | null;
}

/** Told once per pane whose LAST open prompt just closed. */
export type PromptClosedListener = (taskId: string, paneId: string) => void;

const CLAUDE_ASK_USER_TOOL = "AskUserQuestion";

function entryKey(sessionId: string, id: string): string {
	return `${sessionId}\u0000${id}`;
}

function agentKey(sessionId: string, agentId: string | null | undefined): string {
	return `${sessionId}\u0000${agentId ?? ""}`;
}

export class AgentPromptLedger {
	private tasks = new Map<string, TaskPrompts>();
	private queues = new Map<string, Promise<unknown>>();
	private listeners = new Set<PromptClosedListener>();
	private permissionSeq = 0;

	/** Keep the registry and the board moves that read it in arrival order, per task. */
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

	onPromptClosed(listener: PromptClosedListener): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	/** Whether this pane shows a prompt dev3 knows of: nothing may be typed into it. */
	isPromptOpen(taskId: string, paneId: string): boolean {
		const task = this.tasks.get(taskId);
		if (!task) return false;
		for (const prompt of task.open.values()) if (prompt.paneId === paneId) return true;
		return false;
	}

	/**
	 * The status-hook path (Codex, Copilot, omp, pi): keeps blocking Codex questions as
	 * open prompts and async ones as queued cards. `pending` keeps the card in Has
	 * Questions; `resumeStatus` comes back once, when the last pending item clears.
	 */
	applyStatusHook(input: StatusHookPromptInput): { pending: boolean; resumeStatus?: "in-progress" | "review-by-ai" } {
		const { taskId, sessionId, event, status } = input;
		if (status === "completed" || status === "cancelled") {
			this.forgetTask(taskId);
			return { pending: false };
		}
		const name = input.toolName?.replace(/^functions\./, "");
		const startsBlocking = event === "PreToolUse" && name === "request_user_input";
		const queuesQuestion = event === "PostToolUse" && name === "request_user_input_async";
		let task = this.tasks.get(taskId);
		if (startsBlocking || queuesQuestion) {
			task ??= this.createTask(taskId);
			task.resumeStatus ??= status === "review-by-ai" ? status : "in-progress";
		}
		if (!task || task.resumeStatus === null) return { pending: false };

		const callId = input.toolUseId ?? "unknown";
		const closed = new Set<string>();
		if (startsBlocking) {
			task.open.set(entryKey(sessionId, callId), {
				id: callId,
				sessionId,
				toolName: name ?? "request_user_input",
				harness: input.harness,
				paneId: input.paneId ?? null,
				agentId: null,
				statusTracked: true,
				waitingFor: new Set(),
				openedAt: Date.now(),
			});
		}
		if (queuesQuestion) {
			const queued = task.queued.get(sessionId) ?? new Map<string, string[]>();
			queued.set(callId, input.questionIds?.length ? [...input.questionIds] : ["unknown"]);
			task.queued.set(sessionId, queued);
		}
		if (event === "PostToolUse" && name === "request_user_input") {
			this.take(task, entryKey(sessionId, callId), closed);
		}
		// Async answers arrive as a new prompt. Stop also cleans up a failed or
		// cancelled blocking call, for which Codex emits no PostToolUse.
		if (event === "UserPromptSubmit") {
			this.answerQueued(task, sessionId, input.answeredQuestionId);
			this.takeWhere(task, (p) => p.sessionId === sessionId && p.statusTracked, closed);
		}
		if (event === "Stop" || event === "Interrupt" || event === "SessionEnd") {
			this.takeWhere(task, (p) => p.sessionId === sessionId && p.statusTracked, closed);
		}
		if (event === "SessionEnd") task.queued.delete(sessionId);
		this.announce(taskId, closed);

		if (this.statusPending(task)) return { pending: true };
		const resumeStatus = task.resumeStatus;
		task.resumeStatus = null;
		this.dropIfEmpty(taskId, task);
		return { pending: false, resumeStatus };
	}

	/** Claude's PreToolUse: the call is in flight, and an AskUserQuestion opens a picker. */
	claudePreToolUse(input: ClaudeToolInput): void {
		if (!input.toolUseId) return;
		const task = this.tasks.get(input.taskId) ?? this.createTask(input.taskId);
		const key = agentKey(input.sessionId, input.agentId);
		const calls = task.inFlight.get(key) ?? new Map<string, string>();
		calls.set(input.toolUseId, input.toolName);
		task.inFlight.set(key, calls);
		if (input.toolName === CLAUDE_ASK_USER_TOOL) this.openClaude(task, input, input.toolUseId, new Set([input.toolUseId]));
	}

	/** Claude's PermissionRequest: a permission menu, plan approval or question picker is up. */
	claudePermissionRequest(input: ClaudeToolInput): void {
		const task = this.tasks.get(input.taskId) ?? this.createTask(input.taskId);
		const calls = task.inFlight.get(agentKey(input.sessionId, input.agentId));
		const candidates = new Set([...(calls ?? [])].filter(([, tool]) => tool === input.toolName).map(([id]) => id));
		// The AskUserQuestion picker its PreToolUse already opened is this same prompt.
		for (const prompt of task.open.values()) {
			if (candidates.size > 0 && [...candidates].every((id) => prompt.waitingFor.has(id))) return;
		}
		const id = candidates.size === 1 ? [...candidates][0]! : `permission:${input.toolName}:${++this.permissionSeq}`;
		this.openClaude(task, input, id, candidates);
	}

	/** Claude's PostToolUse: that call finished, and every prompt waiting only on it is answered. */
	claudePostToolUse(input: ClaudeToolInput): void {
		const task = this.tasks.get(input.taskId);
		if (!task) return;
		const key = agentKey(input.sessionId, input.agentId);
		const calls = task.inFlight.get(key);
		if (input.toolUseId) calls?.delete(input.toolUseId);
		if (calls?.size === 0) task.inFlight.delete(key);
		const agentId = input.agentId ?? null;
		const closed = new Set<string>();
		this.takeWhere(task, (p) => {
			if (p.harness !== "claude" || p.sessionId !== input.sessionId || p.agentId !== agentId) return false;
			if (p.waitingFor.size === 0) return p.toolName === input.toolName;
			if (input.toolUseId) p.waitingFor.delete(input.toolUseId);
			return p.waitingFor.size === 0;
		}, closed);
		this.announce(input.taskId, closed);
		this.dropIfEmpty(input.taskId, task);
	}

	/** UserPromptSubmit, Stop or SessionEnd of a Claude session: its input box is back. */
	claudeSessionReturned(taskId: string, sessionId: string): void {
		const task = this.tasks.get(taskId);
		if (!task) return;
		const closed = new Set<string>();
		this.takeWhere(task, (p) => p.harness === "claude" && p.sessionId === sessionId, closed);
		for (const key of [...task.inFlight.keys()]) if (key.startsWith(`${sessionId}\u0000`)) task.inFlight.delete(key);
		this.announce(taskId, closed);
		this.dropIfEmpty(taskId, task);
	}

	/**
	 * The user says there is no prompt on screen ("send now"), or the pane is gone:
	 * forget every prompt of this pane. Returns how many were closed.
	 */
	closePane(taskId: string, paneId: string): number {
		const task = this.tasks.get(taskId);
		if (!task) return 0;
		const closed = new Set<string>();
		const count = this.takeWhere(task, (p) => p.paneId === paneId, closed);
		this.announce(taskId, closed);
		this.dropIfEmpty(taskId, task);
		return count;
	}

	/** Forget everything about a task (it finished, or tests). */
	forgetTask(taskId: string): void {
		const task = this.tasks.get(taskId);
		if (!task) return;
		const closed = new Set<string>();
		this.takeWhere(task, () => true, closed);
		this.tasks.delete(taskId);
		this.announce(taskId, closed);
	}

	/** Drop every open prompt without announcing anything (tests). Listeners are wiring and stay. */
	reset(): void {
		this.tasks.clear();
		this.queues.clear();
	}

	private createTask(taskId: string): TaskPrompts {
		const task: TaskPrompts = { open: new Map(), queued: new Map(), resumeStatus: null, inFlight: new Map() };
		this.tasks.set(taskId, task);
		return task;
	}

	private openClaude(task: TaskPrompts, input: ClaudeToolInput, promptId: string, waitingFor: Set<string>): void {
		const key = entryKey(input.sessionId, promptId);
		if (task.open.has(key)) return;
		task.open.set(key, {
			id: promptId,
			sessionId: input.sessionId,
			toolName: input.toolName,
			harness: "claude",
			paneId: input.paneId ?? null,
			agentId: input.agentId ?? null,
			statusTracked: false,
			waitingFor,
			openedAt: Date.now(),
		});
	}

	private take(task: TaskPrompts, key: string, closed: Set<string>): void {
		const prompt = task.open.get(key);
		if (!prompt) return;
		task.open.delete(key);
		if (prompt.paneId) closed.add(prompt.paneId);
	}

	private takeWhere(task: TaskPrompts, match: (p: OpenPrompt) => boolean, closed: Set<string>): number {
		let count = 0;
		for (const [key, prompt] of [...task.open]) {
			if (!match(prompt)) continue;
			this.take(task, key, closed);
			count += 1;
		}
		return count;
	}

	private answerQueued(task: TaskPrompts, sessionId: string, answeredQuestionId: string | undefined): void {
		const queued = task.queued.get(sessionId);
		if (!queued) return;
		let matched = false;
		if (answeredQuestionId) {
			for (const [callId, ids] of queued) {
				const index = ids.indexOf(answeredQuestionId);
				if (index < 0) continue;
				ids.splice(index, 1);
				if (ids.length === 0) queued.delete(callId);
				matched = true;
				break;
			}
		}
		if (!matched) queued.clear();
		if (queued.size === 0) task.queued.delete(sessionId);
	}

	private statusPending(task: TaskPrompts): boolean {
		if (task.queued.size > 0) return true;
		for (const prompt of task.open.values()) if (prompt.statusTracked) return true;
		return false;
	}

	private dropIfEmpty(taskId: string, task: TaskPrompts): void {
		if (task.open.size === 0 && task.queued.size === 0 && task.resumeStatus === null && task.inFlight.size === 0) {
			this.tasks.delete(taskId);
		}
	}

	/** Tell listeners about every pane in `closed` that has no prompt left. */
	private announce(taskId: string, closed: Set<string>): void {
		for (const paneId of closed) {
			if (this.isPromptOpen(taskId, paneId)) continue;
			for (const listener of this.listeners) {
				try {
					listener(taskId, paneId);
				} catch { /* A listener must never break the hook that closed the prompt. */ }
			}
		}
	}
}

/** The process-wide ledger every hook handler and the message hold share. */
export const agentPromptLedger = new AgentPromptLedger();
