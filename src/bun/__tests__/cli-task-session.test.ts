import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Project, Task } from "../../shared/types";
vi.mock("../settings", () => ({ loadSettings: vi.fn(async () => ({ agentLaunchAutoApproveMinutes: 5 })), loadSettingsSync: vi.fn(() => ({})) }));
vi.mock("../data", () => ({ getTask: vi.fn() }));
vi.mock("../rpc-handlers/shared-pure", () => ({ getPushMessage: vi.fn() }));
vi.mock("../rpc-handlers/task-lifecycle", () => ({ hibernateTask: vi.fn() }));
vi.mock("../rpc-handlers/tmux-pty", () => ({ taskTerminalAlive: vi.fn(), wakeTaskShell: vi.fn() }));
vi.mock("../cli-agent-resume", () => ({ resumeCliAgent: vi.fn() }));
vi.mock("../task-terminal-backend", () => ({ taskTerminalBackendIdentity: vi.fn(() => "tmux") }));
vi.mock("../task-workspace-guard", () => ({ assertTaskWorkspacePresent: vi.fn() }));
import { hibernateCliTask, wakeCliTask } from "../cli-task-session";
import { getTask } from "../data";
import { getPushMessage } from "../rpc-handlers/shared-pure";
import { hibernateTask } from "../rpc-handlers/task-lifecycle";
import { taskTerminalAlive, wakeTaskShell } from "../rpc-handlers/tmux-pty";
import { resumeCliAgent } from "../cli-agent-resume";
import { _resetAgentRequestsForTests, resolveAgentRequest, voidAgentRequest } from "../agent-requests";
import { askSessionApproval } from "../cli-session-approval";
import { assertTaskWorkspacePresent } from "../task-workspace-guard";

const project = { id: "project-1", name: "Fixture", path: "/repo" } as Project;
const panes = [
	{ agentCmd: "claude", agentId: "agent-1", configId: "config-1", sessionId: "s-main" },
	{ agentCmd: "codex", agentId: "agent-2", configId: "config-2", sessionId: "s-extra" },
];
const task = { id: "task-1", projectId: project.id, seq: 7, title: "Fixture task", status: "review-by-user", worktreePath: "/repo/wt", lifecycleStartedAt: "start-1", sessionState: { panes } } as Task;
const hibernated = { ...task, hibernated: true } as Task;
const requester = { ...task, id: "task-2", seq: 9, title: "Coordinator" } as Task;
const push = vi.fn();

beforeEach(() => {
	vi.clearAllMocks(); _resetAgentRequestsForTests();
	vi.mocked(getPushMessage).mockReturnValue(push);
	vi.mocked(getTask).mockResolvedValue(task);
	vi.mocked(taskTerminalAlive).mockResolvedValue(true);
	vi.mocked(hibernateTask).mockResolvedValue({ task: hibernated, freedRssBytes: 512 * 1024 * 1024 });
	vi.mocked(wakeTaskShell).mockResolvedValue("ws://x");
});
afterEach(() => _resetAgentRequestsForTests());

async function answer(approved: boolean) {
	await vi.waitFor(() => expect(push).toHaveBeenCalledWith("agentLaunchRequested", expect.anything()));
	resolveAgentRequest(push.mock.calls[0][1].requestId, { approved });
}

describe("dev3 task hibernate", () => {
	it("hibernates directly, through the same handler as the button, when a person runs it", async () => {
		await expect(hibernateCliTask({ project, task, requester: null })).resolves.toEqual({
			outcome: "hibernated", taskId: task.id, seq: 7, freedRssBytes: 512 * 1024 * 1024,
		});
		expect(push).not.toHaveBeenCalled();
		expect(hibernateTask).toHaveBeenCalledWith({ taskId: task.id, projectId: project.id });
	});

	it.each([
		["already-hibernated", { hibernated: true }],
		["draft", { draft: true }],
		["not-active", { status: "todo" }],
		["no-worktree", { worktreePath: null }],
	])("refuses a %s task before asking anyone", async (reason, patch) => {
		const outcome = await hibernateCliTask({ project, task: { ...task, ...patch } as Task, requester });
		expect(outcome).toMatchObject({ outcome: "nothing-to-free", reason });
		expect(push).not.toHaveBeenCalled();
		expect(hibernateTask).not.toHaveBeenCalled();
	});

	it("refuses a task with no live terminal", async () => {
		vi.mocked(taskTerminalAlive).mockResolvedValue(false);
		await expect(hibernateCliTask({ project, task, requester })).resolves.toMatchObject({ outcome: "nothing-to-free", reason: "not-running" });
		expect(hibernateTask).not.toHaveBeenCalled();
	});

	it("asks an agent's request through the launch dialog with its countdown, then hibernates", async () => {
		const pending = hibernateCliTask({ project, task, requester });
		await answer(true);
		await expect(pending).resolves.toMatchObject({ outcome: "hibernated" });
		const request = push.mock.calls[0][1];
		expect(request).toMatchObject({ requesterSeq: 9, taskId: task.id, sessionAction: { kind: "hibernate", paneCount: 2 }, canAddVariants: false });
		expect(request.autoApproveAt).toBeGreaterThan(Date.now());
		expect(request.resume).toBeUndefined();
		expect(request.spawn).toBeUndefined();
	});

	it("asks even when an agent hibernates its own task", async () => {
		const pending = hibernateCliTask({ project, task, requester: task });
		await answer(true);
		await expect(pending).resolves.toMatchObject({ outcome: "hibernated" });
	});

	it("stops nothing when declined, or when the run ended before an answer", async () => {
		const declined = hibernateCliTask({ project, task, requester });
		await answer(false);
		await expect(declined).resolves.toEqual({ outcome: "declined", taskId: task.id, seq: 7 });
		push.mockClear();
		const voided = hibernateCliTask({ project, task, requester });
		await vi.waitFor(() => expect(push).toHaveBeenCalled());
		voidAgentRequest("launch", task.id);
		await expect(voided).resolves.toEqual({ outcome: "declined", taskId: task.id, seq: 7, stale: true });
		expect(hibernateTask).not.toHaveBeenCalled();
	});

	it("re-checks after approval: a task hibernated from the app meanwhile is left alone", async () => {
		const pending = hibernateCliTask({ project, task, requester });
		await vi.waitFor(() => expect(push).toHaveBeenCalled());
		vi.mocked(getTask).mockResolvedValue(hibernated);
		await answer(true);
		await expect(pending).resolves.toMatchObject({ outcome: "nothing-to-free", reason: "already-hibernated" });
		expect(hibernateTask).not.toHaveBeenCalled();
	});

	it("joins a retry to the pending request instead of opening a second dialog", async () => {
		const first = hibernateCliTask({ project, task, requester });
		const retry = hibernateCliTask({ project, task, requester });
		await answer(true);
		await expect(first).resolves.toMatchObject({ outcome: "hibernated" });
		await expect(retry).resolves.toMatchObject({ outcome: "hibernated" });
		expect(push.mock.calls.filter(([name]) => name === "agentLaunchRequested")).toHaveLength(1);
		expect(hibernateTask).toHaveBeenCalledTimes(1);
	});
});

describe("dev3 task wake", () => {
	it("refuses a task that is not hibernated, in either mode", async () => {
		for (const mode of ["shell", "resume"] as const) {
			await expect(wakeCliTask({ project, task, requester, mode, allowAgentLatest: false })).resolves.toEqual({ outcome: "not-hibernated", taskId: task.id, seq: 7 });
		}
		expect(wakeTaskShell).not.toHaveBeenCalled();
		expect(resumeCliAgent).not.toHaveBeenCalled();
	});

	it("--resume is exactly dev3 agent resume", async () => {
		const resumed = { outcome: "declined", taskId: task.id, seq: 7 } as const;
		vi.mocked(resumeCliAgent).mockResolvedValue(resumed);
		await expect(wakeCliTask({ project, task: hibernated, requester, mode: "resume", allowAgentLatest: true })).resolves.toEqual({ outcome: "resume", resume: resumed });
		expect(resumeCliAgent).toHaveBeenCalledWith({ project, task: hibernated, requester, allowAgentLatest: true });
	});

	it("--shell wakes directly when a person runs it", async () => {
		await expect(wakeCliTask({ project, task: hibernated, requester: null, mode: "shell", allowAgentLatest: false })).resolves.toEqual({
			outcome: "woke-shell", taskId: task.id, seq: 7, backend: "tmux",
		});
		expect(push).not.toHaveBeenCalled();
		expect(wakeTaskShell).toHaveBeenCalledWith({ taskId: task.id });
	});

	it("--shell refuses a missing worktree before asking anybody", async () => {
		vi.mocked(assertTaskWorkspacePresent).mockImplementationOnce(() => { throw new Error("The task's worktree is missing"); });
		await expect(wakeCliTask({ project, task: hibernated, requester, mode: "shell", allowAgentLatest: false })).rejects.toThrow("worktree is missing");
		expect(push).not.toHaveBeenCalled();
		expect(wakeTaskShell).not.toHaveBeenCalled();
	});

	it("--shell from another task asks first, and a decline wakes nothing", async () => {
		vi.mocked(getTask).mockResolvedValue(hibernated);
		const declined = wakeCliTask({ project, task: hibernated, requester, mode: "shell", allowAgentLatest: false });
		await answer(false);
		await expect(declined).resolves.toEqual({ outcome: "declined", taskId: task.id, seq: 7 });
		expect(push.mock.calls[0][1]).toMatchObject({ sessionAction: { kind: "wake-shell" } });
		expect(wakeTaskShell).not.toHaveBeenCalled();
		push.mockClear();
		const approved = wakeCliTask({ project, task: hibernated, requester, mode: "shell", allowAgentLatest: false });
		await answer(true);
		await expect(approved).resolves.toMatchObject({ outcome: "woke-shell" });
		expect(wakeTaskShell).toHaveBeenCalledTimes(1);
	});
});

describe("askSessionApproval", () => {
	it("refuses a second request that arrives while the first is still being created, instead of joining its answer", async () => {
		const ask = (subject: Parameters<typeof askSessionApproval>[0]["subject"]) =>
			askSessionApproval({ project, task, requester, subject, alreadyPending: "already pending" });
		const hibernate = ask({ sessionAction: { kind: "hibernate", paneCount: 2 } });
		const resume = ask({ resume: { panes: [] } });
		await expect(resume).rejects.toThrow("already pending");
		expect(push.mock.calls.filter(([name]) => name === "agentLaunchRequested")).toHaveLength(1);
		await answer(true);
		await expect(hibernate).resolves.toEqual({ approved: true });
	});
});
