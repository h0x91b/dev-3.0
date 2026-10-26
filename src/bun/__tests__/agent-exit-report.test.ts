import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Task } from "../../shared/types";

const fixtures = vi.hoisted(() => ({ task: {} as Task }));
vi.mock("../cli-socket/task-resolution", () => ({
	resolveTaskFromParams: async () => ({ project: { id: "project" }, task: fixtures.task }),
}));
vi.mock("../rpc-handlers", () => ({
	moveTask: vi.fn(async (params) => {
		if (fixtures.task.status === params.ifStatus) fixtures.task = { ...fixtures.task, status: params.newStatus };
		return fixtures.task;
	}),
	pushCliAttention: vi.fn(),
}));
vi.mock("../cli-socket/pane-sessions", () => ({ capturePaneSession: vi.fn(async () => {}) }));
vi.mock("../agent-terminal-prompt-log", () => ({ recordTerminalPromptSubmission: vi.fn(() => "suppressed") }));

import { agentHandlers } from "../cli-socket/agent-commands";
import { moveTask, pushCliAttention } from "../rpc-handlers";
import { agentSessionRecord, noteAgentLaunched, resetAgentSessionRecordsForTests } from "../agent-session-receipts";

const SESSION = "11111111-2222-4333-8444-555555555555";

const exited = (exitCode: number) =>
	agentHandlers["agent.exited"]!({ taskId: "task", projectId: "project", sessionId: SESSION, exitCode });
const sessionStarted = (paneId = "%1") =>
	agentHandlers["agent.sessionStarted"]!({ taskId: "task", projectId: "project", sessionId: SESSION, source: "startup", paneId });

beforeEach(() => {
	vi.clearAllMocks();
	resetAgentSessionRecordsForTests();
	fixtures.task = {
		id: "task", projectId: "project", status: "in-progress", worktreePath: "/tmp/wt",
		sessionState: { panes: [{ paneId: "%1", sessionId: SESSION, agentCmd: "claude", agentId: null, configId: null }] },
	} as Task;
});

describe("the launch wrapper's exit report (#2034)", () => {
	it.each([1, 0])("takes the card off Agent is Working when a launched agent exits %i before its session started", async (code) => {
		noteAgentLaunched("task", SESSION);
		await expect(exited(code)).resolves.toEqual({ moved: true });

		expect(fixtures.task.status).toBe("user-questions");
		expect(moveTask).toHaveBeenCalledWith(expect.objectContaining({ newStatus: "user-questions", ifStatus: "in-progress" }));
		expect(pushCliAttention).toHaveBeenCalledWith(expect.objectContaining({
			taskId: "task",
			reason: expect.stringContaining(`exit code ${code}`),
		}));
	});

	it("leaves a session that reported SessionStart alone — a graceful /exit at hibernate or completion", async () => {
		noteAgentLaunched("task", SESSION);
		await sessionStarted();
		await expect(exited(0)).resolves.toEqual({ moved: false });
		expect(moveTask).not.toHaveBeenCalled();
		expect(fixtures.task.status).toBe("in-progress");
	});

	it("counts a prompt as proof of start when the SessionStart receipt itself was lost", async () => {
		noteAgentLaunched("task", SESSION);
		await agentHandlers["task.promptSubmitted"]!({ taskId: "task", projectId: "project", harness: "claude", sessionId: SESSION, paneId: "%1", prompt: "hi" });
		vi.mocked(moveTask).mockClear();
		await exited(1);
		expect(moveTask).not.toHaveBeenCalled();
	});

	it("counts SessionEnd as proof of start too", async () => {
		noteAgentLaunched("task", SESSION);
		await agentHandlers["task.claudeTurnEnded"]!({ taskId: "task", projectId: "project", sessionId: SESSION, paneId: "%1" });
		await exited(0);
		expect(moveTask).not.toHaveBeenCalled();
	});

	it("does nothing for an agent this app process did not launch: app restart, reattach, manual resume", async () => {
		await expect(exited(1)).resolves.toEqual({ moved: false });
		expect(moveTask).not.toHaveBeenCalled();
		expect(pushCliAttention).not.toHaveBeenCalled();
		expect(agentSessionRecord("task", SESSION)?.exitCode).toBe(1);
	});

	it.each([
		["a card already in another column", { status: "review-by-user" }],
		["a hibernated task", { hibernated: true }],
	])("does not move %s", async (_label, overrides) => {
		fixtures.task = { ...fixtures.task, ...overrides } as Task;
		noteAgentLaunched("task", SESSION);
		await exited(1);
		expect(moveTask).not.toHaveBeenCalled();
	});

	it("records the started session with its pane, moving no status", async () => {
		noteAgentLaunched("task", SESSION);
		await sessionStarted("%7");
		expect(agentSessionRecord("task", SESSION)).toMatchObject({ paneId: "%7" });
		expect(agentSessionRecord("task", SESSION)?.startedAt).not.toBeNull();
		expect(moveTask).not.toHaveBeenCalled();
	});
});
