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
 *  - The other harnesses feed the same rules through the status hook: Codex
 *    `PermissionRequest`, Copilot `ask_user`, omp `tool_approval_requested`, pi
 *    `ui_prompt_start`, agy's approval wait. A prompt with no call to wait for closes on
 *    the PostToolUse of its tool, on the harness's own end-of-prompt marker (omp, pi), or
 *    on any PostToolUse (agy, whose statusLine names no tool); and always on the session's
 *    UserPromptSubmit, Stop, Interrupt, SessionStart or SessionEnd.
 *  - Esc and "No" on a Claude prompt fire no hook. Such an entry stays open until the
 *    session's next event or the user's "send now" — held late, never typed into a menu.
 *  - In memory, like the hold. A restart forgets every open prompt.
 */

import type { AgentStatusHookEvent } from "../shared/agent-hooks";
import type { PromptSubmitHarness } from "../shared/agent-terminal-prompt";
import type { TaskStatus } from "../shared/types";

/** Every harness that reports prompt events through hooks. */
export type PromptHarness = PromptSubmitHarness;

/** What ends a prompt besides its session returning: see the module rules. */
type PromptEnd = "calls" | "tool" | "marker" | "any";

interface OpenPrompt {
	id: string;
	sessionId: string;
	toolName: string | null;
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
	endsOn: PromptEnd;
	openedAt: number;
}

interface TaskPrompts {
	open: Map<string, OpenPrompt>;
	/** Codex `request_user_input_async` cards: answered by a new prompt, never a gate. */
	queued: Map<string, Map<string, string[]>>;
	/** Set while the status-hook path has something pending: the lane to return to. */
	resumeStatus: "in-progress" | "review-by-ai" | null;
	/** Calls between PreToolUse and PostToolUse, per session and agent: id → tool. */
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

/** One status-hook event as the prompt gate reads it. */
export interface StatusHookGateInput {
	taskId: string;
	/** Session-less hooks pass a per-pane key: one pane's events never close another's prompt. */
	sessionId: string;
	event: AgentStatusHookEvent;
	harness: PromptHarness;
	paneId?: string | null;
	toolName?: string;
	toolUseId?: string;
	/** The harness says this PostToolUse ends its prompt, not a tool (omp, pi). */
	promptEnd?: boolean;
	/** agy's "still waiting" refresh: never a second prompt. */
	heartbeat?: boolean;
}

export interface ClaudeToolInput {
	taskId: string;
	sessionId: string;
	toolName: string;
	toolUseId?: string;
	paneId?: string | null;
	agentId?: string | null;
}

/** One tool-hook event of any harness, as the shared prompt rules read it. */
interface ToolCall {
	harness: PromptHarness;
	taskId: string;
	sessionId: string;
	toolName: string | null;
	toolUseId?: string;
	paneId?: string | null;
	agentId?: string | null;
}

/** Harnesses that mark the PostToolUse ending a prompt (`promptEnd`), so no other one closes it. */
const PROMPT_END_MARKER_HARNESSES: ReadonlySet<PromptHarness> = new Set(["omp", "pi"]);

/** Events after which the session's input box is back: no prompt of it can be up. */
const SESSION_RETURN_EVENTS: ReadonlySet<AgentStatusHookEvent> = new Set(["UserPromptSubmit", "Stop", "Interrupt", "SessionStart", "SessionEnd"]);

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

	/** The panes of this task showing a prompt; empty is the common case and costs no pane lookup. */
	promptPanes(taskId: string): Set<string> {
		const panes = new Set<string>();
		for (const prompt of this.tasks.get(taskId)?.open.values() ?? []) if (prompt.paneId) panes.add(prompt.paneId);
		return panes;
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
		if (!task || task.resumeStatus === null) {
			if (task) this.dropIfEmpty(taskId, task);
			return { pending: false };
		}

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
				endsOn: "tool",
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

	/**
	 * The prompt-gate half of a status hook (Codex, Copilot, omp, pi, agy). Separate from
	 * {@link applyStatusHook}, which owns the card's question status and its own keys.
	 */
	applyStatusHookGate(input: StatusHookGateInput): void {
		const toolName = input.toolName?.replace(/^functions\./, "") ?? null;
		const call: ToolCall = { harness: input.harness, taskId: input.taskId, sessionId: input.sessionId, toolName, toolUseId: input.toolUseId, paneId: input.paneId };
		if (input.event === "PreToolUse") this.callStarted(call);
		else if (input.event === "PermissionRequest") this.promptRequested(call, input.heartbeat === true);
		else if (input.event === "PostToolUse") this.callEnded(call, input.promptEnd === true);
		else if (SESSION_RETURN_EVENTS.has(input.event)) this.sessionReturned(input.taskId, input.sessionId, input.harness);
	}

	/** Claude's PreToolUse: the call is in flight, and an AskUserQuestion opens a picker. */
	claudePreToolUse(input: ClaudeToolInput): void {
		const call = { ...input, harness: "claude" as const };
		this.callStarted(call);
		if (input.toolUseId && input.toolName === CLAUDE_ASK_USER_TOOL) {
			const task = this.tasks.get(input.taskId) ?? this.createTask(input.taskId);
			this.openPrompt(task, call, input.toolUseId, new Set([input.toolUseId]));
		}
	}

	/** Claude's PermissionRequest: a permission menu, plan approval or question picker is up. */
	claudePermissionRequest(input: ClaudeToolInput): void {
		this.promptRequested({ ...input, harness: "claude" });
	}

	/** Claude's PostToolUse: that call finished, and every prompt waiting only on it is answered. */
	claudePostToolUse(input: ClaudeToolInput): void {
		this.callEnded({ ...input, harness: "claude" }, false);
	}

	/** UserPromptSubmit, Stop or SessionEnd of a Claude session: its input box is back. */
	claudeSessionReturned(taskId: string, sessionId: string): void {
		this.sessionReturned(taskId, sessionId, "claude");
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

	private callStarted(call: ToolCall): void {
		if (!call.toolUseId || !call.toolName) return;
		const task = this.tasks.get(call.taskId) ?? this.createTask(call.taskId);
		const key = agentKey(call.sessionId, call.agentId);
		const calls = task.inFlight.get(key) ?? new Map<string, string>();
		calls.set(call.toolUseId, call.toolName);
		task.inFlight.set(key, calls);
	}

	/**
	 * A prompt is up. It waits for the call that names itself, else for every in-flight
	 * call of its tool: dev3 cannot tell which of several parallel ones asked. A named
	 * call dev3 never saw start still counts, so its own end is what closes the prompt.
	 */
	private promptRequested(call: ToolCall, heartbeat = false): void {
		const task = this.tasks.get(call.taskId) ?? this.createTask(call.taskId);
		const agentId = call.agentId ?? null;
		if (heartbeat && [...task.open.values()].some((p) => !p.statusTracked && p.harness === call.harness && p.sessionId === call.sessionId && p.agentId === agentId)) return;
		const calls = task.inFlight.get(agentKey(call.sessionId, call.agentId));
		const candidates = call.toolUseId && calls?.has(call.toolUseId)
			? new Set([call.toolUseId])
			: new Set([...(calls ?? [])].filter(([, tool]) => call.toolName !== null && tool === call.toolName).map(([id]) => id));
		if (call.toolUseId) candidates.add(call.toolUseId);
		// The AskUserQuestion picker its PreToolUse already opened is this same prompt.
		for (const prompt of task.open.values()) {
			if (candidates.size > 0 && [...candidates].every((id) => prompt.waitingFor.has(id))) return;
		}
		const id = candidates.size === 1 ? [...candidates][0]! : `permission:${call.toolName ?? "prompt"}:${++this.permissionSeq}`;
		this.openPrompt(task, call, id, candidates);
	}

	private callEnded(call: ToolCall, promptEnd: boolean): void {
		const task = this.tasks.get(call.taskId);
		if (!task) return;
		const key = agentKey(call.sessionId, call.agentId);
		const calls = task.inFlight.get(key);
		if (call.toolUseId) calls?.delete(call.toolUseId);
		if (calls?.size === 0) task.inFlight.delete(key);
		const agentId = call.agentId ?? null;
		const ours = (p: OpenPrompt) => !p.statusTracked && p.harness === call.harness && p.sessionId === call.sessionId && p.agentId === agentId;
		// One end mark answers one approval: stacked ones each get their own.
		const marked = promptEnd ? [...task.open.values()].filter((p) => ours(p) && p.endsOn === "marker").sort((x, y) => x.openedAt - y.openedAt)[0] : undefined;
		const closed = new Set<string>();
		this.takeWhere(task, (p) => {
			if (!ours(p)) return false;
			switch (p.endsOn) {
				case "calls":
					if (call.toolUseId) p.waitingFor.delete(call.toolUseId);
					return p.waitingFor.size === 0;
				case "tool": return p.toolName === call.toolName;
				case "marker": return p === marked;
				case "any": return true;
			}
		}, closed);
		this.announce(call.taskId, closed);
		this.dropIfEmpty(call.taskId, task);
	}

	private sessionReturned(taskId: string, sessionId: string, harness: PromptHarness): void {
		const task = this.tasks.get(taskId);
		if (!task) return;
		const closed = new Set<string>();
		this.takeWhere(task, (p) => !p.statusTracked && p.harness === harness && p.sessionId === sessionId, closed);
		for (const key of [...task.inFlight.keys()]) if (key.startsWith(`${sessionId}\u0000`)) task.inFlight.delete(key);
		this.announce(taskId, closed);
		this.dropIfEmpty(taskId, task);
	}

	private createTask(taskId: string): TaskPrompts {
		const task: TaskPrompts = { open: new Map(), queued: new Map(), resumeStatus: null, inFlight: new Map() };
		this.tasks.set(taskId, task);
		return task;
	}

	private openPrompt(task: TaskPrompts, call: ToolCall, promptId: string, waitingFor: Set<string>): void {
		const key = entryKey(call.sessionId, promptId);
		if (task.open.has(key)) return;
		const endsOn: PromptEnd = waitingFor.size > 0 ? "calls"
			: call.toolName ? "tool"
			: PROMPT_END_MARKER_HARNESSES.has(call.harness) ? "marker"
			: "any";
		task.open.set(key, {
			id: promptId,
			sessionId: call.sessionId,
			toolName: call.toolName,
			harness: call.harness,
			paneId: call.paneId ?? null,
			agentId: call.agentId ?? null,
			statusTracked: false,
			waitingFor,
			endsOn,
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
