import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Task, Project } from "../../../shared/types";

vi.mock("../../rpc", () => ({
	api: { request: { getBranchStatus: vi.fn() } },
}));
vi.mock("../../confirm", () => ({
	confirm: vi.fn().mockResolvedValue(true),
}));

import { confirmTaskCompletion } from "../confirmTaskCompletion";
import { api } from "../../rpc";
import { confirm } from "../../confirm";

const mockedBranchStatus = vi.mocked(api.request.getBranchStatus);
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
});
