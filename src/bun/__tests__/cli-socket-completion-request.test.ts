import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Project, Task, CliRequest } from "../../shared/types";

// ---- Mocks (same boundary set as cli-socket-handlers.test.ts) ----

vi.mock("../data", () => ({
	loadProjects: vi.fn(),
	getProject: vi.fn(),
	loadTasks: vi.fn(),
	getTask: vi.fn(),
	addTask: vi.fn(),
	updateTask: vi.fn(),
	updateProject: vi.fn(),
}));

vi.mock("../git", () => ({
	createWorktree: vi.fn(),
	removeWorktree: vi.fn(),
}));

vi.mock("../pty-server", () => ({
	destroySession: vi.fn(),
}));

vi.mock("../rpc-handlers/tmux-pty", () => ({
	runDevServer: vi.fn(),
	stopDevServer: vi.fn(),
	restartDevServer: vi.fn(),
	getDevServerStatus: vi.fn(),
}));

vi.mock("../rpc-handlers", () => {
	const ACTIVE = ["in-progress", "user-questions", "review-by-user", "review-by-ai"];
	return {
		isActive: vi.fn((status: string) => ACTIVE.includes(status)),
		activateTask: vi.fn(),
		moveTask: vi.fn(),
		runCleanupScript: vi.fn(),
		emitTaskSound: vi.fn(),
		getPushMessage: vi.fn(() => null),
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

vi.mock("../paths", () => ({
	DEV3_HOME: "/tmp/test-dev3",
}));

vi.mock("../socket-backpressure", () => ({
	flushAndEnd: vi.fn(),
	drainSocket: vi.fn(),
	pendingWrites: new Map(),
}));

vi.mock("../settings", () => ({
	loadSettings: vi.fn(() => ({ updateChannel: "stable", taskDropPosition: "top" })),
	saveSettings: vi.fn(),
}));

vi.mock("node:fs", () => ({
	existsSync: vi.fn(() => false),
	readdirSync: vi.fn(() => []),
	unlinkSync: vi.fn(),
	mkdirSync: vi.fn(),
}));

import * as data from "../data";
import { moveTask, getPushMessage } from "../rpc-handlers";
import { resolveCompletionRequest, _resetCompletionRequestsForTests } from "../completion-requests";

const { handleRequest } = await import("../cli-socket-server");

// ---- Helpers ----

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

function makeRequest(params: Record<string, unknown>): CliRequest {
	return { id: "req-1", method: "task.requestCompletion", params };
}

function setupTask(task: Task): void {
	vi.mocked(data.getProject).mockResolvedValue(makeProject());
	vi.mocked(data.loadTasks).mockResolvedValue([task]);
}

beforeEach(() => {
	vi.clearAllMocks();
	_resetCompletionRequestsForTests();
});

describe("task.requestCompletion", () => {
	it("errors when the task is already completed", async () => {
		setupTask(makeTask({ status: "completed" }));

		const resp = await handleRequest(makeRequest({ taskId: "task-abc12345", projectId: "proj-1" }));
		expect(resp.ok).toBe(false);
		expect(resp.error).toContain("already completed");
	});

	it("errors when no app window is connected", async () => {
		setupTask(makeTask());
		vi.mocked(getPushMessage).mockReturnValue(null);

		const resp = await handleRequest(makeRequest({ taskId: "task-abc12345", projectId: "proj-1" }));
		expect(resp.ok).toBe(false);
		expect(resp.error).toContain("No app window is connected");
	});

	it("pushes agentCompletionRequested and completes the task on approval", async () => {
		const task = makeTask();
		setupTask(task);
		const pushFn = vi.fn();
		vi.mocked(getPushMessage).mockReturnValue(pushFn);
		const completedTask = { ...task, status: "completed" as const };
		vi.mocked(moveTask).mockResolvedValue(completedTask);

		const respPromise = handleRequest(makeRequest({ taskId: "task-abc12345", projectId: "proj-1" }));
		await vi.waitFor(() => expect(pushFn).toHaveBeenCalled());

		const [event, payload] = pushFn.mock.calls[0] as [string, { requestId: string; taskId: string; projectId: string; taskTitle: string }];
		expect(event).toBe("agentCompletionRequested");
		expect(payload.taskId).toBe(task.id);
		expect(payload.projectId).toBe("proj-1");
		expect(payload.taskTitle).toBe("Test task");

		resolveCompletionRequest(payload.requestId, true);

		const resp = await respPromise;
		expect(resp.ok).toBe(true);
		expect(resp.data).toEqual({ approved: true, task: completedTask });
		expect(moveTask).toHaveBeenCalledWith({ taskId: task.id, projectId: "proj-1", newStatus: "completed" });
	});

	it("returns approved:false without moving the task when declined", async () => {
		setupTask(makeTask());
		const pushFn = vi.fn();
		vi.mocked(getPushMessage).mockReturnValue(pushFn);

		const respPromise = handleRequest(makeRequest({ taskId: "task-abc12345", projectId: "proj-1" }));
		await vi.waitFor(() => expect(pushFn).toHaveBeenCalled());

		const payload = pushFn.mock.calls[0][1] as { requestId: string };
		resolveCompletionRequest(payload.requestId, false);

		const resp = await respPromise;
		expect(resp.ok).toBe(true);
		expect(resp.data).toEqual({ approved: false });
		expect(moveTask).not.toHaveBeenCalled();
	});

	it("joins an existing pending request instead of pushing a second dialog", async () => {
		setupTask(makeTask());
		const pushFn = vi.fn();
		vi.mocked(getPushMessage).mockReturnValue(pushFn);

		const first = handleRequest(makeRequest({ taskId: "task-abc12345", projectId: "proj-1" }));
		await vi.waitFor(() => expect(pushFn).toHaveBeenCalledTimes(1));
		const second = handleRequest(makeRequest({ taskId: "task-abc12345", projectId: "proj-1" }));
		// Let the second handler reach createCompletionRequest (and join) before resolving.
		await new Promise((r) => setTimeout(r, 10));
		expect(pushFn).toHaveBeenCalledTimes(1);

		const payload = pushFn.mock.calls[0][1] as { requestId: string };
		resolveCompletionRequest(payload.requestId, false);

		const [respA, respB] = await Promise.all([first, second]);
		expect(respA.data).toEqual({ approved: false });
		expect(respB.data).toEqual({ approved: false });
		expect(pushFn).toHaveBeenCalledTimes(1);
	});
});
