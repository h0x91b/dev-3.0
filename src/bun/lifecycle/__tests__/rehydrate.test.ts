import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Project, Task } from "../../../shared/types";

vi.mock("node:fs", () => ({
	existsSync: vi.fn(() => true),
}));

vi.mock("../../data", () => ({
	loadProjects: vi.fn(),
	loadVirtualProjects: vi.fn(() => Promise.resolve([])),
	loadTasks: vi.fn(),
}));

vi.mock("../../git", () => ({
	taskDir: vi.fn((_project: Project, task: Task) => `/managed/${task.id.slice(0, 8)}`),
	virtualWorkDir: vi.fn(),
	getCurrentBranch: vi.fn(() => Promise.resolve("fix/active")),
	recoverStaleInitializingWorktrees: vi.fn(() => Promise.resolve([])),
}));

vi.mock("../../pty-server", () => ({
	tmuxSessionExists: vi.fn(() => Promise.resolve(true)),
}));

vi.mock("../../tmux", () => ({
	DEFAULT_TMUX_SOCKET: "dev3",
}));

vi.mock("../../rpc-handlers/shared", () => ({
	log: {
		warn: vi.fn(),
	},
}));

vi.mock("../service", () => ({
	dispatchLifecycleEvent: vi.fn(() => Promise.resolve()),
}));

import * as data from "../../data";
import * as git from "../../git";
import { rehydrateTaskLifecycles } from "../rehydrate";

function project(): Project {
	return {
		id: "project-1",
		name: "Project",
		path: "/repo",
		setupScript: "",
		devScript: "",
		cleanupScript: "",
		defaultBaseBranch: "main",
		createdAt: "2026-07-22T00:00:00.000Z",
	};
}

function task(overrides: Partial<Task>): Task {
	return {
		id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
		seq: 1,
		projectId: "project-1",
		title: "Task",
		description: "Task",
		status: "todo",
		baseBranch: "main",
		worktreePath: null,
		branchName: null,
		groupId: null,
		variantIndex: null,
		agentId: null,
		configId: null,
		createdAt: "2026-07-22T00:00:00.000Z",
		updatedAt: "2026-07-22T00:00:00.000Z",
		...overrides,
	};
}

describe("rehydrateTaskLifecycles", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("recovers unowned initializing entries while protecting active worktrees", async () => {
		const currentProject = project();
		const activePath = "/managed/active/worktree";
		const activeTask = task({
			id: "active00-bbbb-cccc-dddd-eeeeeeeeeeee",
			status: "in-progress",
			worktreePath: activePath,
			branchName: "fix/active",
			runtimeState: { runtime: "running", updatedAt: 1 },
		});
		const staleTask = task({ id: "stale000-bbbb-cccc-dddd-eeeeeeeeeeee" });
		vi.mocked(data.loadProjects).mockResolvedValue([currentProject]);
		vi.mocked(data.loadTasks).mockResolvedValue([activeTask, staleTask]);

		await rehydrateTaskLifecycles();

		expect(git.recoverStaleInitializingWorktrees).toHaveBeenCalledTimes(1);
		const [recoveryProject, protectedPaths] = vi.mocked(git.recoverStaleInitializingWorktrees).mock.calls[0];
		expect(recoveryProject).toBe(currentProject);
		expect([...protectedPaths]).toEqual([activePath]);
	});
});
