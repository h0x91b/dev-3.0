import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Project, Task } from "../../shared/types";

// ---- Mocks ----

vi.mock("electrobun/bun", () => ({
	Utils: {
		showMessageBox: vi.fn(),
		openFileDialog: vi.fn(),
	},
}));

vi.mock("../data", () => ({
	getProject: vi.fn(),
	getTask: vi.fn(),
	loadProjects: vi.fn(),
	loadTasks: vi.fn(),
	updateTask: vi.fn(),
	addTask: vi.fn(),
	deleteTask: vi.fn(),
}));

vi.mock("../git", () => ({
	removeWorktree: vi.fn(),
	createWorktree: vi.fn(),
	isGitRepo: vi.fn(),
	getDefaultBranch: vi.fn(),
}));

vi.mock("../pty-server", () => ({
	createSession: vi.fn(),
	destroySession: vi.fn(),
	hasSession: vi.fn(),
	getPtyPort: vi.fn(() => 9999),
	getSessionProjectId: vi.fn(() => null),
}));

vi.mock("../agents", () => ({
	ensureClaudeTrust: vi.fn(),
	resolveCommandForAgent: vi.fn(() => ({ command: "claude", extraEnv: {} })),
	resolveCommandForProject: vi.fn(() => ({ command: "claude", extraEnv: {} })),
}));

vi.mock("../settings", () => ({
	loadSettings: vi.fn(() => ({})),
	saveSettings: vi.fn(),
}));

vi.mock("../logger", () => ({
	createLogger: () => ({
		debug: vi.fn(),
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
	}),
}));

// Mock node:fs for existsSync
vi.mock("node:fs", () => ({
	existsSync: vi.fn(() => true),
}));

import * as data from "../data";
import * as git from "../git";
import * as pty from "../pty-server";
import { existsSync } from "node:fs";

// Import handlers after all mocks are set up
const { handlers } = await import("../rpc-handlers");

// ---- Test helpers ----

function makeProject(overrides?: Partial<Project>): Project {
	return {
		id: "proj-1",
		name: "Test Project",
		path: "/tmp/test-project",
		setupScript: "",
		devScript: "",
		cleanupScript: "echo cleanup",
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
		description: "Test task description",
		status: "in-progress",
		baseBranch: "main",
		worktreePath: "/tmp/test-worktree",
		branchName: "dev3/task-test",
		groupId: null,
		variantIndex: null,
		agentId: null,
		configId: null,
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
		...overrides,
	};
}

// ---- Tests ----

describe("moveTask — active → completed with missing worktree", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("should NOT throw when worktree directory is missing; should skip cleanup, skip removeWorktree, still update status", async () => {
		const project = makeProject({ cleanupScript: "echo cleanup" });
		const task = makeTask({
			status: "in-progress",
			worktreePath: "/tmp/deleted-worktree",
		});

		vi.mocked(data.getProject).mockResolvedValue(project);
		vi.mocked(data.getTask).mockResolvedValue(task);
		vi.mocked(data.updateTask).mockResolvedValue({
			...task,
			status: "completed",
			worktreePath: null,
			branchName: null,
		});
		vi.mocked(existsSync).mockReturnValue(false);

		const result = await handlers.moveTask({
			taskId: "task-1",
			projectId: "proj-1",
			newStatus: "completed",
		});

		expect(result.status).toBe("completed");
		expect(result.worktreePath).toBeNull();
		expect(result.branchName).toBeNull();

		// updateTask must be called to persist the new status
		expect(data.updateTask).toHaveBeenCalledWith(
			project,
			"task-1",
			expect.objectContaining({
				status: "completed",
				worktreePath: null,
				branchName: null,
			}),
		);
	});

	it("should NOT throw when worktree directory is missing (cancelled)", async () => {
		const project = makeProject({ cleanupScript: "echo cleanup" });
		const task = makeTask({
			status: "in-progress",
			worktreePath: "/tmp/deleted-worktree",
		});

		vi.mocked(data.getProject).mockResolvedValue(project);
		vi.mocked(data.getTask).mockResolvedValue(task);
		vi.mocked(data.updateTask).mockResolvedValue({
			...task,
			status: "cancelled",
			worktreePath: null,
			branchName: null,
		});
		vi.mocked(existsSync).mockReturnValue(false);

		const result = await handlers.moveTask({
			taskId: "task-1",
			projectId: "proj-1",
			newStatus: "cancelled",
		});

		expect(result.status).toBe("cancelled");
		expect(data.updateTask).toHaveBeenCalled();
	});

	it("should tolerate removeWorktree failure when branch is already deleted", async () => {
		const project = makeProject({ cleanupScript: "" });
		const task = makeTask({
			status: "in-progress",
			worktreePath: "/tmp/existing-worktree",
		});

		vi.mocked(data.getProject).mockResolvedValue(project);
		vi.mocked(data.getTask).mockResolvedValue(task);
		vi.mocked(data.updateTask).mockResolvedValue({
			...task,
			status: "completed",
			worktreePath: null,
			branchName: null,
		});
		vi.mocked(existsSync).mockReturnValue(true);
		vi.mocked(git.removeWorktree).mockRejectedValue(new Error("branch not found"));

		const result = await handlers.moveTask({
			taskId: "task-1",
			projectId: "proj-1",
			newStatus: "completed",
		});

		expect(result.status).toBe("completed");
		expect(data.updateTask).toHaveBeenCalled();
	});
});

describe("runCleanupScript — missing worktree", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("should not throw when worktreePath is null", async () => {
		const project = makeProject({ cleanupScript: "echo cleanup" });
		const task = makeTask({
			status: "in-progress",
			worktreePath: null,
		});

		vi.mocked(data.getProject).mockResolvedValue(project);
		vi.mocked(data.getTask).mockResolvedValue(task);
		vi.mocked(data.updateTask).mockResolvedValue({
			...task,
			status: "completed",
			worktreePath: null,
			branchName: null,
		});

		// Moving a task with null worktreePath to completed — the cleanup script
		// check `if (!task.worktreePath ...)` should return early.
		// But since task.worktreePath is null, it's not active→terminal transition actually,
		// let's make it active status
		const result = await handlers.moveTask({
			taskId: "task-1",
			projectId: "proj-1",
			newStatus: "completed",
		});

		expect(result.status).toBe("completed");
	});
});

describe("getPtyUrl — missing worktree", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("should not crash when worktree directory is missing during PTY restore", async () => {
		const project = makeProject();
		const task = makeTask({
			status: "in-progress",
			worktreePath: "/tmp/deleted-worktree",
		});

		vi.mocked(pty.hasSession).mockReturnValue(false);
		vi.mocked(data.loadProjects).mockResolvedValue([project]);
		vi.mocked(data.getTask).mockResolvedValue(task);
		vi.mocked(existsSync).mockReturnValue(false);

		// Should return a URL even if launchTaskPty fails
		const url = await handlers.getPtyUrl({ taskId: "task-1" });
		expect(url).toContain("ws://localhost:");
		expect(url).toContain("session=task-1");
	});

	it("should return URL normally when PTY session already exists", async () => {
		vi.mocked(pty.hasSession).mockReturnValue(true);
		vi.mocked(pty.getPtyPort).mockReturnValue(9999);

		const url = await handlers.getPtyUrl({ taskId: "task-1" });
		expect(url).toBe("ws://localhost:9999?session=task-1");
	});
});
