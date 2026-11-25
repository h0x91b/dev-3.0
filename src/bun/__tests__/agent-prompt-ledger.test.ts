import { describe, expect, it } from "vitest";
import type { AgentStatusHookEvent } from "../../shared/agent-hooks";
import type { TaskStatus } from "../../shared/types";
import { AgentPromptLedger } from "../agent-prompt-ledger";

/** The status-hook path in the positional shape the Codex cases were written in. */
class CodexQuestions extends AgentPromptLedger {
	apply(taskId: string, sessionId: string, event: AgentStatusHookEvent, status: TaskStatus, toolName?: string, toolUseId?: string, questionIds?: string[], answeredQuestionId?: string) {
		return this.applyStatusHook({ taskId, sessionId, event, status, harness: "codex", toolName, toolUseId, questionIds, answeredQuestionId });
	}
}

describe("AgentPromptLedger — Codex question status", () => {
	it("serializes overlapping hooks and recovers after a failed move", async () => {
		const state = new CodexQuestions();
		let release!: () => void;
		const gate = new Promise<void>(resolve => { release = resolve; });
		const order: string[] = [];
		const first = state.run("task", async () => { await gate; order.push("question"); });
		const second = state.run("task", async () => { order.push("stop"); });
		await state.run("other", async () => { order.push("other"); });
		expect(order).toEqual(["other"]);
		release();
		await Promise.all([first, second]);
		expect(order).toEqual(["other", "question", "stop"]);
		const failed = state.run("task", async () => { throw new Error("offline"); });
		const retry = state.run("task", async () => "retried");
		await expect(failed).rejects.toThrow("offline");
		await expect(retry).resolves.toBe("retried");
	});

	it("waits for every blocking call and isolates sessions", () => {
		const state = new CodexQuestions();
		state.apply("task", "one", "PreToolUse", "review-by-ai", "request_user_input", "a");
		state.apply("task", "one", "PreToolUse", "user-questions", "request_user_input", "b");
		expect(state.apply("other-task", "two", "PostToolUse", "in-progress", "Bash").pending).toBe(false);
		expect(state.apply("task", "one", "PostToolUse", "user-questions", "request_user_input", "a").pending).toBe(true);
		expect(state.apply("task", "one", "PostToolUse", "user-questions", "request_user_input", "b"))
			.toEqual({ pending: false, resumeStatus: "review-by-ai" });
	});

	it("keeps one pane from clearing another pane's pending questions", () => {
		const state = new CodexQuestions();
		state.apply("task", "one", "PostToolUse", "in-progress", "request_user_input_async");
		expect(state.apply("task", "two", "UserPromptSubmit", "user-questions").pending).toBe(true);
		expect(state.apply("task", "two", "Stop", "user-questions").pending).toBe(true);
		expect(state.apply("task", "one", "UserPromptSubmit", "user-questions"))
			.toEqual({ pending: false, resumeStatus: "in-progress" });
	});

	it("keeps unanswered cards after a partial answer and deduplicates hook delivery", () => {
		const state = new CodexQuestions();
		for (let delivery = 0; delivery < 2; delivery++) {
			state.apply("task", "one", "PostToolUse", "in-progress", "request_user_input_async", "batch", ["first", "second"]);
		}
		expect(state.apply("task", "one", "UserPromptSubmit", "user-questions", undefined, undefined, undefined, "first").pending).toBe(true);
		expect(state.apply("task", "one", "Stop", "user-questions").pending).toBe(true);
		expect(state.apply("task", "one", "UserPromptSubmit", "user-questions", undefined, undefined, undefined, "second"))
			.toEqual({ pending: false, resumeStatus: "in-progress" });
	});

	it("does not mistake starting an async tool for a successfully queued question", () => {
		const state = new CodexQuestions();
		expect(state.apply("task", "one", "PreToolUse", "in-progress", "request_user_input_async").pending).toBe(false);
		expect(state.apply("task", "one", "Stop", "in-progress").pending).toBe(false);
	});

	it("cleans up failed blocking tools at Stop without dropping async questions", () => {
		const state = new CodexQuestions();
		state.apply("task", "one", "PreToolUse", "in-progress", "request_user_input", "a");
		expect(state.apply("task", "one", "Stop", "user-questions"))
			.toEqual({ pending: false, resumeStatus: "in-progress" });
		state.apply("task", "one", "PostToolUse", "in-progress", "functions.request_user_input_async");
		state.apply("task", "one", "PreToolUse", "user-questions", "request_user_input", "b");
		expect(state.apply("task", "one", "Stop", "user-questions").pending).toBe(true);
		expect(state.apply("task", "one", "SessionStart", "user-questions").pending).toBe(true);
		expect(state.apply("task", "one", "UserPromptSubmit", "user-questions"))
			.toEqual({ pending: false, resumeStatus: "in-progress" });
	});

	it("drops interrupted blocking calls and clears async waits when their session exits", () => {
		const state = new CodexQuestions();
		state.apply("task", "one", "PreToolUse", "in-progress", "request_user_input");
		expect(state.apply("task", "one", "Interrupt", "user-questions").pending).toBe(false);
		state.apply("task", "one", "PostToolUse", "in-progress", "request_user_input_async");
		expect(state.apply("task", "one", "Interrupt", "user-questions").pending).toBe(true);
		expect(state.apply("task", "one", "SessionEnd", "user-questions").pending).toBe(false);
	});

	it("forgets questions for completed and cancelled tasks", () => {
		for (const status of ["completed", "cancelled"] as const) {
			const state = new CodexQuestions();
			state.apply("task", "one", "PostToolUse", "in-progress", "request_user_input_async");
			expect(state.apply("task", "one", "PreToolUse", status, "request_user_input").pending, status).toBe(false);
			expect(state.apply("task", "one", "PostToolUse", "in-progress", "Bash").pending, status).toBe(false);
		}
	});
});

describe("AgentPromptLedger — Claude prompts gate their pane", () => {
	const tool = (toolName: string, toolUseId?: string, extra: { agentId?: string; sessionId?: string; paneId?: string } = {}) => ({
		taskId: "task",
		sessionId: extra.sessionId ?? "s1",
		paneId: extra.paneId ?? "%1",
		toolName,
		...(toolUseId ? { toolUseId } : {}),
		...(extra.agentId ? { agentId: extra.agentId } : {}),
	});

	it("opens on PermissionRequest and closes on the PostToolUse of the call before it", () => {
		const ledger = new AgentPromptLedger();
		const closed: string[] = [];
		ledger.onPromptClosed((taskId, paneId) => closed.push(`${taskId}/${paneId}`));
		ledger.claudePreToolUse(tool("Bash", "toolu_1"));
		expect(ledger.isPromptOpen("task", "%1")).toBe(false);
		ledger.claudePermissionRequest(tool("Bash"));
		expect(ledger.isPromptOpen("task", "%1")).toBe(true);
		expect(ledger.isPromptOpen("task", "%2")).toBe(false);
		ledger.claudePostToolUse(tool("Bash", "toolu_2"));
		expect(ledger.isPromptOpen("task", "%1")).toBe(true);
		ledger.claudePostToolUse(tool("Bash", "toolu_1"));
		expect(ledger.isPromptOpen("task", "%1")).toBe(false);
		expect(closed).toEqual(["task/%1"]);
	});

	it("opens an AskUserQuestion picker from its PreToolUse alone, and its PermissionRequest is the same prompt", () => {
		const ledger = new AgentPromptLedger();
		ledger.claudePreToolUse(tool("AskUserQuestion", "toolu_q"));
		expect(ledger.isPromptOpen("task", "%1")).toBe(true);
		ledger.claudePermissionRequest(tool("AskUserQuestion"));
		ledger.claudePostToolUse(tool("AskUserQuestion", "toolu_q"));
		expect(ledger.isPromptOpen("task", "%1")).toBe(false);
	});

	it("closes on the session returning (next prompt, Stop, SessionEnd), the user's send-now, or the pane exiting", () => {
		const closers: Array<[string, (l: AgentPromptLedger) => void]> = [
			["session returned", (l) => l.claudeSessionReturned("task", "s1")],
			["pane closed", (l) => { l.closePane("task", "%1"); }],
		];
		for (const [name, close] of closers) {
			const ledger = new AgentPromptLedger();
			ledger.claudePreToolUse(tool("Bash", "toolu_1"));
			ledger.claudePermissionRequest(tool("Bash"));
			close(ledger);
			expect(ledger.isPromptOpen("task", "%1"), name).toBe(false);
		}
	});

	it("stays open through later tool calls of the same agent — a menu waits for its own answer", () => {
		const ledger = new AgentPromptLedger();
		ledger.claudePreToolUse(tool("Bash", "toolu_1"));
		ledger.claudePermissionRequest(tool("Bash"));
		ledger.claudePreToolUse(tool("Read", "toolu_2"));
		ledger.claudePostToolUse(tool("Read", "toolu_2"));
		expect(ledger.isPromptOpen("task", "%1")).toBe(true);
		ledger.claudePostToolUse(tool("Bash", "toolu_1"));
		expect(ledger.isPromptOpen("task", "%1")).toBe(false);
	});

	it("waits for every parallel call of the asking tool, since the request cannot say which one asked", () => {
		const ledger = new AgentPromptLedger();
		ledger.claudePreToolUse(tool("Bash", "toolu_a"));
		ledger.claudePreToolUse(tool("Bash", "toolu_b"));
		ledger.claudePermissionRequest(tool("Bash"));
		ledger.claudePostToolUse(tool("Bash", "toolu_b"));
		expect(ledger.isPromptOpen("task", "%1")).toBe(true);
		ledger.claudePostToolUse(tool("Bash", "toolu_a"));
		expect(ledger.isPromptOpen("task", "%1")).toBe(false);
	});

	it("forgets a finished call, so a later request waits only for calls still in flight", () => {
		const ledger = new AgentPromptLedger();
		ledger.claudePreToolUse(tool("Bash", "toolu_done"));
		ledger.claudePostToolUse(tool("Bash", "toolu_done"));
		ledger.claudePreToolUse(tool("Bash", "toolu_next"));
		ledger.claudePermissionRequest(tool("Bash"));
		ledger.claudePostToolUse(tool("Bash", "toolu_next"));
		expect(ledger.isPromptOpen("task", "%1")).toBe(false);
	});

	it("keeps a subagent's prompt open across the main agent's tool calls, and another session's events", () => {
		const ledger = new AgentPromptLedger();
		ledger.claudePreToolUse(tool("Bash", "toolu_sub", { agentId: "agent-a" }));
		ledger.claudePermissionRequest(tool("Bash", undefined, { agentId: "agent-a" }));
		ledger.claudePreToolUse(tool("Read", "toolu_main"));
		ledger.claudeSessionReturned("task", "other-session");
		ledger.claudePostToolUse(tool("Bash", "toolu_main"));
		expect(ledger.isPromptOpen("task", "%1")).toBe(true);
		ledger.claudePostToolUse(tool("Bash", "toolu_sub", { agentId: "agent-a" }));
		expect(ledger.isPromptOpen("task", "%1")).toBe(false);
	});

	it("keys a PermissionRequest with no PreToolUse by its tool, and its PostToolUse still closes it", () => {
		const ledger = new AgentPromptLedger();
		ledger.claudePermissionRequest(tool("ExitPlanMode"));
		expect(ledger.isPromptOpen("task", "%1")).toBe(true);
		ledger.claudePostToolUse(tool("ExitPlanMode", "toolu_x"));
		expect(ledger.isPromptOpen("task", "%1")).toBe(false);
	});

	it("announces a pane only once its last prompt closed", () => {
		const ledger = new AgentPromptLedger();
		const closed: string[] = [];
		ledger.onPromptClosed((_, paneId) => closed.push(paneId));
		ledger.claudePreToolUse(tool("AskUserQuestion", "toolu_a", { agentId: "agent-a" }));
		ledger.claudePreToolUse(tool("AskUserQuestion", "toolu_b", { agentId: "agent-b" }));
		ledger.claudePostToolUse(tool("AskUserQuestion", "toolu_a", { agentId: "agent-a" }));
		expect(closed).toEqual([]);
		ledger.claudePostToolUse(tool("AskUserQuestion", "toolu_b", { agentId: "agent-b" }));
		expect(closed).toEqual(["%1"]);
	});

	it("gates a blocking Codex question in its pane but never an async card", () => {
		const ledger = new AgentPromptLedger();
		ledger.applyStatusHook({ taskId: "task", sessionId: "c1", event: "PostToolUse", status: "in-progress", harness: "codex", paneId: "%3", toolName: "request_user_input_async", toolUseId: "async" });
		expect(ledger.isPromptOpen("task", "%3")).toBe(false);
		ledger.applyStatusHook({ taskId: "task", sessionId: "c1", event: "PreToolUse", status: "in-progress", harness: "codex", paneId: "%3", toolName: "request_user_input", toolUseId: "call" });
		expect(ledger.isPromptOpen("task", "%3")).toBe(true);
		ledger.applyStatusHook({ taskId: "task", sessionId: "c1", event: "PostToolUse", status: "user-questions", harness: "codex", paneId: "%3", toolName: "request_user_input", toolUseId: "call" });
		expect(ledger.isPromptOpen("task", "%3")).toBe(false);
	});

	it("does not count Claude prompts as pending Codex questions", () => {
		const ledger = new AgentPromptLedger();
		ledger.claudePreToolUse(tool("AskUserQuestion", "toolu_q"));
		expect(ledger.applyStatusHook({ taskId: "task", sessionId: "c1", event: "PostToolUse", status: "in-progress", harness: "codex", toolName: "Bash" }).pending).toBe(false);
	});
});

describe("AgentPromptLedger — status-hook harnesses gate their pane", () => {
	type Harness = "codex" | "copilot" | "omp" | "pi" | "agy";
	type Extra = { toolName?: string; toolUseId?: string; promptEnd?: boolean; heartbeat?: boolean; sessionId?: string; paneId?: string };
	const hook = (ledger: AgentPromptLedger, harness: Harness, event: AgentStatusHookEvent, extra: Extra = {}) =>
		ledger.applyStatusHookGate({ taskId: "task", sessionId: extra.sessionId ?? "s1", event, harness, paneId: extra.paneId ?? "%1", ...extra });

	it("holds a Codex approval until its own call ends, through a parallel call of the same tool", () => {
		const ledger = new AgentPromptLedger();
		hook(ledger, "codex", "PreToolUse", { toolName: "Bash", toolUseId: "a" });
		hook(ledger, "codex", "PreToolUse", { toolName: "Bash", toolUseId: "b" });
		hook(ledger, "codex", "PermissionRequest", { toolName: "Bash", toolUseId: "a" });
		expect(ledger.isPromptOpen("task", "%1")).toBe(true);
		hook(ledger, "codex", "PostToolUse", { toolName: "Bash", toolUseId: "b" });
		expect(ledger.isPromptOpen("task", "%1")).toBe(true);
		hook(ledger, "codex", "PostToolUse", { toolName: "Bash", toolUseId: "a" });
		expect(ledger.isPromptOpen("task", "%1")).toBe(false);
	});

	it("waits for every parallel call when the Codex approval names none", () => {
		const ledger = new AgentPromptLedger();
		hook(ledger, "codex", "PreToolUse", { toolName: "functions.exec_command", toolUseId: "a" });
		hook(ledger, "codex", "PreToolUse", { toolName: "exec_command", toolUseId: "b" });
		hook(ledger, "codex", "PermissionRequest", { toolName: "exec_command" });
		hook(ledger, "codex", "PostToolUse", { toolName: "exec_command", toolUseId: "b" });
		expect(ledger.isPromptOpen("task", "%1")).toBe(true);
		hook(ledger, "codex", "PostToolUse", { toolName: "exec_command", toolUseId: "a" });
		expect(ledger.isPromptOpen("task", "%1")).toBe(false);
	});

	it("closes a Copilot ask_user question on that tool's postToolUse, not another tool's", () => {
		const ledger = new AgentPromptLedger();
		hook(ledger, "copilot", "PermissionRequest", { toolName: "ask_user" });
		hook(ledger, "copilot", "PostToolUse", { toolName: "bash" });
		expect(ledger.isPromptOpen("task", "%1")).toBe(true);
		hook(ledger, "copilot", "PostToolUse", { toolName: "ask_user" });
		expect(ledger.isPromptOpen("task", "%1")).toBe(false);
	});

	it("keeps an omp or pi prompt open through a tool's end, and closes it on the prompt's own end", () => {
		for (const harness of ["omp", "pi"] as const) {
			const ledger = new AgentPromptLedger();
			hook(ledger, harness, "PermissionRequest");
			hook(ledger, harness, "PostToolUse");
			expect(ledger.isPromptOpen("task", "%1"), `${harness} after a tool end`).toBe(true);
			hook(ledger, harness, "PostToolUse", { promptEnd: true });
			expect(ledger.isPromptOpen("task", "%1"), `${harness} after the prompt end`).toBe(false);
		}
	});

	it("closes an agy approval wait on its PostToolUse, which names no tool", () => {
		const ledger = new AgentPromptLedger();
		hook(ledger, "agy", "PermissionRequest");
		expect(ledger.isPromptOpen("task", "%1")).toBe(true);
		hook(ledger, "agy", "PostToolUse");
		expect(ledger.isPromptOpen("task", "%1")).toBe(false);
	});

	it("closes on the session's UserPromptSubmit, Stop, Interrupt, SessionStart or SessionEnd, and only that session's", () => {
		for (const event of ["UserPromptSubmit", "Stop", "Interrupt", "SessionStart", "SessionEnd"] as const) {
			const ledger = new AgentPromptLedger();
			hook(ledger, "omp", "PermissionRequest");
			hook(ledger, "omp", "PermissionRequest", { sessionId: "s2", paneId: "%2" });
			hook(ledger, "omp", event);
			expect(ledger.isPromptOpen("task", "%1"), `${event} closes its own session`).toBe(false);
			expect(ledger.isPromptOpen("task", "%2"), `${event} leaves the other session`).toBe(true);
		}
	});

	it("leaves the card's question status alone: an approval is not a pending Codex question", () => {
		const ledger = new AgentPromptLedger();
		hook(ledger, "codex", "PermissionRequest", { toolName: "Bash" });
		expect(ledger.isPromptOpen("task", "%1")).toBe(true);
		expect(ledger.applyStatusHook({ taskId: "task", sessionId: "s1", event: "PermissionRequest", status: "in-progress", harness: "codex", paneId: "%1", toolName: "Bash" }).pending).toBe(false);
	});

	it("keeps a Codex approval for a call it never saw start open through other calls of that tool", () => {
		const ledger = new AgentPromptLedger();
		hook(ledger, "codex", "PreToolUse", { toolName: "Bash", toolUseId: "other" });
		hook(ledger, "codex", "PermissionRequest", { toolName: "Bash", toolUseId: "asker" });
		hook(ledger, "codex", "PostToolUse", { toolName: "Bash", toolUseId: "other" });
		expect(ledger.isPromptOpen("task", "%1")).toBe(true);
		hook(ledger, "codex", "PostToolUse", { toolName: "Bash", toolUseId: "asker" });
		expect(ledger.isPromptOpen("task", "%1")).toBe(false);
	});

	it("closes stacked omp approvals one end mark at a time", () => {
		const ledger = new AgentPromptLedger();
		hook(ledger, "omp", "PermissionRequest");
		hook(ledger, "omp", "PermissionRequest");
		hook(ledger, "omp", "PostToolUse", { promptEnd: true });
		expect(ledger.isPromptOpen("task", "%1")).toBe(true);
		hook(ledger, "omp", "PostToolUse", { promptEnd: true });
		expect(ledger.isPromptOpen("task", "%1")).toBe(false);
	});

	it("opens no second prompt for an agy heartbeat of a wait already open", () => {
		const ledger = new AgentPromptLedger();
		hook(ledger, "agy", "PermissionRequest");
		hook(ledger, "agy", "PermissionRequest", { heartbeat: true });
		hook(ledger, "agy", "PermissionRequest", { heartbeat: true });
		expect(ledger.closePane("task", "%1")).toBe(1);
	});
});
