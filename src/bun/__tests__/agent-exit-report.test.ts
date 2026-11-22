import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Task } from "../../shared/types";

const fixtures = vi.hoisted(() => ({ task: {} as Task }));
const pushMessage = vi.hoisted(() => vi.fn());
vi.mock("../cli-socket/task-resolution", () => ({
	resolveTaskFromParams: async () => ({ project: { id: "project" }, task: fixtures.task }),
}));
vi.mock("../data", async (importOriginal) => ({ ...(await importOriginal<typeof import("../data")>()), updateTask: vi.fn(), updateTaskWith: vi.fn() }));
vi.mock("../rpc-handlers", () => ({
	getPushMessage: vi.fn(() => pushMessage),
	moveTask: vi.fn(async (params) => {
		if (fixtures.task.status === params.ifStatus) fixtures.task = { ...fixtures.task, status: params.newStatus };
		return fixtures.task;
	}),
	pushCliAttention: vi.fn(),
}));
vi.mock("../cli-socket/pane-sessions", () => ({ capturePaneSession: vi.fn(async () => {}) }));
vi.mock("../agent-terminal-prompt-log", () => ({ recordTerminalPromptSubmission: vi.fn(() => "suppressed") }));
vi.mock("../rate-limit-monitor", () => ({ forgetClaudeSessionDump: vi.fn() }));

import { agentHandlers } from "../cli-socket/agent-commands";
import { moveTask, pushCliAttention } from "../rpc-handlers";
import * as data from "../data";
import { tmux } from "../tmux";
import { forgetClaudeSessionDump } from "../rate-limit-monitor";
import { agentSessionRecord, noteAgentLaunched, resetAgentSessionRecordsForTests } from "../agent-session-receipts";
import { agentPromptLedger } from "../agent-prompt-ledger";
import { claudeApprovals } from "../claude-approval-state";

const SESSION = "11111111-2222-4333-8444-555555555555";

const exited = (exitCode: number) =>
	agentHandlers["agent.exited"]!({ taskId: "task", projectId: "project", sessionId: SESSION, exitCode });
const sessionStarted = (paneId = "%1") =>
	agentHandlers["agent.sessionStarted"]!({ taskId: "task", projectId: "project", sessionId: SESSION, source: "startup", paneId });

beforeEach(() => {
	vi.clearAllMocks();
	vi.spyOn(tmux, "capturePane").mockResolvedValue("");
	vi.mocked(data.updateTaskWith).mockImplementation((async (_p: unknown, _id: string, mutator: (t: Task) => { updates: Partial<Task>; result: unknown }) => {
		const { updates, result } = mutator(fixtures.task);
		return { task: { ...fixtures.task, ...updates }, result };
	}) as never);
	resetAgentSessionRecordsForTests();
	fixtures.task = {
		id: "task", projectId: "project", status: "in-progress", worktreePath: "/tmp/wt",
		sessionState: { panes: [{ paneId: "%1", sessionId: SESSION, agentCmd: "claude", agentId: null, configId: null }] },
	} as Task;
});

describe("the launch wrapper's exit report (#2034)", () => {
	it.each([1, 0])("takes the card off Agent is Working when a launched agent exits %i before its session started", async (code) => {
		noteAgentLaunched("task", SESSION, { startReceipts: true });
		await expect(exited(code)).resolves.toEqual({ moved: true });

		expect(fixtures.task.status).toBe("user-questions");
		expect(moveTask).toHaveBeenCalledWith(expect.objectContaining({ newStatus: "user-questions", ifStatus: "in-progress", skipQuestionsBadge: true }));
		expect(pushCliAttention).toHaveBeenCalledTimes(1);
		expect(pushCliAttention).toHaveBeenCalledWith(expect.objectContaining({
			taskId: "task",
			reason: expect.stringContaining(`exit code ${code}`),
		}));
	});

	it("leaves a session that reported SessionStart alone — a graceful /exit at hibernate or completion", async () => {
		noteAgentLaunched("task", SESSION, { startReceipts: true });
		await sessionStarted();
		await expect(exited(0)).resolves.toEqual({ moved: false });
		expect(moveTask).not.toHaveBeenCalled();
		expect(fixtures.task.status).toBe("in-progress");
	});

	it.each([
		["the pane the exit report names", { paneId: "%1" }],
		["the pane its session started in", {}],
	])("closes an open prompt in %s, so its held messages are not stuck behind a gone menu", async (_, report) => {
		agentPromptLedger.reset();
		await sessionStarted("%1");
		agentPromptLedger.claudePermissionRequest({ taskId: "task", sessionId: SESSION, toolName: "Bash", paneId: "%1" });
		expect(agentPromptLedger.isPromptOpen("task", "%1")).toBe(true);
		await agentHandlers["agent.exited"]!({ taskId: "task", projectId: "project", sessionId: SESSION, exitCode: 0, ...report });
		expect(agentPromptLedger.isPromptOpen("task", "%1")).toBe(false);
	});

	it("drops the exited session's approval waits, so the next session is not pinned in Has Questions", async () => {
		fixtures.task = { ...fixtures.task, status: "user-questions" };
		claudeApprovals.apply("task", "in-progress", "PermissionRequest", { sessionId: SESSION });
		await exited(0);
		expect(claudeApprovals.apply("task", "user-questions", "PreToolUse", { sessionId: "next-session" })).toBe("in-progress");
		claudeApprovals.forgetTask("task");
	});

	it("drops a resumed session's waits too: its exit report carries a fresh launch id, not the conversation id", async () => {
		const launchId = "99999999-8888-4777-8666-555555555555";
		noteAgentLaunched("task", launchId, { startReceipts: false });
		fixtures.task = { ...fixtures.task, status: "user-questions" };
		claudeApprovals.apply("task", "in-progress", "PermissionRequest", { sessionId: SESSION });
		await agentHandlers["agent.exited"]!({ taskId: "task", projectId: "project", sessionId: launchId, exitCode: 0, paneId: "%1" });
		expect(claudeApprovals.apply("task", "user-questions", "PreToolUse", { sessionId: "next-session" })).toBe("in-progress");
		claudeApprovals.forgetTask("task");
	});

	it("leaves the current conversation's waits alone when an older launch exits late", async () => {
		const oldLaunch = "77777777-8888-4777-8666-555555555555";
		noteAgentLaunched("task", oldLaunch, { startReceipts: false });
		noteAgentLaunched("task", "66666666-8888-4777-8666-555555555555", { startReceipts: false });
		fixtures.task = { ...fixtures.task, status: "user-questions" };
		claudeApprovals.apply("task", "in-progress", "PermissionRequest", { sessionId: SESSION });
		await agentHandlers["agent.exited"]!({ taskId: "task", projectId: "project", sessionId: oldLaunch, exitCode: 0, paneId: "%1" });
		expect(claudeApprovals.apply("task", "user-questions", "PreToolUse", { sessionId: "next-session" })).toBe("user-questions");
		claudeApprovals.forgetTask("task");
	});

	it("forgets the task's statusLine dump on any exit, so the card stops reporting the gone session", async () => {
		await exited(0);
		expect(forgetClaudeSessionDump).toHaveBeenCalledWith("task");
	});

	it("counts a prompt as proof of start when the SessionStart receipt itself was lost", async () => {
		noteAgentLaunched("task", SESSION, { startReceipts: true });
		await agentHandlers["task.promptSubmitted"]!({ taskId: "task", projectId: "project", harness: "claude", sessionId: SESSION, paneId: "%1", prompt: "hi" });
		vi.mocked(moveTask).mockClear();
		await exited(0);
		expect(moveTask).not.toHaveBeenCalled();
	});

	it("still moves a started session that crashes with a non-zero code", async () => {
		noteAgentLaunched("task", SESSION, { startReceipts: true });
		await sessionStarted();
		await expect(exited(137)).resolves.toEqual({ moved: true });
		expect(pushCliAttention).toHaveBeenCalledWith(expect.objectContaining({
			reason: "The agent exited (exit code 137). Its terminal shows why.",
		}));
	});

	it("counts SessionEnd as proof of start too", async () => {
		noteAgentLaunched("task", SESSION, { startReceipts: true });
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
		noteAgentLaunched("task", SESSION, { startReceipts: true });
		await exited(1);
		expect(moveTask).not.toHaveBeenCalled();
	});

	it("ignores a stale wrapper whose agent was replaced by a newer launch", async () => {
		noteAgentLaunched("task", SESSION, { startReceipts: true });
		noteAgentLaunched("task", "newer-launch", { startReceipts: false });
		await expect(exited(1)).resolves.toEqual({ moved: false });
		expect(moveTask).not.toHaveBeenCalled();
	});
});

describe("exit report of a harness without start receipts (Codex, Gemini, …)", () => {
	const LAUNCH = "launch-1";
	const exitedLaunch = (exitCode: number) =>
		agentHandlers["agent.exited"]!({ taskId: "task", projectId: "project", sessionId: LAUNCH, exitCode });

	it("takes the card to Has Questions with the exit code when the agent dies non-zero", async () => {
		noteAgentLaunched("task", LAUNCH, { startReceipts: false });
		await expect(exitedLaunch(1)).resolves.toEqual({ moved: true });

		expect(fixtures.task.status).toBe("user-questions");
		expect(pushCliAttention).toHaveBeenCalledWith(expect.objectContaining({
			taskId: "task",
			reason: "The agent exited (exit code 1). Its terminal shows why.",
		}));
	});

	it("leaves a clean exit 0 alone", async () => {
		noteAgentLaunched("task", LAUNCH, { startReceipts: false });
		await expect(exitedLaunch(0)).resolves.toEqual({ moved: false });
		expect(moveTask).not.toHaveBeenCalled();
		expect(fixtures.task.status).toBe("in-progress");
	});

	it("never moves the card for a launch the task has since replaced", async () => {
		noteAgentLaunched("task", LAUNCH, { startReceipts: false });
		noteAgentLaunched("task", "launch-2", { startReceipts: false });
		await expect(exitedLaunch(1)).resolves.toEqual({ moved: false });
		expect(moveTask).not.toHaveBeenCalled();
	});

	it("does nothing for a launch id this app process never minted", async () => {
		await expect(exitedLaunch(1)).resolves.toEqual({ moved: false });
		expect(moveTask).not.toHaveBeenCalled();
	});
});

describe("the started-session receipt", () => {
	it("records the started session with its pane, moving no status", async () => {
		noteAgentLaunched("task", SESSION, { startReceipts: true });
		await sessionStarted("%7");
		expect(agentSessionRecord("task", SESSION)).toMatchObject({ paneId: "%7" });
		expect(agentSessionRecord("task", SESSION)?.startedAt).not.toBeNull();
		expect(moveTask).not.toHaveBeenCalled();
	});
});

describe("the failed launch's cause is kept on the task", () => {
	const LAUNCH = "launch-1";
	const savedFailure = () => {
		const mutator = vi.mocked(data.updateTaskWith).mock.calls[0]?.[2] as ((t: Task) => { updates: Partial<Task> }) | undefined;
		return mutator?.(fixtures.task).updates.launchFailure;
	};

	it("saves the pane's last lines for an agent that never started, and pushes the task", async () => {
		const screen = [...Array.from({ length: 60 }, (_, i) => `line ${i}`), "", "  ", ""].join("\n");
		const capture = vi.spyOn(tmux, "capturePane").mockResolvedValue(screen);
		noteAgentLaunched("task", SESSION, { startReceipts: true });
		await exited(2);

		expect(capture).toHaveBeenCalledWith(expect.objectContaining({ target: "%1" }));
		expect(capture.mock.calls[0][0]).not.toHaveProperty("escapes", true);
		const failure = savedFailure();
		expect(failure).toMatchObject({ exitCode: 2, neverStarted: true, sessionId: SESSION });
		expect(failure?.output?.split("\n")).toHaveLength(40);
		expect(failure?.output?.endsWith("line 59")).toBe(true);
		expect(pushMessage).toHaveBeenCalledWith("taskUpdated", expect.objectContaining({ projectId: "project" }));
	});

	it("records a crash of an agent that had started as not-never-started", async () => {
		vi.spyOn(tmux, "capturePane").mockResolvedValue("boom\n");
		noteAgentLaunched("task", LAUNCH, { startReceipts: false });
		await agentHandlers["agent.exited"]!({ taskId: "task", projectId: "project", sessionId: LAUNCH, exitCode: 1 });
		expect(savedFailure()).toMatchObject({ exitCode: 1, neverStarted: false, output: "boom", sessionId: LAUNCH });
	});

	it("keeps the tail of an oversized capture", async () => {
		vi.spyOn(tmux, "capturePane").mockResolvedValue(`${"x".repeat(20_000)}END`);
		noteAgentLaunched("task", SESSION, { startReceipts: true });
		await exited(1);
		const output = savedFailure()?.output ?? "";
		expect(output).toHaveLength(8000);
		expect(output.endsWith("END")).toBe(true);
	});

	it("an old exit whose capture outlived its launch moves nothing and raises nothing", async () => {
		noteAgentLaunched("task", SESSION, { startReceipts: true });
		vi.spyOn(tmux, "capturePane").mockImplementation(async () => {
			noteAgentLaunched("task", "new-launch", { startReceipts: true });
			return "old launch failed";
		});
		await expect(exited(1)).resolves.toEqual({ moved: false });
		expect(agentSessionRecord("task", "new-launch")?.launchedAt).not.toBeNull();
		expect(moveTask).not.toHaveBeenCalled();
		expect(pushCliAttention).not.toHaveBeenCalled();
		expect(savedFailure()).toBeUndefined();
	});

	it("saves nothing for a clean exit or an unknown launch", async () => {
		const capture = vi.spyOn(tmux, "capturePane").mockResolvedValue("x");
		noteAgentLaunched("task", LAUNCH, { startReceipts: false });
		await agentHandlers["agent.exited"]!({ taskId: "task", projectId: "project", sessionId: LAUNCH, exitCode: 0 });
		await exited(1);
		expect(data.updateTaskWith).not.toHaveBeenCalled();
		expect(capture).not.toHaveBeenCalled();
	});

	it("keeps the cause with no output when the capture fails, and still moves the card", async () => {
		vi.spyOn(tmux, "capturePane").mockRejectedValue(new Error("no pane"));
		noteAgentLaunched("task", SESSION, { startReceipts: true });
		await expect(exited(2)).resolves.toEqual({ moved: true });
		expect(savedFailure()).toMatchObject({ neverStarted: true, output: null });
		expect(fixtures.task.status).toBe("user-questions");
	});

	it("still moves the card when saving the cause fails", async () => {
		vi.spyOn(tmux, "capturePane").mockResolvedValue("x");
		vi.mocked(data.updateTaskWith).mockRejectedValue(new Error("disk full"));
		noteAgentLaunched("task", SESSION, { startReceipts: true });
		await expect(exited(2)).resolves.toEqual({ moved: true });
	});

	it("records no output on the native backend", async () => {
		const capture = vi.spyOn(tmux, "capturePane").mockResolvedValue("x");
		fixtures.task = { ...fixtures.task, terminalBackend: "native" } as Task;
		noteAgentLaunched("task", SESSION, { startReceipts: true });
		await exited(2);
		expect(capture).not.toHaveBeenCalled();
		expect(savedFailure()).toMatchObject({ output: null, neverStarted: true });
	});

	it("a session start does not clear the cause: an early exit has no SessionStart for its own id", async () => {
		fixtures.task = { ...fixtures.task, launchFailure: { exitCode: 2, at: "t", output: null, neverStarted: true, sessionId: SESSION } } as Task;
		noteAgentLaunched("task", SESSION, { startReceipts: true });
		await sessionStarted("%2");
		await agentHandlers["agent.sessionStarted"]!({ taskId: "task", projectId: "project", sessionId: "another-session", source: "clear", paneId: "%3" });
		expect(data.updateTask).not.toHaveBeenCalled();
		expect(data.updateTaskWith).not.toHaveBeenCalled();
	});
});
