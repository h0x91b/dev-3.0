import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Task } from "../../shared/types";

const fixtures = vi.hoisted(() => ({ task: {} as Task, requester: null as Task | null }));
vi.mock("../cli-socket/task-resolution", () => ({
	resolveTaskFromParams: async () => ({ project: { id: "project" }, task: fixtures.task }),
	requirePaneTask: async () => ({ project: { id: "project" }, task: fixtures.task }),
	resolveRequesterTask: async () => fixtures.requester,
}));
vi.mock("../data", async (importOriginal) => ({ ...(await importOriginal<typeof import("../data")>()), updateTask: vi.fn(), updateTaskWith: vi.fn() }));
vi.mock("../rpc-handlers", () => ({ getPushMessage: vi.fn(() => vi.fn()), moveTask: vi.fn(async () => fixtures.task), pushCliAttention: vi.fn() }));
vi.mock("../cli-socket/pane-sessions", () => ({ capturePaneSession: vi.fn(async () => {}) }));
vi.mock("../agent-terminal-prompt-log", () => ({ recordTerminalPromptSubmission: vi.fn(() => "suppressed") }));
vi.mock("../rate-limit-monitor", () => ({ forgetClaudeSessionDump: vi.fn() }));
vi.mock("../task-sessions", () => ({ rememberTaskSession: vi.fn() }));
vi.mock("../extra-agent-exit", () => ({ recordAgentTurnEvent: vi.fn() }));
vi.mock("../cli-agent-exit", () => ({ exitCliAgent: vi.fn(async () => ({ outcome: "scheduled" })) }));

import { agentHandlers } from "../cli-socket/agent-commands";
import { exitCliAgent } from "../cli-agent-exit";
import { recordAgentTurnEvent } from "../extra-agent-exit";
import * as data from "../data";

const SESSION = "11111111-2222-4333-8444-555555555555";
const base = { taskId: "task", projectId: "project" };

beforeEach(() => {
	vi.clearAllMocks();
	vi.mocked(data.updateTaskWith).mockImplementation((async (_p: unknown, _id: string, mutator: (t: Task) => { updates: Partial<Task>; result: unknown }) => {
		const { updates, result } = mutator(fixtures.task);
		return { task: { ...fixtures.task, ...updates }, result };
	}) as never);
	fixtures.requester = null;
	fixtures.task = { id: "task", seq: 4, projectId: "project", status: "in-progress", worktreePath: "/tmp/wt", sessionState: { panes: [] } } as unknown as Task;
});

describe("turn reports that feed `dev3 agent exit`", () => {
	it("records a Claude Stop from a pane, but not a session end or a report with no pane", async () => {
		await agentHandlers["task.claudeTurnEnded"]!({ ...base, sessionId: SESSION, paneId: "%5" });
		expect(recordAgentTurnEvent).toHaveBeenCalledWith("task", "%5", "Stop");
		vi.mocked(recordAgentTurnEvent).mockClear();
		await agentHandlers["task.claudeTurnEnded"]!({ ...base, sessionId: SESSION, paneId: "%5", sessionEnded: true });
		await agentHandlers["task.claudeTurnEnded"]!({ ...base, sessionId: SESSION });
		expect(recordAgentTurnEvent).not.toHaveBeenCalled();
	});

	it("records a Claude prompt submission from a pane", async () => {
		await agentHandlers["task.promptSubmitted"]!({ ...base, harness: "claude", sessionId: SESSION, paneId: "%5", prompt: "hi" });
		expect(recordAgentTurnEvent).toHaveBeenCalledWith("task", "%5", "UserPromptSubmit");
		vi.mocked(recordAgentTurnEvent).mockClear();
		await agentHandlers["task.promptSubmitted"]!({ ...base, harness: "claude", sessionId: SESSION, prompt: "hi" });
		expect(recordAgentTurnEvent).not.toHaveBeenCalled();
	});

	it.each(["codex", "omp", "pi", "copilot", "agy"])("records %s status-hook Stop and UserPromptSubmit from a pane", async (harness) => {
		await agentHandlers["task.agentHook"]!({ ...base, harness, event: "UserPromptSubmit", paneId: "%6" });
		await agentHandlers["task.agentHook"]!({ ...base, harness, event: "Stop", paneId: "%6" });
		expect(vi.mocked(recordAgentTurnEvent).mock.calls).toEqual([["task", "%6", "UserPromptSubmit"], ["task", "%6", "Stop"]]);
	});

	it("ignores other hook events and reports with no pane", async () => {
		await agentHandlers["task.agentHook"]!({ ...base, harness: "codex", event: "PostToolUse", paneId: "%6" });
		await agentHandlers["task.agentHook"]!({ ...base, harness: "codex", event: "Stop" });
		expect(recordAgentTurnEvent).not.toHaveBeenCalled();
	});
});

describe("agent.exit", () => {
	it("hands the pane, the handle, the requester and the reason to the exit command", async () => {
		fixtures.requester = { id: "other" } as Task;
		await expect(agentHandlers["agent.exit"]!({ ...base, selfPaneId: " %5 ", agentHandle: "abc", reason: "Review done" })).resolves.toEqual({ outcome: "scheduled" });
		expect(exitCliAgent).toHaveBeenCalledWith(expect.objectContaining({
			task: fixtures.task, requester: fixtures.requester, selfPaneId: "%5", agentHandle: "abc", reason: expect.objectContaining({ text: "Review done" }),
		}));
	});

	it("passes no pane or handle when the CLI sent none, and refuses non-string ones", async () => {
		await agentHandlers["agent.exit"]!({ ...base });
		expect(exitCliAgent).toHaveBeenCalledWith(expect.objectContaining({ selfPaneId: null, agentHandle: null, requester: null }));
		await expect(agentHandlers["agent.exit"]!({ ...base, selfPaneId: 5 })).rejects.toThrow("selfPaneId must be a string");
		await expect(agentHandlers["agent.exit"]!({ ...base, agentHandle: {} })).rejects.toThrow("agentHandle must be a string");
	});
});
