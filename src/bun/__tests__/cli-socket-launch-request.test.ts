import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Project, Task, CliRequest } from "../../shared/types";

// ---- Mocks (same boundary set as cli-socket-completion-request.test.ts) ----

vi.mock("../data", () => ({
	loadProjects: vi.fn(),
	loadVirtualProjects: vi.fn(() => []),
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
		launchTaskWithAgentChoice: vi.fn(),
		createScratchTask: vi.fn(),
		deleteTask: vi.fn(),
		runCleanupScript: vi.fn(),
		emitTaskSound: vi.fn(),
		getPushMessage: vi.fn(() => null),
		triggerColumnAgentIfNeeded: vi.fn(),
		notifyWatchedTaskStatusChange: vi.fn(),
	};
});

vi.mock("../agent-launch-handoff", () => ({
	deliverLaunchHandoff: vi.fn(() => Promise.resolve(true)),
}));

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
	// Auto-approval off by default here: these cases assert the ask/answer
	// contract, and a live 5-minute timer would outlive the test process.
	loadSettings: vi.fn(() => ({ updateChannel: "stable", taskSortOrder: "oldest-first", agentLaunchAutoApproveMinutes: 0 })),
	saveSettings: vi.fn(),
	recordFavoriteUsages: vi.fn(),
}));

vi.mock("node:fs", () => ({
	existsSync: vi.fn(() => false),
	readdirSync: vi.fn(() => []),
	unlinkSync: vi.fn(),
	mkdirSync: vi.fn(),
	writeFileSync: vi.fn(),
	lstatSync: vi.fn(() => { throw new Error("ENOENT"); }),
	statSync: vi.fn(() => ({ isFile: () => true })),
	readlinkSync: vi.fn(() => { throw new Error("EINVAL"); }),
	realpathSync: vi.fn((p: string) => p),
	symlinkSync: vi.fn(),
	accessSync: vi.fn(),
}));

import * as data from "../data";
import { moveTask, launchTaskWithAgentChoice, createScratchTask, deleteTask, getPushMessage } from "../rpc-handlers";
import { deliverLaunchHandoff } from "../agent-launch-handoff";
import { resolveAgentRequest, _resetAgentRequestsForTests } from "../agent-requests";
import { loadSettings } from "../settings";

const { handleRequest } = await import("../cli-socket-server");

// ---- Helpers ----

const REQUESTER_ID = "task-req11111-1111-2222-3333-444444444444";
const TARGET_ID = "task-tgt22222-1111-2222-3333-444444444444";

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
		id: TARGET_ID,
		seq: 7,
		projectId: "proj-1",
		title: "Target task",
		description: "Waiting in To Do",
		status: "todo",
		baseBranch: "main",
		worktreePath: null,
		branchName: null,
		groupId: null,
		variantIndex: null,
		agentId: null,
		configId: null,
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
		...overrides,
	};
}

const requester = makeTask({ id: REQUESTER_ID, seq: 3, title: "Asking task", status: "in-progress" });

function setupBoard(target: Task): void {
	const project = makeProject();
	vi.mocked(data.getProject).mockResolvedValue(project);
	vi.mocked(data.loadProjects).mockResolvedValue([project]);
	vi.mocked(data.loadTasks).mockResolvedValue([target, requester]);
}

function moveRequest(params: Record<string, unknown>): CliRequest {
	return { id: "req-1", method: "task.move", params };
}

beforeEach(() => {
	vi.clearAllMocks();
	_resetAgentRequestsForTests();
	vi.mocked(deliverLaunchHandoff).mockResolvedValue(true);
});

describe("task.move — agent-initiated launch approval", () => {
	it("moves silently when the agent moves its OWN task", async () => {
		setupBoard(makeTask());
		const pushFn = vi.fn();
		vi.mocked(getPushMessage).mockReturnValue(pushFn);
		const moved = { ...requester, status: "review-by-ai" as const };
		vi.mocked(moveTask).mockResolvedValue(moved);

		const resp = await handleRequest(moveRequest({
			taskId: REQUESTER_ID,
			newStatus: "review-by-ai",
			projectId: "proj-1",
			sourceTaskId: REQUESTER_ID,
		}));

		expect(resp.ok).toBe(true);
		expect(moveTask).toHaveBeenCalled();
		expect(pushFn).not.toHaveBeenCalledWith("agentLaunchRequested", expect.anything());
	});

	it("moves silently for a human (no sourceTaskId) even into an active status", async () => {
		setupBoard(makeTask());
		const pushFn = vi.fn();
		vi.mocked(getPushMessage).mockReturnValue(pushFn);
		vi.mocked(moveTask).mockResolvedValue(makeTask({ status: "in-progress" }));

		const resp = await handleRequest(moveRequest({
			taskId: TARGET_ID,
			newStatus: "in-progress",
			projectId: "proj-1",
		}));

		expect(resp.ok).toBe(true);
		expect(moveTask).toHaveBeenCalled();
		expect(pushFn).not.toHaveBeenCalled();
	});

	it("moves silently when an agent shuffles a FOREIGN task between non-activating columns", async () => {
		setupBoard(makeTask({ status: "in-progress" }));
		const pushFn = vi.fn();
		vi.mocked(getPushMessage).mockReturnValue(pushFn);
		vi.mocked(moveTask).mockResolvedValue(makeTask({ status: "review-by-user" }));

		const resp = await handleRequest(moveRequest({
			taskId: TARGET_ID,
			newStatus: "review-by-user",
			projectId: "proj-1",
			sourceTaskId: REQUESTER_ID,
		}));

		expect(resp.ok).toBe(true);
		expect(moveTask).toHaveBeenCalled();
		expect(pushFn).not.toHaveBeenCalled();
	});

	it("asks the user, then launches with the picked agent and hands off to the child", async () => {
		const target = makeTask({ overview: "Fix the parser" });
		setupBoard(target);
		const pushFn = vi.fn();
		vi.mocked(getPushMessage).mockReturnValue(pushFn);
		const launched = { ...target, status: "in-progress" as const };
		vi.mocked(launchTaskWithAgentChoice).mockResolvedValue(launched);

		const respPromise = handleRequest(moveRequest({
			taskId: TARGET_ID,
			newStatus: "in-progress",
			projectId: "proj-1",
			sourceTaskId: REQUESTER_ID,
		}));
		await vi.waitFor(() => expect(pushFn).toHaveBeenCalled());

		const [event, payload] = pushFn.mock.calls[0] as [string, Record<string, unknown>];
		expect(event).toBe("agentLaunchRequested");
		expect(payload.taskId).toBe(TARGET_ID);
		expect(payload.taskTitle).toBe("Target task");
		expect(payload.targetStatus).toBe("in-progress");
		expect(payload.scratch).toBe(false);
		// The dialog names who is asking, so the user is not guessing.
		expect(payload.requesterSeq).toBe(3);
		expect(payload.requesterTitle).toBe("Asking task");

		const launch = { agentId: "builtin-claude", configId: "claude-auto", accountId: null };
		resolveAgentRequest(payload.requestId as string, { approved: true, launch });

		const resp = await respPromise;
		expect(resp.ok).toBe(true);
		expect(resp.data).toMatchObject({ approved: true, seq: 7, title: "Target task" });
		expect((resp.data as { replyCommand: string }).replyCommand).toContain("dev3 message --task seq:7");
		// The user's pick reaches the launch — NOT the default agent.
		expect(launchTaskWithAgentChoice).toHaveBeenCalledWith({
			taskId: TARGET_ID,
			projectId: "proj-1",
			targetStatus: "in-progress",
			// P3 both sides: neither task set one, so nothing is inherited.
			choice: { ...launch, priority: "P3" },
		});
		// A plain move would have ignored the picked agent entirely.
		expect(moveTask).not.toHaveBeenCalled();
		expect(deliverLaunchHandoff).toHaveBeenCalledWith(expect.objectContaining({
			childTaskId: TARGET_ID,
			source: expect.objectContaining({ seq: 3 }),
		}));
	});

	it("defaults the launch to the requester's priority when the target has none", async () => {
		// Issue #1496: a P0 agent's helper used to start at P3 and sink to the
		// bottom of the board.
		const target = makeTask();
		const project = makeProject();
		vi.mocked(data.getProject).mockResolvedValue(project);
		vi.mocked(data.loadProjects).mockResolvedValue([project]);
		vi.mocked(data.loadTasks).mockResolvedValue([target, { ...requester, priority: "P0" as const }]);
		const pushFn = vi.fn();
		vi.mocked(getPushMessage).mockReturnValue(pushFn);
		vi.mocked(launchTaskWithAgentChoice).mockResolvedValue({ ...target, status: "in-progress" });

		const respPromise = handleRequest(moveRequest({
			taskId: TARGET_ID,
			newStatus: "in-progress",
			projectId: "proj-1",
			sourceTaskId: REQUESTER_ID,
		}));
		await vi.waitFor(() => expect(pushFn).toHaveBeenCalled());
		const [, payload] = pushFn.mock.calls[0] as [string, Record<string, unknown>];
		expect(payload.defaultPriority).toBe("P0");

		// Auto-approval with nobody watching carries no choice at all; the
		// inherited priority must still be applied.
		resolveAgentRequest(payload.requestId as string, { approved: true });
		await respPromise;
		expect(launchTaskWithAgentChoice).toHaveBeenCalledWith(expect.objectContaining({
			choice: expect.objectContaining({ priority: "P0" }),
		}));
	});

	it("keeps the target's own priority — an explicit band is not overwritten", async () => {
		const target = makeTask({ priority: "P4" });
		const project = makeProject();
		vi.mocked(data.getProject).mockResolvedValue(project);
		vi.mocked(data.loadProjects).mockResolvedValue([project]);
		vi.mocked(data.loadTasks).mockResolvedValue([target, { ...requester, priority: "P0" as const }]);
		const pushFn = vi.fn();
		vi.mocked(getPushMessage).mockReturnValue(pushFn);
		vi.mocked(launchTaskWithAgentChoice).mockResolvedValue({ ...target, status: "in-progress" });

		const respPromise = handleRequest(moveRequest({
			taskId: TARGET_ID,
			newStatus: "in-progress",
			projectId: "proj-1",
			sourceTaskId: REQUESTER_ID,
		}));
		await vi.waitFor(() => expect(pushFn).toHaveBeenCalled());
		const [, payload] = pushFn.mock.calls[0] as [string, Record<string, unknown>];
		expect(payload.defaultPriority).toBe("P4");

		resolveAgentRequest(payload.requestId as string, { approved: true });
		await respPromise;
		expect(launchTaskWithAgentChoice).toHaveBeenCalledWith(expect.objectContaining({
			choice: expect.objectContaining({ priority: "P4" }),
		}));
	});

	it("launches with the priority the user picked in the dialog", async () => {
		const target = makeTask();
		setupBoard(target);
		const pushFn = vi.fn();
		vi.mocked(getPushMessage).mockReturnValue(pushFn);
		vi.mocked(launchTaskWithAgentChoice).mockResolvedValue({ ...target, status: "in-progress" });

		const respPromise = handleRequest(moveRequest({
			taskId: TARGET_ID,
			newStatus: "in-progress",
			projectId: "proj-1",
			sourceTaskId: REQUESTER_ID,
		}));
		await vi.waitFor(() => expect(pushFn).toHaveBeenCalled());
		const [, payload] = pushFn.mock.calls[0] as [string, Record<string, unknown>];

		resolveAgentRequest(payload.requestId as string, {
			approved: true,
			launch: { agentId: null, configId: null, priority: "P1" },
		});
		await respPromise;
		expect(launchTaskWithAgentChoice).toHaveBeenCalledWith(expect.objectContaining({
			choice: expect.objectContaining({ priority: "P1" }),
		}));
	});

	it("addresses variants by task id — a variant group shares one seq", async () => {
		const target = makeTask();
		const variantRequester = { ...requester, variantIndex: 1 };
		const project = makeProject();
		vi.mocked(data.getProject).mockResolvedValue(project);
		vi.mocked(data.loadProjects).mockResolvedValue([project]);
		vi.mocked(data.loadTasks).mockResolvedValue([target, variantRequester]);
		const pushFn = vi.fn();
		vi.mocked(getPushMessage).mockReturnValue(pushFn);
		vi.mocked(launchTaskWithAgentChoice).mockResolvedValue({ ...target, status: "in-progress", variantIndex: 2 });

		const respPromise = handleRequest(moveRequest({
			taskId: TARGET_ID,
			newStatus: "in-progress",
			projectId: "proj-1",
			sourceTaskId: REQUESTER_ID,
		}));
		await vi.waitFor(() => expect(pushFn).toHaveBeenCalled());
		const [, payload] = pushFn.mock.calls[0] as [string, Record<string, unknown>];
		resolveAgentRequest(payload.requestId as string, {
			approved: true,
			launch: { agentId: "builtin-claude", configId: "claude-auto", accountId: null },
		});

		const resp = await respPromise;
		expect((resp.data as { replyCommand: string }).replyCommand).toBe(`dev3 message --task ${TARGET_ID} "your message"`);
		expect(deliverLaunchHandoff).toHaveBeenCalledWith(expect.objectContaining({
			source: expect.objectContaining({ seq: 3, variantIndex: 1 }),
		}));
	});

	it("launches nothing when the user declines", async () => {
		setupBoard(makeTask());
		const pushFn = vi.fn();
		vi.mocked(getPushMessage).mockReturnValue(pushFn);

		const respPromise = handleRequest(moveRequest({
			taskId: TARGET_ID,
			newStatus: "in-progress",
			projectId: "proj-1",
			sourceTaskId: REQUESTER_ID,
		}));
		await vi.waitFor(() => expect(pushFn).toHaveBeenCalled());

		const payload = pushFn.mock.calls[0][1] as { requestId: string };
		resolveAgentRequest(payload.requestId, { approved: false });

		const resp = await respPromise;
		expect(resp.data).toEqual({ approved: false });
		expect(launchTaskWithAgentChoice).not.toHaveBeenCalled();
		expect(deliverLaunchHandoff).not.toHaveBeenCalled();
	});

	it("errors instead of launching when no app window can show the dialog", async () => {
		setupBoard(makeTask());
		vi.mocked(getPushMessage).mockReturnValue(null);

		const resp = await handleRequest(moveRequest({
			taskId: TARGET_ID,
			newStatus: "in-progress",
			projectId: "proj-1",
			sourceTaskId: REQUESTER_ID,
		}));

		expect(resp.ok).toBe(false);
		expect(resp.error).toContain("No app window is connected");
		expect(launchTaskWithAgentChoice).not.toHaveBeenCalled();
	});

	it("joins an existing pending launch request instead of pushing a second dialog", async () => {
		setupBoard(makeTask());
		const pushFn = vi.fn();
		vi.mocked(getPushMessage).mockReturnValue(pushFn);

		const params = {
			taskId: TARGET_ID,
			newStatus: "in-progress",
			projectId: "proj-1",
			sourceTaskId: REQUESTER_ID,
		};
		const first = handleRequest(moveRequest(params));
		await vi.waitFor(() => expect(pushFn).toHaveBeenCalledTimes(1));
		const second = handleRequest(moveRequest(params));
		await new Promise((r) => setTimeout(r, 10));
		expect(pushFn).toHaveBeenCalledTimes(1);

		const payload = pushFn.mock.calls[0][1] as { requestId: string };
		resolveAgentRequest(payload.requestId, { approved: false });

		const [respA, respB] = await Promise.all([first, second]);
		expect(respA.data).toEqual({ approved: false });
		expect(respB.data).toEqual({ approved: false });
	});
});

describe("task.createScratchAndRun", () => {
	function scratchRequest(params: Record<string, unknown>): CliRequest {
		return { id: "req-1", method: "task.createScratchAndRun", params };
	}

	it("requires a requesting task — a human has the Scratch Task button", async () => {
		setupBoard(makeTask());

		const resp = await handleRequest(scratchRequest({ projectId: "proj-1" }));
		expect(resp.ok).toBe(false);
		expect(resp.error).toContain("inside a task worktree");
		expect(createScratchTask).not.toHaveBeenCalled();
	});

	it("creates the scratch task and launches it with the picked agent", async () => {
		const scratch = makeTask({ title: "Scratch — 14:32", description: "Scratch — 14:32", scratch: true, seq: 9 });
		setupBoard(scratch);
		vi.mocked(createScratchTask).mockResolvedValue(scratch);
		vi.mocked(launchTaskWithAgentChoice).mockResolvedValue({ ...scratch, status: "in-progress" });
		const pushFn = vi.fn();
		vi.mocked(getPushMessage).mockReturnValue(pushFn);

		const respPromise = handleRequest(scratchRequest({ projectId: "proj-1", sourceTaskId: REQUESTER_ID }));
		await vi.waitFor(() => expect(pushFn).toHaveBeenCalled());

		const [event, payload] = pushFn.mock.calls[0] as [string, Record<string, unknown>];
		expect(event).toBe("agentLaunchRequested");
		expect(payload.scratch).toBe(true);

		resolveAgentRequest(payload.requestId as string, {
			approved: true,
			launch: { agentId: "codex", configId: "codex-default" },
		});

		const resp = await respPromise;
		expect(resp.ok).toBe(true);
		expect(resp.data).toMatchObject({ approved: true, seq: 9 });
		expect(deleteTask).not.toHaveBeenCalled();
	});

	it("discards the placeholder task when the user declines", async () => {
		const scratch = makeTask({ scratch: true });
		setupBoard(scratch);
		vi.mocked(createScratchTask).mockResolvedValue(scratch);
		const pushFn = vi.fn();
		vi.mocked(getPushMessage).mockReturnValue(pushFn);

		const respPromise = handleRequest(scratchRequest({ projectId: "proj-1", sourceTaskId: REQUESTER_ID }));
		await vi.waitFor(() => expect(pushFn).toHaveBeenCalled());

		const payload = pushFn.mock.calls[0][1] as { requestId: string };
		resolveAgentRequest(payload.requestId, { approved: false });

		const resp = await respPromise;
		expect(resp.data).toEqual({ approved: false });
		// An empty scratch card must not be left littering To Do.
		expect(deleteTask).toHaveBeenCalledWith({ taskId: scratch.id, projectId: "proj-1" });
		expect(launchTaskWithAgentChoice).not.toHaveBeenCalled();
	});
});

describe("task.move — unanswered launch auto-approves", () => {
	it("pushes the deadline and launches itself when nobody answers", async () => {
		vi.mocked(loadSettings).mockReturnValue({
			updateChannel: "stable", taskSortOrder: "oldest-first", agentLaunchAutoApproveMinutes: 5,
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
		} as any);
		const target = makeTask();
		setupBoard(target);
		const pushFn = vi.fn();
		vi.mocked(getPushMessage).mockReturnValue(pushFn);
		vi.mocked(launchTaskWithAgentChoice).mockResolvedValue({ ...target, status: "in-progress" });

		// Installed BEFORE the request: the timer is created inside it, and a clock
		// swapped in afterwards would never own it.
		vi.useFakeTimers({ shouldAdvanceTime: true });
		try {
			const respPromise = handleRequest(moveRequest({
				taskId: TARGET_ID,
				newStatus: "in-progress",
				projectId: "proj-1",
				sourceTaskId: REQUESTER_ID,
			}));
			await vi.waitFor(() => expect(pushFn).toHaveBeenCalled());

			const payload = pushFn.mock.calls[0][1] as { autoApproveAt: number | null };
			// The dialog needs the deadline to render a countdown that matches the timer.
			expect(payload.autoApproveAt).toBeGreaterThan(Date.now());

			await vi.advanceTimersByTimeAsync(5 * 60_000);
			const resp = await respPromise;

			expect(resp.ok).toBe(true);
			expect(resp.data).toMatchObject({ approved: true });
			expect(launchTaskWithAgentChoice).toHaveBeenCalledTimes(1);
		} finally {
			vi.useRealTimers();
		}
	});

	it("carries no deadline when the setting is off", async () => {
		vi.mocked(loadSettings).mockReturnValue({
			updateChannel: "stable", taskSortOrder: "oldest-first", agentLaunchAutoApproveMinutes: 0,
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
		} as any);
		setupBoard(makeTask());
		const pushFn = vi.fn();
		vi.mocked(getPushMessage).mockReturnValue(pushFn);

		const respPromise = handleRequest(moveRequest({
			taskId: TARGET_ID,
			newStatus: "in-progress",
			projectId: "proj-1",
			sourceTaskId: REQUESTER_ID,
		}));
		await vi.waitFor(() => expect(pushFn).toHaveBeenCalled());

		const payload = pushFn.mock.calls[0][1] as { requestId: string; autoApproveAt: number | null };
		expect(payload.autoApproveAt).toBeNull();
		resolveAgentRequest(payload.requestId, { approved: false });
		await respPromise;
	});
});
