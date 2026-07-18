import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CliRequest, Project, Task } from "../../shared/types";

const mockMoveTask = vi.fn();
const mockCleanupTaskState = vi.fn();
const mockReleasePorts = vi.fn();
const mockKillDevServerSession = vi.fn();

vi.mock("../data", () => ({
	loadProjects: vi.fn(),
	getProject: vi.fn(),
	loadTasks: vi.fn(),
	updateTask: vi.fn(),
}));

vi.mock("../git", () => ({
	createWorktree: vi.fn(),
	removeWorktree: vi.fn(),
}));

vi.mock("../pty-server", () => ({
	destroySession: vi.fn(),
	DEFAULT_TMUX_SOCKET: "dev3",
}));

vi.mock("../port-pool", () => ({
	releasePorts: (...args: unknown[]) => mockReleasePorts(...args),
}));

vi.mock("../rpc-handlers/tmux-pty", () => ({
	runDevServer: vi.fn(),
	stopDevServer: vi.fn(),
	getDevServerStatus: vi.fn(),
	killDevServerSession: (...args: unknown[]) => mockKillDevServerSession(...args),
}));

vi.mock("../rpc-handlers", () => {
	const ACTIVE = ["in-progress", "user-questions", "review-by-user", "review-by-ai"];
	return {
		isActive: vi.fn((status: string) => ACTIVE.includes(status)),
		activateTask: vi.fn(),
		runCleanupScript: vi.fn(),
		emitTaskSound: vi.fn(),
		getPushMessage: vi.fn(() => null),
		getPushMessageLocal: vi.fn(() => null),
		moveTask: (...args: unknown[]) => mockMoveTask(...args),
		triggerColumnAgentIfNeeded: vi.fn(),
		notifyWatchedTaskStatusChange: vi.fn(),
	};
});

vi.mock("../logger", () => ({
	createLogger: () => ({
		debug: vi.fn(),
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
	}),
}));

vi.mock("../settings", () => ({
	loadSettings: vi.fn(() => ({ updateChannel: "stable", taskDropPosition: "top" })),
	recordFavoriteUsages: vi.fn(),
}));

vi.mock("../repo-config", () => ({
	migrateProjectConfig: vi.fn(),
}));

vi.mock("../paths", () => ({
	DEV3_HOME: "/tmp/test-dev3",
}));

vi.mock("node:fs", () => ({
	existsSync: vi.fn(() => false),
	readdirSync: vi.fn(() => []),
	unlinkSync: vi.fn(),
	mkdirSync: vi.fn(),
	// Consumed by the tmux module (config writes + shim sanitation) pulled in
	// through rpc-handlers/tmux-pty.
	writeFileSync: vi.fn(),
	lstatSync: vi.fn(() => { throw new Error("ENOENT"); }),
	statSync: vi.fn(() => ({ isFile: () => true })),
	readlinkSync: vi.fn(() => { throw new Error("EINVAL"); }),
	realpathSync: vi.fn((p: string) => p),
	symlinkSync: vi.fn(),
	accessSync: vi.fn(),
}));

import * as data from "../data";

const { handleRequest } = await import("../cli-socket-server");

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
		id: "task-abc12345-1111-2222-3333-444444444444",
		seq: 1,
		projectId: "proj-1",
		title: "Test task",
		description: "A test task",
		status: "in-progress",
		baseBranch: "main",
		worktreePath: "/tmp/wt",
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

function makeRequest(method: string, params: Record<string, unknown> = {}): CliRequest {
	return { id: "req-1", method, params };
}

describe("task.move destructive cleanup", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("delegates destructive cleanup to task-lifecycle moveTask", async () => {
		const project = makeProject();
		const task = makeTask({ status: "in-progress", tmuxSocket: "sock-1" });
		const updated = {
			...task,
			status: "completed" as const,
			worktreePath: null,
			branchName: null,
		};

		vi.mocked(data.getProject).mockResolvedValue(project);
		vi.mocked(data.loadTasks).mockResolvedValue([task]);
		vi.mocked(data.updateTask).mockResolvedValue(updated);
		mockMoveTask.mockImplementation(async () => {
			mockCleanupTaskState(task.id);
			mockReleasePorts(task.id);
			mockKillDevServerSession(task.id, task.tmuxSocket);
			return updated;
		});

		const resp = await handleRequest(
			makeRequest("task.move", {
				taskId: task.id,
				projectId: project.id,
				newStatus: "completed",
			}),
		);

		expect(resp.ok).toBe(true);
		expect(mockMoveTask).toHaveBeenCalledWith({
			taskId: task.id,
			projectId: project.id,
			newStatus: "completed",
			ifStatus: undefined,
			ifStatusNot: undefined,
		});
		expect(mockCleanupTaskState).toHaveBeenCalledWith(task.id);
		expect(mockReleasePorts).toHaveBeenCalledWith(task.id);
		expect(mockKillDevServerSession).toHaveBeenCalledWith(task.id, task.tmuxSocket);
	});
});
