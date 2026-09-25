import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Project, Task } from "../../../shared/types";

vi.mock("../../rpc", () => ({
	api: { request: { moveTask: vi.fn(), resetTaskToTodo: vi.fn() } },
}));
vi.mock("../../toast", () => ({ toast: { error: vi.fn(), info: vi.fn() } }));
vi.mock("../../analytics", () => ({ trackEvent: vi.fn(), agentNameFromId: vi.fn(() => "unknown") }));
vi.mock("../../posthog", () => ({ default: { capture: vi.fn() } }));
vi.mock("../confirmTaskCompletion", () => ({ confirmTaskCompletion: vi.fn().mockResolvedValue(true) }));
vi.mock("../confirmTaskReset", () => ({ confirmTaskReset: vi.fn() }));
vi.mock("../../task-sounds", () => ({ playTaskCompletionSound: vi.fn(() => true) }));

import { LAUNCH_REQUESTED_EVENT, moveTaskToStatus } from "../moveTaskToStatus";
import { api } from "../../rpc";
import { toast } from "../../toast";
import { confirmTaskReset } from "../confirmTaskReset";

const STARTED = "2026-09-25T10:00:00.000Z";
const running = { id: "t1", projectId: "p1", status: "review-by-user", worktreePath: "/wt", lifecycleStartedAt: STARTED } as Task;
const project = { id: "p1", name: "P", path: "/p" } as Project;
const t = ((key: string) => key) as never;
const consent = { worktreePath: "/wt", lifecycleStartedAt: STARTED };

describe("moveTaskToStatus → To Do on a task with a run (T16)", () => {
	beforeEach(() => {
		vi.mocked(confirmTaskReset).mockResolvedValue(consent);
		vi.mocked(api.request.resetTaskToTodo).mockResolvedValue({ task: { ...running, status: "todo", worktreePath: null } as Task, keptBranches: [] });
	});
	afterEach(() => vi.clearAllMocks());

	it("decline changes nothing: no optimistic update, no RPC", async () => {
		vi.mocked(confirmTaskReset).mockResolvedValue(null);
		const dispatch = vi.fn();
		expect(await moveTaskToStatus({ task: running, project, newStatus: "todo", dispatch, t })).toBe(false);
		expect(dispatch).not.toHaveBeenCalled();
		expect(api.request.resetTaskToTodo).not.toHaveBeenCalled();
		expect(api.request.moveTask).not.toHaveBeenCalled();
	});

	it("approve sends the dialog's consent to resetTaskToTodo — never a plain moveTask", async () => {
		const dispatch = vi.fn();
		expect(await moveTaskToStatus({ task: running, project, newStatus: "todo", dispatch, t })).toBe(true);
		expect(api.request.resetTaskToTodo).toHaveBeenCalledTimes(1);
		expect(api.request.resetTaskToTodo).toHaveBeenCalledWith({ taskId: "t1", projectId: "p1", consent });
		expect(api.request.moveTask).not.toHaveBeenCalled();
	});

	it("a refused reset is NOT retried with force, reverts, and says so", async () => {
		vi.mocked(api.request.resetTaskToTodo).mockRejectedValue(new Error("stale"));
		const dispatch = vi.fn();
		await moveTaskToStatus({ task: running, project, newStatus: "todo", dispatch, t });
		expect(api.request.resetTaskToTodo).toHaveBeenCalledTimes(1);
		expect(api.request.moveTask).not.toHaveBeenCalled();
		expect(dispatch).toHaveBeenLastCalledWith({ type: "updateTask", task: running });
		expect(toast.error).toHaveBeenCalledWith("task.resetFailed", { taskId: "t1" });
	});

	it("a legacy To Do card that still owns a worktree asks too", async () => {
		const legacy = { ...running, status: "todo", customColumnId: "col" } as Task;
		await moveTaskToStatus({ task: legacy, project, newStatus: "todo", dispatch: vi.fn(), t });
		expect(confirmTaskReset).toHaveBeenCalled();
	});

	it("a clean card (completed → To Do) stays a plain move with no dialog", async () => {
		const done = { ...running, status: "completed", worktreePath: null } as Task;
		vi.mocked(api.request.moveTask).mockResolvedValue({ ...done, status: "todo" } as Task);
		await moveTaskToStatus({ task: done, project, newStatus: "todo", dispatch: vi.fn(), t });
		expect(confirmTaskReset).not.toHaveBeenCalled();
		expect(api.request.moveTask).toHaveBeenCalledWith(expect.objectContaining({ newStatus: "todo" }));
	});
});

// R1: a To Do card is started through the launch dialog, never a bare move the
// lifecycle would refuse (context menu, native menu, info panel all land here).
describe("moveTaskToStatus → an active column on a To Do card (R1)", () => {
	afterEach(() => vi.clearAllMocks());
	const clean = { id: "t2", projectId: "p1", status: "todo", worktreePath: null } as Task;

	const listeners: Array<(e: Event) => void> = [];
	afterEach(() => { for (const l of listeners.splice(0)) window.removeEventListener(LAUNCH_REQUESTED_EVENT, l); });
	function captureLaunch(): ReturnType<typeof vi.fn> {
		const listener = vi.fn();
		window.addEventListener(LAUNCH_REQUESTED_EVENT, listener);
		listeners.push(listener);
		return listener;
	}

	it("opens the launch dialog, sends no moveTask", async () => {
		const listener = captureLaunch();
		expect(await moveTaskToStatus({ task: clean, project, newStatus: "in-progress", dispatch: vi.fn(), t })).toBe(true);
		expect(api.request.moveTask).not.toHaveBeenCalled();
		expect((listener.mock.calls[0]![0] as CustomEvent).detail).toEqual({ task: clean, project, targetStatus: "in-progress" });
	});

	it("a legacy card that owns a worktree is reset (with consent) before the dialog opens", async () => {
		const listener = captureLaunch();
		vi.mocked(confirmTaskReset).mockResolvedValue({ worktreePath: "/wt", lifecycleStartedAt: null });
		vi.mocked(api.request.resetTaskToTodo).mockResolvedValue({ task: { ...clean, id: "t3" }, keptBranches: [] });
		const legacy = { ...clean, id: "t3", worktreePath: "/wt", branchName: "dev3/task-t3" } as Task;
		await moveTaskToStatus({ task: legacy, project, newStatus: "in-progress", dispatch: vi.fn(), t });
		expect(api.request.resetTaskToTodo).toHaveBeenCalledTimes(1);
		expect((listener.mock.calls[0]![0] as CustomEvent).detail.task).toMatchObject({ id: "t3", worktreePath: null, branchName: null });
	});

	it("declining that reset opens nothing", async () => {
		const listener = captureLaunch();
		vi.mocked(confirmTaskReset).mockResolvedValue(null);
		const legacy = { ...clean, id: "t4", worktreePath: "/wt" } as Task;
		expect(await moveTaskToStatus({ task: legacy, project, newStatus: "in-progress", dispatch: vi.fn(), t })).toBe(false);
		expect(listener).not.toHaveBeenCalled();
	});
});

describe("reset feedback", () => {
	afterEach(() => vi.clearAllMocks());
	it("tells the user about a branch the reset kept", async () => {
		vi.mocked(confirmTaskReset).mockResolvedValue(consent);
		vi.mocked(api.request.resetTaskToTodo).mockResolvedValue({
			task: { ...running, status: "todo", worktreePath: null } as Task,
			keptBranches: [{ name: "release/2.0", reason: "not-owned" }],
		});
		await moveTaskToStatus({ task: running, project, newStatus: "todo", dispatch: vi.fn(), t });
		expect(toast.info).toHaveBeenCalledWith("task.resetKeptBranches", { taskId: "t1" });
	});
});
