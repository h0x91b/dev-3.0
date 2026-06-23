import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Task, Project, TaskStatus } from "../../../shared/types";

vi.mock("../../rpc", () => ({
	api: { request: { moveTask: vi.fn() } },
}));
vi.mock("../../toast", () => ({
	toast: { error: vi.fn() },
}));
vi.mock("../../analytics", () => ({
	trackEvent: vi.fn(),
	agentNameFromId: vi.fn(() => "unknown"),
}));
vi.mock("../confirmTaskCompletion", () => ({
	confirmTaskCompletion: vi.fn().mockResolvedValue(true),
}));
vi.mock("../../task-sounds", () => ({
	playTaskCompletionSound: vi.fn(),
}));

import { moveTaskToStatus } from "../moveTaskToStatus";
import { api } from "../../rpc";
import { toast } from "../../toast";
import { confirmTaskCompletion } from "../confirmTaskCompletion";
import { playTaskCompletionSound } from "../../task-sounds";

const mockedMoveTask = vi.mocked(api.request.moveTask);
const mockedConfirm = vi.mocked(confirmTaskCompletion);
const mockedToastError = vi.mocked(toast.error);
const mockedSound = vi.mocked(playTaskCompletionSound);

const task = { id: "t1", projectId: "p1", status: "in-progress", worktreePath: "/wt" } as Task;
const project = { id: "p1", name: "P", path: "/p" } as Project;
const t = ((key: string) => key) as never;

function dispatchedStatuses(dispatch: ReturnType<typeof vi.fn>): TaskStatus[] {
	return dispatch.mock.calls
		.filter((c) => (c[0] as { type: string }).type === "updateTask")
		.map((c) => (c[0] as { task: Task }).task.status);
}

describe("moveTaskToStatus", () => {
	beforeEach(() => {
		mockedMoveTask.mockResolvedValue({ ...task, status: "completed" } as Task);
		mockedConfirm.mockResolvedValue(true);
	});
	afterEach(() => vi.clearAllMocks());

	it("optimistically completes, plays the sound instantly, then confirms with the server", async () => {
		const dispatch = vi.fn();
		const ok = await moveTaskToStatus({ task, project, newStatus: "completed", dispatch, t });

		expect(ok).toBe(true);
		// Sound fires before the RPC resolves (instant feedback), keyed by task id.
		expect(mockedSound).toHaveBeenCalledWith("completed", "t1");
		// Optimistic + clearBell + server-confirmed update.
		expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: "clearBell", taskId: "t1" }));
		expect(dispatchedStatuses(dispatch)).toEqual(["completed", "completed"]);
		expect(mockedMoveTask).toHaveBeenCalledWith({ taskId: "t1", projectId: "p1", newStatus: "completed" });
	});

	it("aborts without any change when the confirmation is declined", async () => {
		mockedConfirm.mockResolvedValue(false);
		const dispatch = vi.fn();
		const ok = await moveTaskToStatus({ task, project, newStatus: "completed", dispatch, t });

		expect(ok).toBe(false);
		expect(dispatch).not.toHaveBeenCalled();
		expect(mockedSound).not.toHaveBeenCalled();
		expect(mockedMoveTask).not.toHaveBeenCalled();
	});

	it("does not play a sound for non-terminal moves", async () => {
		const dispatch = vi.fn();
		await moveTaskToStatus({ task, project, newStatus: "review-by-user", dispatch, t });
		expect(mockedSound).not.toHaveBeenCalled();
	});

	it("retries with force when the normal move fails", async () => {
		mockedMoveTask
			.mockRejectedValueOnce(new Error("boom"))
			.mockResolvedValueOnce({ ...task, status: "completed" } as Task);
		const dispatch = vi.fn();
		await moveTaskToStatus({ task, project, newStatus: "completed", dispatch, t });

		expect(mockedMoveTask).toHaveBeenNthCalledWith(1, { taskId: "t1", projectId: "p1", newStatus: "completed" });
		expect(mockedMoveTask).toHaveBeenNthCalledWith(2, { taskId: "t1", projectId: "p1", newStatus: "completed", force: true });
		expect(mockedToastError).not.toHaveBeenCalled();
	});

	it("reverts and toasts when both attempts fail (revertOnFailure default)", async () => {
		mockedMoveTask.mockRejectedValue(new Error("boom"));
		const dispatch = vi.fn();
		await moveTaskToStatus({ task, project, newStatus: "completed", dispatch, t });

		// last updateTask reverts to the original status.
		const statuses = dispatchedStatuses(dispatch);
		expect(statuses[statuses.length - 1]).toBe("in-progress");
		expect(mockedToastError).toHaveBeenCalled();
	});

	it("runs onSuccess only after the server confirms the move", async () => {
		const dispatch = vi.fn();
		const onSuccess = vi.fn();
		await moveTaskToStatus({ task, project, newStatus: "review-by-user", dispatch, t, onSuccess });
		expect(onSuccess).toHaveBeenCalledTimes(1);
	});

	it("does not run onSuccess when both move attempts fail", async () => {
		mockedMoveTask.mockRejectedValue(new Error("boom"));
		const dispatch = vi.fn();
		const onSuccess = vi.fn();
		await moveTaskToStatus({ task, project, newStatus: "review-by-user", dispatch, t, onSuccess });
		expect(onSuccess).not.toHaveBeenCalled();
	});

	it("keeps the optimistic state on failure when revertOnFailure is false", async () => {
		mockedMoveTask.mockRejectedValue(new Error("boom"));
		const consoleErr = vi.spyOn(console, "error").mockImplementation(() => {});
		const dispatch = vi.fn();
		await moveTaskToStatus({ task, project, newStatus: "completed", dispatch, t, revertOnFailure: false });

		// No revert back to the original status.
		expect(dispatchedStatuses(dispatch)).toEqual(["completed"]);
		expect(mockedToastError).not.toHaveBeenCalled();
		expect(consoleErr).toHaveBeenCalled();
		consoleErr.mockRestore();
	});
});
