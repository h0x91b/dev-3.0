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
import { moveTask, getPushMessage } from "../rpc-handlers";
import { listPendingAgentRequests, resolveAgentRequest, _resetAgentRequestsForTests } from "../agent-requests";

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

function makeRequest(params: Record<string, unknown>, method = "task.requestCancellation"): CliRequest {
	return { id: "req-1", method, params };
}

const REF = { taskId: "task-abc12345", projectId: "proj-1" };

function setupTask(task: Task): void {
	vi.mocked(data.getProject).mockResolvedValue(makeProject());
	vi.mocked(data.loadTasks).mockResolvedValue([task]);
}

beforeEach(() => {
	vi.clearAllMocks();
	_resetAgentRequestsForTests();
});

// A CLI whose socket dropped mid-wait re-attaches with `attachOnly`, after
// asking `approval.status`. Neither may ever open a dialog or answer one: the
// only thing that grants consent is the user's click, delivered through
// resolveAgentRequest.
describe.each([
	{ method: "task.requestCancellation", kind: "cancel", push: "agentCancellationRequested", target: "cancelled" },
	{ method: "task.requestCompletion", kind: "complete", push: "agentCompletionRequested", target: "completed" },
] as const)("$method re-attach", ({ method, kind, push, target }) => {
	it("attachOnly with nothing pending creates no request and pushes no dialog", async () => {
		setupTask(makeTask());
		const pushFn = vi.fn();
		vi.mocked(getPushMessage).mockReturnValue(pushFn);

		const resp = await handleRequest(makeRequest({ ...REF, attachOnly: true }, method));

		expect(resp.ok).toBe(true);
		expect(resp.data).toEqual({ attached: false, status: { kind, state: "none", taskStatus: "in-progress" } });
		expect(pushFn).not.toHaveBeenCalled();
		expect(listPendingAgentRequests(kind)).toEqual([]);
		expect(moveTask).not.toHaveBeenCalled();
	});

	it("attachOnly joins the live request: same id, one entry, and only the user's answer settles both", async () => {
		const task = makeTask();
		setupTask(task);
		const pushFn = vi.fn();
		vi.mocked(getPushMessage).mockReturnValue(pushFn);
		vi.mocked(moveTask).mockResolvedValue({ ...task, status: target });

		const original = handleRequest(makeRequest(REF, method));
		await vi.waitFor(() => expect(pushFn).toHaveBeenCalledTimes(1));
		const reattached = handleRequest(makeRequest({ ...REF, attachOnly: true }, method));
		await vi.waitFor(() => expect(pushFn).toHaveBeenCalledTimes(2));

		const [firstEvent, first] = pushFn.mock.calls[0] as [string, { requestId: string }];
		const [secondEvent, second] = pushFn.mock.calls[1] as [string, { requestId: string }];
		expect(firstEvent).toBe(push);
		expect(secondEvent).toBe(push);
		expect(second.requestId).toBe(first.requestId);
		expect(listPendingAgentRequests(kind)).toHaveLength(1);

		// Nothing has answered yet: both callers are still blocked.
		let settled = false;
		void Promise.race([original, reattached]).then(() => { settled = true; });
		await new Promise((r) => setTimeout(r, 20));
		expect(settled).toBe(false);
		expect(moveTask).not.toHaveBeenCalled();

		resolveAgentRequest(first.requestId, { approved: true });
		const [a, b] = await Promise.all([original, reattached]);
		expect(a.data).toMatchObject({ approved: true });
		expect(b.data).toMatchObject({ approved: true });
	});

	it("attachOnly after a decline reports the decline and does not re-ask", async () => {
		setupTask(makeTask());
		const pushFn = vi.fn();
		vi.mocked(getPushMessage).mockReturnValue(pushFn);

		const original = handleRequest(makeRequest(REF, method));
		await vi.waitFor(() => expect(pushFn).toHaveBeenCalledTimes(1));
		resolveAgentRequest((pushFn.mock.calls[0][1] as { requestId: string }).requestId, { approved: false });
		expect((await original).data).toEqual({ approved: false });

		const resp = await handleRequest(makeRequest({ ...REF, attachOnly: true }, method));
		expect(resp.data).toEqual({
			attached: false,
			status: { kind, state: "answered", approved: false, taskStatus: "in-progress" },
		});
		expect(pushFn).toHaveBeenCalledTimes(1);
		expect(listPendingAgentRequests(kind)).toEqual([]);
	});

	it("attachOnly on a task that already reached its target reports it instead of erroring", async () => {
		setupTask(makeTask({ status: target }));
		vi.mocked(getPushMessage).mockReturnValue(vi.fn());

		const resp = await handleRequest(makeRequest({ ...REF, attachOnly: true }, method));

		expect(resp.ok).toBe(true);
		expect(resp.data).toEqual({ attached: false, status: { kind, state: "none", taskStatus: target } });
	});

	it("approval.status is read-only: pending, answered and none, with no push and no new request", async () => {
		setupTask(makeTask());
		const pushFn = vi.fn();
		vi.mocked(getPushMessage).mockReturnValue(pushFn);

		const none = await handleRequest(makeRequest({ ...REF, kind }, "approval.status"));
		expect(none.data).toEqual({ kind, state: "none", taskStatus: "in-progress" });
		expect(listPendingAgentRequests(kind)).toEqual([]);

		const original = handleRequest(makeRequest(REF, method));
		await vi.waitFor(() => expect(pushFn).toHaveBeenCalledTimes(1));
		const pending = await handleRequest(makeRequest({ ...REF, kind }, "approval.status"));
		expect(pending.data).toEqual({ kind, state: "pending", taskStatus: "in-progress" });
		expect(pushFn).toHaveBeenCalledTimes(1);

		resolveAgentRequest((pushFn.mock.calls[0][1] as { requestId: string }).requestId, { approved: false });
		await original;
		const answered = await handleRequest(makeRequest({ ...REF, kind }, "approval.status"));
		expect(answered.data).toEqual({ kind, state: "answered", approved: false, taskStatus: "in-progress" });
		expect(pushFn).toHaveBeenCalledTimes(1);
		expect(moveTask).not.toHaveBeenCalled();
	});
});

describe("approval.status", () => {
	it("rejects an unknown kind", async () => {
		setupTask(makeTask());
		const resp = await handleRequest(makeRequest({ ...REF, kind: "launch" }, "approval.status"));
		expect(resp.ok).toBe(false);
		expect(resp.error).toContain("kind must be");
	});

	it("keeps the two kinds apart", async () => {
		setupTask(makeTask());
		const pushFn = vi.fn();
		vi.mocked(getPushMessage).mockReturnValue(pushFn);

		void handleRequest(makeRequest(REF, "task.requestCompletion"));
		await vi.waitFor(() => expect(pushFn).toHaveBeenCalledTimes(1));
		const cancel = await handleRequest(makeRequest({ ...REF, kind: "cancel" }, "approval.status"));
		expect(cancel.data).toMatchObject({ state: "none" });
	});
});
