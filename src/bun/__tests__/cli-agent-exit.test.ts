import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Project, Task } from "../../shared/types";
import { MAIN_AGENT_EXIT_MESSAGE } from "../../shared/agent-exit";
import { encodeAgentHandle } from "../../shared/agent-handle";

vi.mock("../settings", () => ({ loadSettings: vi.fn(async () => ({ agentLaunchAutoApproveMinutes: 5 })), loadSettingsSync: vi.fn(() => ({})) }));
vi.mock("../data", () => ({ getTask: vi.fn() }));
vi.mock("../rpc-handlers/shared-pure", () => ({ getPushMessage: vi.fn() }));
vi.mock("../agent-message-target", () => ({ agentPaneRoles: vi.fn() }));
vi.mock("../agent-graceful-exit", () => ({ resolveAgentExitTargets: vi.fn() }));
vi.mock("../scheduled-message-author", () => ({
	AGENT_IDENTITY_UNSUPPORTED_DETAIL: "agent identity cannot be verified on Windows yet",
	resolveScheduledMessageAuthorPane: vi.fn(),
}));
vi.mock("../extra-agent-exit", () => ({
	extraAgentLabel: vi.fn(async () => "Codex / High"),
	isExtraAgentExitScheduled: vi.fn(() => false),
	scheduleExtraAgentExit: vi.fn(() => ({ scheduled: true, already: false })),
}));
import { exitCliAgent } from "../cli-agent-exit";
import { getTask } from "../data";
import { getPushMessage } from "../rpc-handlers/shared-pure";
import { agentPaneRoles } from "../agent-message-target";
import { resolveAgentExitTargets } from "../agent-graceful-exit";
import { resolveScheduledMessageAuthorPane } from "../scheduled-message-author";
import { isExtraAgentExitScheduled, scheduleExtraAgentExit } from "../extra-agent-exit";
import { loadSettings } from "../settings";
import { _resetAgentRequestsForTests, resolveAgentRequest, voidAgentRequest } from "../agent-requests";

const project = { id: "project-1", name: "Fixture", path: "/repo" } as Project;
const task = { id: "task-1", projectId: project.id, seq: 7, title: "Fixture task", status: "in-progress", worktreePath: "/repo/wt", lifecycleStartedAt: "start-1" } as Task;
const requester = { ...task, id: "task-2", seq: 9, title: "Coordinator" } as Task;
const entry = { paneId: "%2", agentCmd: "codex", agentId: "builtin-codex", configId: "codex-high", sessionId: "s-extra" };
const push = vi.fn();

const exit = (overrides: Partial<Parameters<typeof exitCliAgent>[0]> = {}) =>
	exitCliAgent({ project, task, requester: task, selfPaneId: "%2", agentHandle: null, ...overrides });

async function answer(approved: boolean) {
	await vi.waitFor(() => expect(push).toHaveBeenCalledWith("agentLaunchRequested", expect.anything()));
	resolveAgentRequest(push.mock.calls[0][1].requestId, { approved });
}

beforeEach(() => {
	vi.clearAllMocks(); _resetAgentRequestsForTests();
	vi.mocked(getPushMessage).mockReturnValue(push);
	vi.mocked(getTask).mockResolvedValue(task);
	vi.mocked(agentPaneRoles).mockResolvedValue(new Map([["%1", "main"], ["%2", "agent"], ["%3", "review"]]));
	vi.mocked(resolveAgentExitTargets).mockResolvedValue([{ paneId: "%2", rootPid: 1, entry } as never]);
	vi.mocked(isExtraAgentExitScheduled).mockReturnValue(false);
	vi.mocked(loadSettings).mockResolvedValue({ agentLaunchAutoApproveMinutes: 5 } as never);
});
afterEach(() => _resetAgentRequestsForTests());

describe("dev3 agent exit — who may be closed", () => {
	it("refuses the main agent with the way to finish a task", async () => {
		await expect(exit({ selfPaneId: "%1" })).resolves.toEqual({ outcome: "refused", reason: "main-agent", message: MAIN_AGENT_EXIT_MESSAGE });
		expect(push).not.toHaveBeenCalled();
		expect(scheduleExtraAgentExit).not.toHaveBeenCalled();
	});

	it("refuses the AI Review agent, a plain pane, a pane that is not an agent, and a shell with no pane id", async () => {
		const cases: Array<[string | null, string]> = [["%3", "AI Review agent"], ["%9", "not an agent pane"], [null, "no pane id"]];
		for (const [selfPaneId, text] of cases) {
			const outcome = await exit({ selfPaneId });
			expect(outcome, String(selfPaneId)).toMatchObject({ outcome: "refused", reason: "not-extra", message: expect.stringContaining(text) });
			expect((outcome as { message: string }).message).toContain("only closes extra agents");
		}
		expect(push).not.toHaveBeenCalled();
		expect(scheduleExtraAgentExit).not.toHaveBeenCalled();
	});

	it("refuses an extra agent whose process is already gone", async () => {
		vi.mocked(resolveAgentExitTargets).mockResolvedValue([]);
		await expect(exit()).resolves.toMatchObject({ outcome: "refused", reason: "not-extra", message: expect.stringContaining("no longer running") });
	});
});

describe("dev3 agent exit --agent <handle>", () => {
	const author = { paneId: "%2", sessionId: null, paneToken: "token", agentProcess: "77@Mon Jan 1 00:00:00 2024" };
	const handle = encodeAgentHandle(author);

	it("finds the pane through the handle and closes that agent, not the caller's pane", async () => {
		vi.mocked(resolveScheduledMessageAuthorPane).mockResolvedValue({ ok: true, paneId: "%2" });
		const pending = exit({ requester, selfPaneId: "%1", agentHandle: handle });
		await answer(true);
		await expect(pending).resolves.toEqual({ outcome: "scheduled", taskId: task.id, seq: 7, paneId: "%2", agent: "Codex / High", self: false, already: false });
		expect(scheduleExtraAgentExit).toHaveBeenCalledWith(task, "%2", { self: false });
		expect(push.mock.calls[0][1]).toMatchObject({ requesterSeq: 9, sessionAction: { kind: "close-agent", paneId: "%2" } });
	});

	it("refuses a handle that is malformed, gone, or names the main agent", async () => {
		await expect(exit({ agentHandle: "nonsense!" })).resolves.toMatchObject({ outcome: "refused", reason: "not-extra", message: expect.stringContaining("not an agent handle") });
		vi.mocked(resolveScheduledMessageAuthorPane).mockResolvedValueOnce({ ok: false, detail: "the addressed agent is no longer running" });
		await expect(exit({ agentHandle: handle })).resolves.toMatchObject({ outcome: "refused", reason: "not-extra", message: expect.stringContaining("no longer running") });
		vi.mocked(resolveScheduledMessageAuthorPane).mockResolvedValueOnce({ ok: true, paneId: "%1" });
		await expect(exit({ agentHandle: handle })).resolves.toMatchObject({ outcome: "refused", reason: "main-agent" });
		expect(scheduleExtraAgentExit).not.toHaveBeenCalled();
	});
});

describe("dev3 agent exit — confirmation", () => {
	it("asks through the launch dialog with the agent's label, pane and --reason, then schedules a self exit", async () => {
		const reason = { text: "Review is finished." };
		const pending = exit({ reason });
		await vi.waitFor(() => expect(push).toHaveBeenCalledWith("agentLaunchRequested", expect.anything()));
		const request = push.mock.calls[0][1];
		expect(request).toMatchObject({ taskId: task.id, requesterSeq: 7, canAddVariants: false, reason, sessionAction: { kind: "close-agent", paneId: "%2", agentLabel: "Codex / High" } });
		expect(request.autoApproveAt).toBeGreaterThan(Date.now());
		expect(scheduleExtraAgentExit).not.toHaveBeenCalled();
		await answer(true);
		await expect(pending).resolves.toEqual({ outcome: "scheduled", taskId: task.id, seq: 7, paneId: "%2", agent: "Codex / High", self: true, already: false });
		expect(scheduleExtraAgentExit).toHaveBeenCalledWith(task, "%2", { self: true });
	});

	it("does not ask when the setting is off", async () => {
		vi.mocked(loadSettings).mockResolvedValue({ confirmExtraAgentClose: false } as never);
		await expect(exit()).resolves.toMatchObject({ outcome: "scheduled", already: false });
		expect(push).not.toHaveBeenCalled();
		expect(scheduleExtraAgentExit).toHaveBeenCalledTimes(1);
	});

	it("asks when the setting was never stored", async () => {
		vi.mocked(loadSettings).mockResolvedValue({} as never);
		const pending = exit();
		await answer(true);
		await expect(pending).resolves.toMatchObject({ outcome: "scheduled" });
	});

	it("acts directly, with no dialog, when a person runs it from a plain terminal", async () => {
		await expect(exit({ requester: null })).resolves.toMatchObject({ outcome: "scheduled", self: false });
		expect(push).not.toHaveBeenCalled();
	});

	it("schedules nothing when declined, or when the run ended before an answer", async () => {
		const declined = exit();
		await answer(false);
		await expect(declined).resolves.toEqual({ outcome: "declined", taskId: task.id, seq: 7 });
		push.mockClear();
		const voided = exit();
		await vi.waitFor(() => expect(push).toHaveBeenCalled());
		voidAgentRequest("launch", task.id);
		await expect(voided).resolves.toEqual({ outcome: "declined", taskId: task.id, seq: 7, stale: true });
		expect(scheduleExtraAgentExit).not.toHaveBeenCalled();
	});

	it("never asks again for a pane whose exit is already scheduled", async () => {
		vi.mocked(isExtraAgentExitScheduled).mockReturnValue(true);
		await expect(exit()).resolves.toMatchObject({ outcome: "scheduled", paneId: "%2", already: true });
		expect(push).not.toHaveBeenCalled();
		expect(scheduleExtraAgentExit).not.toHaveBeenCalled();
	});

	it("reports an exit that another call scheduled while the dialog was open as already scheduled", async () => {
		vi.mocked(scheduleExtraAgentExit).mockReturnValue({ scheduled: true, already: true });
		const pending = exit();
		await answer(true);
		await expect(pending).resolves.toMatchObject({ outcome: "scheduled", already: true });
	});

	it("joins a retry of the same request instead of opening a second dialog", async () => {
		const first = exit();
		const retry = exit();
		await answer(true);
		await expect(first).resolves.toMatchObject({ outcome: "scheduled" });
		await expect(retry).resolves.toMatchObject({ outcome: "scheduled" });
		expect(push.mock.calls.filter(([event]) => event === "agentLaunchRequested")).toHaveLength(1);
		expect(scheduleExtraAgentExit).toHaveBeenCalledTimes(1);
	});
});
