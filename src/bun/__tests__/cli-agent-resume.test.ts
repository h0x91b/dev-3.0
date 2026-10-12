import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Project, Task } from "../../shared/types";
vi.mock("../settings", () => ({ loadSettings: vi.fn(async () => ({ agentLaunchAutoApproveMinutes: 0 })), loadSettingsSync: vi.fn(() => ({})) }));
vi.mock("../data", () => ({ getTask: vi.fn() }));
vi.mock("../task-workspace-guard", () => ({ assertTaskWorkspacePresent: vi.fn() }));
vi.mock("../rpc-handlers/shared-pure", () => ({ getPushMessage: vi.fn() }));
vi.mock("../rpc-handlers/tmux-pty", () => {
	class ResumeUnavailableError extends Error {
		constructor(readonly reason: string, message: string, readonly panes?: unknown[]) { super(message); }
	}
	return { ResumeUnavailableError, resumeTaskSession: vi.fn(), sessionStateOrLostCodexPane: vi.fn(), taskTerminalAlive: vi.fn() };
});
import { resumeCliAgent } from "../cli-agent-resume";
import { getTask } from "../data";
import { getPushMessage } from "../rpc-handlers/shared-pure";
import { ResumeUnavailableError, resumeTaskSession, sessionStateOrLostCodexPane, taskTerminalAlive } from "../rpc-handlers/tmux-pty";
import { _resetAgentRequestsForTests, createAgentRequest, resolveAgentRequest, voidAgentRequest } from "../agent-requests";

const project = { id: "project-1", name: "Fixture", path: "/repo" } as Project;
const panes = [
	{ agentCmd: "claude", agentId: "agent-1", configId: "config-1", sessionId: "s-main", accountId: "acct-1" },
	{ agentCmd: "codex", agentId: "agent-2", configId: "config-2", sessionId: "s-extra" },
];
const task = { id: "task-1", projectId: project.id, seq: 7, title: "Fixture task", status: "in-progress", worktreePath: "/repo/wt", lifecycleStartedAt: "start-1", sessionState: { panes } } as Task;
const requester = { ...task, id: "task-2", seq: 9, title: "Coordinator" } as Task;
const resumed = { taskId: task.id, seq: 7, projectId: project.id, backend: "tmux" as const, tmux: { socket: "dev3", session: "dev3-task-1" }, woke: false, panes: [] };
const push = vi.fn();

beforeEach(() => {
	vi.clearAllMocks(); _resetAgentRequestsForTests();
	vi.mocked(getPushMessage).mockReturnValue(push);
	vi.mocked(getTask).mockResolvedValue(task);
	vi.mocked(taskTerminalAlive).mockResolvedValue(false);
	vi.mocked(sessionStateOrLostCodexPane).mockResolvedValue({ panes } as any);
	vi.mocked(resumeTaskSession).mockResolvedValue({ kind: "resumed", url: "ws://x", result: resumed });
});
afterEach(() => _resetAgentRequestsForTests());

async function answer(approved: boolean, launch?: unknown) {
	await vi.waitFor(() => expect(push).toHaveBeenCalledWith("agentLaunchRequested", expect.anything()));
	resolveAgentRequest(push.mock.calls[0][1].requestId, { approved, launch } as any);
}

describe("dev3 agent resume", () => {
	it("resumes directly through the managed path when a person runs it, refusing live terminals and unknown ids", async () => {
		await expect(resumeCliAgent({ project, task, requester: null, allowAgentLatest: false })).resolves.toEqual({ outcome: "resumed", resume: resumed });
		expect(push).not.toHaveBeenCalled();
		expect(resumeTaskSession).toHaveBeenCalledWith(task.id, { refuseLive: true, refuseFresh: true, requireSessionIds: true });
	});

	it("lets the harness pick its latest only when asked to", async () => {
		await resumeCliAgent({ project, task, requester: null, allowAgentLatest: true });
		expect(resumeTaskSession).toHaveBeenCalledWith(task.id, { refuseLive: true, refuseFresh: true, requireSessionIds: false });
	});

	it("touches nothing and asks nobody when the terminal is already running", async () => {
		vi.mocked(taskTerminalAlive).mockResolvedValue(true);
		await expect(resumeCliAgent({ project, task, requester, allowAgentLatest: false })).resolves.toEqual({ outcome: "already-running", taskId: task.id, seq: 7, backend: "tmux" });
		expect(push).not.toHaveBeenCalled();
		expect(resumeTaskSession).not.toHaveBeenCalled();
	});

	it.each([
		["draft", { draft: true }],
		["not-active", { status: "todo" }],
		["no-worktree", { worktreePath: null }],
	])("refuses a %s task before asking", async (reason, patch) => {
		const outcome = await resumeCliAgent({ project, task: { ...task, ...patch } as Task, requester, allowAgentLatest: false });
		expect(outcome).toMatchObject({ outcome: "unavailable", reason });
		expect(push).not.toHaveBeenCalled();
		expect(resumeTaskSession).not.toHaveBeenCalled();
	});

	it("never falls back to a fresh session when nothing is saved", async () => {
		vi.mocked(sessionStateOrLostCodexPane).mockResolvedValue(null);
		await expect(resumeCliAgent({ project, task, requester, allowAgentLatest: false })).resolves.toMatchObject({ outcome: "unavailable", reason: "no-saved-session" });
		expect(resumeTaskSession).not.toHaveBeenCalled();
	});

	it("reports a pane with no conversation id instead of guessing", async () => {
		const report = [{ index: 0, mode: "agent-latest" }];
		vi.mocked(resumeTaskSession).mockRejectedValue(new (ResumeUnavailableError as any)("session-id-unknown", "No conversation id", report));
		await expect(resumeCliAgent({ project, task, requester: null, allowAgentLatest: false })).resolves.toEqual({
			outcome: "unavailable", taskId: task.id, seq: 7, reason: "session-id-unknown", message: "No conversation id", panes: report,
		});
	});

	it("asks another task's agent's request through the launch dialog with the saved panes and no agent choice", async () => {
		const pending = resumeCliAgent({ project, task, requester, allowAgentLatest: false });
		await answer(true, { variants: [{ agentId: "other", configId: "other" }] });
		await expect(pending).resolves.toEqual({ outcome: "resumed", resume: resumed });
		const request = push.mock.calls[0][1];
		expect(request).toMatchObject({ requesterSeq: 9, canAddVariants: false, resume: { panes: [
			{ agentId: "agent-1", configId: "config-1", sessionId: "s-main" },
			{ agentId: "agent-2", configId: "config-2", sessionId: "s-extra" },
		] } });
		expect(request.spawn).toBeUndefined();
		// The dialog's agent pick never reaches the resume.
		expect(resumeTaskSession).toHaveBeenCalledWith(task.id, { refuseLive: true, refuseFresh: true, requireSessionIds: true });
	});

	it("resumes nothing when declined, or when the run ended before an answer", async () => {
		const declined = resumeCliAgent({ project, task, requester, allowAgentLatest: false });
		await answer(false);
		await expect(declined).resolves.toEqual({ outcome: "declined", taskId: task.id, seq: 7 });
		push.mockClear();
		const voided = resumeCliAgent({ project, task, requester, allowAgentLatest: false });
		await vi.waitFor(() => expect(push).toHaveBeenCalled());
		voidAgentRequest("launch", task.id);
		await expect(voided).resolves.toEqual({ outcome: "declined", taskId: task.id, seq: 7, stale: true });
		expect(resumeTaskSession).not.toHaveBeenCalled();
	});

	it("re-checks after approval: a session resumed from the app meanwhile is left alone", async () => {
		const pending = resumeCliAgent({ project, task, requester, allowAgentLatest: false });
		await vi.waitFor(() => expect(push).toHaveBeenCalled());
		vi.mocked(taskTerminalAlive).mockResolvedValue(true);
		await answer(true);
		await expect(pending).resolves.toMatchObject({ outcome: "already-running" });
		expect(resumeTaskSession).not.toHaveBeenCalled();
	});

	it("refuses when the task's run changed while the dialog was open", async () => {
		const pending = resumeCliAgent({ project, task, requester, allowAgentLatest: false });
		vi.mocked(getTask).mockResolvedValue({ ...task, lifecycleStartedAt: "start-2" });
		await answer(true);
		await expect(pending).rejects.toThrow("run changed");
		expect(resumeTaskSession).not.toHaveBeenCalled();
	});

	it("joins a retry to the pending request: one dialog, one resume", async () => {
		const first = resumeCliAgent({ project, task, requester, allowAgentLatest: false });
		const retry = resumeCliAgent({ project, task, requester, allowAgentLatest: false });
		await answer(true);
		await expect(Promise.all([first, retry])).resolves.toHaveLength(2);
		expect(push.mock.calls.filter(([event]) => event === "agentLaunchRequested")).toHaveLength(1);
		expect(resumeTaskSession).toHaveBeenCalledTimes(1);
	});

	it("rejects a differing concurrent request instead of joining it", async () => {
		const first = resumeCliAgent({ project, task, requester, allowAgentLatest: false });
		await expect(resumeCliAgent({ project, task, requester, allowAgentLatest: true })).rejects.toThrow("Another resume request is pending");
		await answer(false); await first;
	});

	it("does not hijack another pending launch approval for the task", async () => {
		createAgentRequest("launch", task.id, project.id);
		await expect(resumeCliAgent({ project, task, requester, allowAgentLatest: false })).rejects.toThrow("Another launch approval is pending");
	});

	it("cannot ask without a connected app window", async () => {
		vi.mocked(getPushMessage).mockReturnValue(null as any);
		await expect(resumeCliAgent({ project, task, requester, allowAgentLatest: false })).rejects.toThrow("No app window is connected");
		expect(resumeTaskSession).not.toHaveBeenCalled();
	});
});
