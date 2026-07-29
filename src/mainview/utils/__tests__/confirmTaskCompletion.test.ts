import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Task, Project } from "../../../shared/types";

vi.mock("../../rpc", () => ({
	api: { request: { getBranchStatus: vi.fn(), getUnsavedWork: vi.fn() } },
}));
vi.mock("../../confirm", () => ({
	confirm: vi.fn().mockResolvedValue(true),
}));

import { confirmTaskCompletion } from "../confirmTaskCompletion";
import { api } from "../../rpc";
import { confirm } from "../../confirm";

const mockedBranchStatus = vi.mocked(api.request.getBranchStatus);
const mockedUnsavedWork = vi.mocked(api.request.getUnsavedWork);
const mockedConfirm = vi.mocked(confirm);

const t = ((key: string) => key) as never;

const baseTask = {
	id: "t1",
	seq: 1,
	projectId: "p1",
	status: "in-progress",
	worktreePath: "/wt",
	title: "Auto generated title",
	overview: "Agent overview line",
} as Task;
const project = { id: "p1", name: "P", path: "/p" } as Project;

const dirtyStatus = {
	insertions: 0,
	deletions: 408381,
	unpushed: 0,
	ahead: 0,
	mergedByContent: false,
} as Awaited<ReturnType<typeof api.request.getBranchStatus>>;

describe("confirmTaskCompletion", () => {
	beforeEach(() => {
		mockedBranchStatus.mockResolvedValue(dirtyStatus);
		mockedUnsavedWork.mockResolvedValue(dirtyStatus);
		mockedConfirm.mockResolvedValue(true);
	});
	afterEach(() => vi.clearAllMocks());

	it("passes the task title + overview as the info card so the user knows which task is deleted", async () => {
		await confirmTaskCompletion(baseTask, project, "completed", t);

		expect(mockedConfirm).toHaveBeenCalledWith(
			expect.objectContaining({
				info: expect.objectContaining({ title: "Auto generated title", body: "Agent overview line" }),
			}),
		);
	});

	it("includes the project/seq/priority context in the info card", async () => {
		await confirmTaskCompletion(baseTask, project, "completed", t);

		expect(mockedConfirm).toHaveBeenCalledWith(
			expect.objectContaining({
				info: expect.objectContaining({ seqLabel: "1", projectName: "P", priority: "P3", labels: [] }),
			}),
		);
	});

	it("makes the task title openable from the confirmation dialog", async () => {
		const onOpenTask = vi.fn();
		await confirmTaskCompletion(baseTask, project, "completed", t, onOpenTask);

		expect(mockedConfirm).toHaveBeenCalledWith(
			expect.objectContaining({
				info: expect.objectContaining({ onClick: onOpenTask }),
			}),
		);
	});

	it("prefers the user-edited title/overview overrides in the info card", async () => {
		const task = {
			...baseTask,
			customTitle: "Custom title",
			userOverview: "User overview",
		} as Task;
		await confirmTaskCompletion(task, project, "cancelled", t);

		expect(mockedConfirm).toHaveBeenCalledWith(
			expect.objectContaining({
				info: expect.objectContaining({ title: "Custom title", body: "User overview" }),
			}),
		);
	});

	it("omits the info body when the task has no overview", async () => {
		const task = { ...baseTask, overview: null } as Task;
		await confirmTaskCompletion(task, project, "completed", t);

		expect(mockedConfirm).toHaveBeenCalledWith(
			expect.objectContaining({
				info: expect.objectContaining({ title: "Auto generated title", body: undefined }),
			}),
		);
	});

	it("skips the check entirely for PR-review tasks (existing branch is not the user's work)", async () => {
		const task = { ...baseTask, existingBranch: "feature/someone-else" } as Task;

		const ok = await confirmTaskCompletion(task, project, "completed", t);

		expect(ok).toBe(true);
		expect(mockedBranchStatus).not.toHaveBeenCalled();
		expect(mockedConfirm).not.toHaveBeenCalled();
	});

	it("does not prompt (and renders no card) when there are no warnings", async () => {
		mockedBranchStatus.mockResolvedValue({
			insertions: 0,
			deletions: 0,
			unpushed: 0,
			ahead: 0,
			mergedByContent: false,
		} as Awaited<ReturnType<typeof api.request.getBranchStatus>>);

		const ok = await confirmTaskCompletion(baseTask, project, "completed", t);

		expect(ok).toBe(true);
		expect(mockedConfirm).not.toHaveBeenCalled();
	});

	describe("alwaysConfirm (one-click quick-complete)", () => {
		const cleanStatus = {
			insertions: 0,
			deletions: 0,
			unpushed: 0,
			ahead: 0,
			mergedByContent: false,
		} as Awaited<ReturnType<typeof api.request.getUnsavedWork>>;

		it("prompts on a clean branch, where the plain call stays silent", async () => {
			mockedUnsavedWork.mockResolvedValue(cleanStatus);

			await confirmTaskCompletion(baseTask, project, "completed", t, undefined, { alwaysConfirm: true });

			expect(mockedConfirm).toHaveBeenCalledWith(
				expect.objectContaining({ title: "task.confirmCompleteTitle", message: "task.warnCompletionFooter" }),
			);
		});

		it("opens the dialog without waiting on the branch check", async () => {
			let releaseUnsavedWork: (status: typeof cleanStatus) => void = () => {};
			mockedUnsavedWork.mockReturnValue(
				new Promise((resolve) => { releaseUnsavedWork = resolve; }) as ReturnType<typeof api.request.getUnsavedWork>,
			);

			void confirmTaskCompletion(baseTask, project, "completed", t, undefined, { alwaysConfirm: true });
			await Promise.resolve();

			// Dialog is already up while the check is still in flight.
			expect(mockedConfirm).toHaveBeenCalledTimes(1);
			const options = mockedConfirm.mock.calls[0]![0];
			expect(options.deferred).toEqual(
				expect.objectContaining({ pending: "task.checkingBranchState", gateConfirm: true }),
			);

			releaseUnsavedWork(dirtyStatus);
			await expect(options.deferred!.promise).resolves.toContain("task.warnUncommitted");
		});

		it("never calls the fetch-heavy getBranchStatus — that is what made it take seconds", async () => {
			mockedUnsavedWork.mockResolvedValue(cleanStatus);

			await confirmTaskCompletion(baseTask, project, "completed", t, undefined, { alwaysConfirm: true });

			expect(mockedUnsavedWork).toHaveBeenCalledWith({ taskId: "t1", projectId: "p1" });
			expect(mockedBranchStatus).not.toHaveBeenCalled();
		});

		it("omits the pushed-but-unmerged line — that work is safe on the remote", async () => {
			mockedUnsavedWork.mockResolvedValue({
				insertions: 0,
				deletions: 0,
				unpushed: 0,
				ahead: 3,
			} as Awaited<ReturnType<typeof api.request.getUnsavedWork>>);

			await confirmTaskCompletion(baseTask, project, "completed", t, undefined, { alwaysConfirm: true });

			const options = mockedConfirm.mock.calls[0]![0];
			await expect(options.deferred!.promise).resolves.toBeNull();
		});

		it("resolves the deferred block to null on a clean branch so no warning renders", async () => {
			mockedUnsavedWork.mockResolvedValue(cleanStatus);

			await confirmTaskCompletion(baseTask, project, "completed", t, undefined, { alwaysConfirm: true });

			const options = mockedConfirm.mock.calls[0]![0];
			await expect(options.deferred!.promise).resolves.toBeNull();
		});

		it("prompts for a task with no worktree at all", async () => {
			const task = { ...baseTask, worktreePath: null } as Task;

			await confirmTaskCompletion(task, project, "completed", t, undefined, { alwaysConfirm: true });

			expect(mockedUnsavedWork).not.toHaveBeenCalled();
			expect(mockedConfirm).toHaveBeenCalledWith(
				expect.objectContaining({ title: "task.confirmCompleteTitle", message: "task.confirmCompleteFooter" }),
			);
		});

		it("folds git warnings into the same single dialog instead of asking twice", async () => {
			await confirmTaskCompletion(baseTask, project, "completed", t, undefined, { alwaysConfirm: true });

			expect(mockedConfirm).toHaveBeenCalledTimes(1);
			const options = mockedConfirm.mock.calls[0]![0];
			await expect(options.deferred!.promise).resolves.toContain("task.warnUncommitted");
		});

		it("aborts the move when the user declines", async () => {
			mockedUnsavedWork.mockResolvedValue(cleanStatus);
			mockedConfirm.mockResolvedValue(false);

			const ok = await confirmTaskCompletion(baseTask, project, "completed", t, undefined, { alwaysConfirm: true });

			expect(ok).toBe(false);
		});
	});
});
