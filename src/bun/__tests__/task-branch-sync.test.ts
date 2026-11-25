import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Project, Task } from "../../shared/types";

vi.mock("../data", () => ({
	updateTask: vi.fn(),
}));

vi.mock("../git", () => ({
	getCurrentBranch: vi.fn(),
}));

vi.mock("../rpc-handlers/shared-pure", () => ({
	getPushMessage: vi.fn(() => null),
}));

vi.mock("../logger", () => ({
	createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

vi.mock("node:fs", () => ({
	existsSync: vi.fn(() => true),
}));

import * as data from "../data";
import * as git from "../git";
import { getPushMessage } from "../rpc-handlers/shared-pure";
import { existsSync } from "node:fs";
import { syncTaskBranchName } from "../task-branch-sync";

function makeProject(overrides?: Partial<Project>): Project {
	return {
		id: "proj-1",
		name: "Test Project",
		path: "/tmp/test-project",
		setupScript: "",
		devScript: "",
		cleanupScript: "",
		defaultBaseBranch: "main",
		createdAt: new Date().toISOString(),
		...overrides,
	};
}

function makeTask(overrides?: Partial<Task>): Task {
	return {
		id: "task-1",
		seq: 1,
		projectId: "proj-1",
		title: "Test task",
		description: "A test task",
		status: "in-progress",
		baseBranch: "main",
		worktreePath: "/tmp/wt",
		branchName: "dev3/task-abc12345",
		groupId: null,
		variantIndex: null,
		agentId: null,
		configId: null,
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
		...overrides,
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	vi.mocked(existsSync).mockReturnValue(true);
	vi.mocked(getPushMessage).mockReturnValue(null);
	vi.mocked(data.updateTask).mockImplementation(
		async (_project, _taskId, updates) => ({ ...makeTask(), ...updates }) as Task,
	);
});

describe("syncTaskBranchName", () => {
	it("persists the live branch when the worktree was renamed out of band, and broadcasts taskUpdated", async () => {
		const push = vi.fn();
		vi.mocked(getPushMessage).mockReturnValue(push);
		vi.mocked(git.getCurrentBranch).mockResolvedValue("chore/dev3-example");

		const project = makeProject();
		const result = await syncTaskBranchName(project, makeTask());

		expect(data.updateTask).toHaveBeenCalledWith(project, "task-1", { branchName: "chore/dev3-example" });
		expect(result.branchName).toBe("chore/dev3-example");
		expect(push).toHaveBeenCalledWith("taskUpdated", expect.objectContaining({ projectId: "proj-1" }));
	});

	it("does not write when the live branch already matches, or on a detached HEAD", async () => {
		vi.mocked(git.getCurrentBranch).mockResolvedValue("dev3/task-abc12345");
		const task = makeTask();
		expect(await syncTaskBranchName(makeProject(), task)).toBe(task);

		vi.mocked(git.getCurrentBranch).mockResolvedValue(null);
		await syncTaskBranchName(makeProject(), makeTask());

		expect(data.updateTask).not.toHaveBeenCalled();
	});

	it("never asks git for a task without a worktree, a vanished worktree dir, or a virtual project", async () => {
		const result = await syncTaskBranchName(makeProject(), makeTask({ worktreePath: null }));
		expect(result.branchName).toBe("dev3/task-abc12345");

		await syncTaskBranchName(makeProject({ kind: "virtual" }), makeTask());

		vi.mocked(existsSync).mockReturnValue(false);
		await syncTaskBranchName(makeProject(), makeTask());

		expect(git.getCurrentBranch).not.toHaveBeenCalled();
		expect(data.updateTask).not.toHaveBeenCalled();
	});

	it("pins the comparison base when a review task's branch is renamed", async () => {
		// PR-review task: baseBranch is the reviewed branch, and the guard in
		// resolveTaskCompareBaseBranch recognised it only while branchName matched.
		// After the rename the review branch would leak through as the base.
		vi.mocked(git.getCurrentBranch).mockResolvedValue("fix/dev3-underline-flicker");

		const project = makeProject();
		const task = makeTask({
			baseBranch: "arditti/feat/dev3-file-path-open",
			existingBranch: "arditti/feat/dev3-file-path-open",
			branchName: "feat/dev3-file-path-open",
		});

		await syncTaskBranchName(project, task);

		expect(data.updateTask).toHaveBeenCalledWith(project, "task-1", {
			branchName: "fix/dev3-underline-flicker",
			baseBranch: "main",
		});
	});

	it("leaves a variant's source branch as its base across a rename, even one onto the stored base", async () => {
		const project = makeProject();
		const task = makeTask({
			baseBranch: "feature/source",
			existingBranch: "feature/source",
			branchName: "feature/source-v2",
		});

		for (const live of ["feature/source-v3", "feature/source"]) {
			vi.mocked(git.getCurrentBranch).mockResolvedValue(live);
			await syncTaskBranchName(project, task);
			expect(data.updateTask).toHaveBeenLastCalledWith(project, "task-1", { branchName: live });
		}
	});

	it("returns the original task when persisting fails", async () => {
		vi.mocked(git.getCurrentBranch).mockResolvedValue("chore/dev3-example");
		vi.mocked(data.updateTask).mockRejectedValue(new Error("disk full"));

		const task = makeTask();
		const result = await syncTaskBranchName(makeProject(), task);

		expect(result).toBe(task);
	});
});
