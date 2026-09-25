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
		resetTaskToTodo: vi.fn(),
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
	loadSettings: vi.fn(() => ({ updateChannel: "stable", taskSortOrder: "oldest-first" })),
	saveSettings: vi.fn(),
	recordFavoriteUsages: vi.fn(),
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
import { moveTask, resetTaskToTodo, getPushMessage } from "../rpc-handlers";
import { listPendingAgentRequests, resolveAgentRequest, voidAgentRequest, _resetAgentRequestsForTests } from "../agent-requests";

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
	return { id: "req-1", method: "task.requestReset", params };
}

function setupTask(task: Task): void {
	vi.mocked(data.getProject).mockResolvedValue(makeProject());
	vi.mocked(data.loadTasks).mockResolvedValue([task]);
}

beforeEach(() => {
	vi.clearAllMocks();
	_resetAgentRequestsForTests();
});

const STARTED = "2026-09-25T10:00:00.000Z";

async function openRequest(task: Task, params: Record<string, unknown> = {}) {
	setupTask(task);
	const pushFn = vi.fn();
	vi.mocked(getPushMessage).mockReturnValue(pushFn);
	const resp = handleRequest(makeRequest({ taskId: "task-abc12345", projectId: "proj-1", ...params }));
	await vi.waitFor(() => expect(pushFn).toHaveBeenCalled());
	const [event, payload] = pushFn.mock.calls[0] as [string, { requestId: string }];
	return { resp, event, requestId: payload.requestId };
}

describe("task.requestReset (T17, T17b)", () => {
	it("pushes its OWN dialog channel and resets with the consent captured when it opened", async () => {
		const task = makeTask({ status: "review-by-user", lifecycleStartedAt: STARTED });
		const { resp, event, requestId } = await openRequest(task);
		expect(event).toBe("agentResetRequested");
		expect(listPendingAgentRequests("cancel")).toHaveLength(0);
		expect(listPendingAgentRequests("reset")).toHaveLength(1);

		const reset = { ...task, status: "todo" as const, worktreePath: null };
		vi.mocked(resetTaskToTodo).mockResolvedValue({ task: reset, keptBranches: [] });
		resolveAgentRequest(requestId, { approved: true });

		expect((await resp).data).toEqual({ approved: true, task: reset, keptBranches: [] });
		expect(resetTaskToTodo).toHaveBeenCalledWith({
			taskId: task.id,
			projectId: "proj-1",
			consent: { worktreePath: "/tmp/wt", lifecycleStartedAt: STARTED },
		});
		expect(moveTask).not.toHaveBeenCalled();
	});

	it("an out-of-task caller (no sourceTaskId) still needs the dialog — origin grants no consent", async () => {
		const { resp, event, requestId } = await openRequest(makeTask());
		expect(event).toBe("agentResetRequested");
		resolveAgentRequest(requestId, { approved: false });
		expect((await resp).data).toEqual({ approved: false });
		expect(resetTaskToTodo).not.toHaveBeenCalled();
	});

	it("declined changes nothing (the task's own agent asking)", async () => {
		const { resp, requestId } = await openRequest(makeTask(), { sourceTaskId: "task-abc12345-1111-2222-3333-444444444444" });
		resolveAgentRequest(requestId, { approved: false });
		expect((await resp).data).toEqual({ approved: false });
		expect(resetTaskToTodo).not.toHaveBeenCalled();
		expect(moveTask).not.toHaveBeenCalled();
	});

	it("a run that ends first voids the request as stale — never approved (T9b)", async () => {
		const { resp } = await openRequest(makeTask({ lifecycleStartedAt: STARTED }));
		expect(voidAgentRequest("reset", "task-abc12345-1111-2222-3333-444444444444")).toBe(true);
		expect((await resp).data).toEqual({ approved: false, stale: true });
		expect(resetTaskToTodo).not.toHaveBeenCalled();
	});

	it("is never auto-approved: still pending long after it opened", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "Date"] });
		try {
			const { resp, requestId } = await openRequest(makeTask());
			await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
			expect(listPendingAgentRequests("reset")).toHaveLength(1);
			resolveAgentRequest(requestId, { approved: false });
			await resp;
		} finally {
			vi.useRealTimers();
		}
	});

	it("a clean To Do card, a completed task: plain move, no dialog", async () => {
		for (const task of [makeTask({ status: "todo", worktreePath: null }), makeTask({ status: "completed", worktreePath: null })]) {
			vi.clearAllMocks();
			setupTask(task);
			const pushFn = vi.fn();
			vi.mocked(getPushMessage).mockReturnValue(pushFn);
			const moved = { ...task, status: "todo" as const };
			vi.mocked(moveTask).mockResolvedValue(moved);
			const resp = await handleRequest(makeRequest({ taskId: "task-abc12345", projectId: "proj-1" }));
			expect(resp.data).toEqual({ approved: true, task: moved, plainMove: true });
			expect(pushFn).not.toHaveBeenCalled();
			expect(resetTaskToTodo).not.toHaveBeenCalled();
		}
	});

	it("a legacy To Do card that still owns a worktree asks, like an active one", async () => {
		const { event, requestId, resp } = await openRequest(makeTask({ status: "todo", worktreePath: "/tmp/wt" }));
		expect(event).toBe("agentResetRequested");
		resolveAgentRequest(requestId, { approved: false });
		await resp;
	});

	it("approval.status knows the reset kind", async () => {
		setupTask(makeTask());
		const resp = await handleRequest({ id: "r", method: "approval.status", params: { taskId: "task-abc12345", projectId: "proj-1", kind: "reset" } });
		expect(resp.ok).toBe(true);
		expect(resp.data).toMatchObject({ kind: "reset", state: "none" });
	});
});

// S5 (Seq 2003 review 2003-010): every waiter joined to one reset request — a
// retry, a re-attach after a dropped socket — gets the SAME outcome of ONE reset.
describe("task.requestReset — joined waiters", () => {
	it("a retry and a re-attach share one reset and one truthful result", async () => {
		const task = makeTask({ lifecycleStartedAt: STARTED });
		const { resp: first, requestId } = await openRequest(task);
		const retry = handleRequest(makeRequest({ taskId: "task-abc12345", projectId: "proj-1" }));
		const reattach = handleRequest(makeRequest({ taskId: "task-abc12345", projectId: "proj-1", attachOnly: true }));
		const pushFn = vi.mocked(getPushMessage)() as unknown as ReturnType<typeof vi.fn>;
		// Every joined attempt re-pushes the same dialog: three pushes = three waiters joined.
		await vi.waitFor(() => expect(pushFn.mock.calls.length).toBe(3));

		const reset = { ...task, status: "todo" as const, worktreePath: null };
		vi.mocked(resetTaskToTodo).mockResolvedValue({ task: reset, keptBranches: [{ name: "release/2.0", reason: "not-owned" }] });
		resolveAgentRequest(requestId, { approved: true });

		const results = await Promise.all([first, retry, reattach]);
		for (const resp of results) {
			expect(resp.ok).toBe(true);
			expect(resp.data).toEqual({ approved: true, task: reset, keptBranches: [{ name: "release/2.0", reason: "not-owned" }] });
		}
		expect(resetTaskToTodo).toHaveBeenCalledTimes(1);
	});

	it("a failed reset reports the same failure to every waiter, never a false 'nothing deleted'", async () => {
		const { resp: first, requestId } = await openRequest(makeTask({ lifecycleStartedAt: STARTED }));
		const reattach = handleRequest(makeRequest({ taskId: "task-abc12345", projectId: "proj-1", attachOnly: true }));
		const pushFn = vi.mocked(getPushMessage)() as unknown as ReturnType<typeof vi.fn>;
		await vi.waitFor(() => expect(pushFn.mock.calls.length).toBe(2));
		vi.mocked(resetTaskToTodo).mockRejectedValue(new Error("Task reset stopped: worktree is locked"));
		resolveAgentRequest(requestId, { approved: true });
		for (const resp of await Promise.all([first, reattach])) {
			expect(resp.ok).toBe(false);
			expect(resp.error).toContain("worktree is locked");
		}
		expect(resetTaskToTodo).toHaveBeenCalledTimes(1);
	});

	it("a stale void is reported as stale in approval.status", async () => {
		const { resp } = await openRequest(makeTask({ lifecycleStartedAt: STARTED }));
		voidAgentRequest("reset", "task-abc12345-1111-2222-3333-444444444444");
		await resp;
		const status = await handleRequest({ id: "r", method: "approval.status", params: { taskId: "task-abc12345", projectId: "proj-1", kind: "reset" } });
		expect(status.data).toMatchObject({ kind: "reset", state: "answered", approved: false, stale: true, resetNeeded: true });
	});

	it("an answer from another dialog kind cannot settle a reset", async () => {
		const { resp, requestId } = await openRequest(makeTask());
		expect(resolveAgentRequest(requestId, { approved: true }, "cancel")).toBe(false);
		expect(listPendingAgentRequests("reset")).toHaveLength(1);
		resolveAgentRequest(requestId, { approved: false }, "reset");
		expect((await resp).data).toEqual({ approved: false });
	});
});
