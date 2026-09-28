import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../logger", () => ({
	createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

vi.mock("node:fs", () => ({ existsSync: vi.fn(() => true) }));
vi.mock("node:fs/promises", () => ({ mkdir: vi.fn(async () => undefined), rm: vi.fn(async () => undefined) }));

vi.mock("../../cow-clone", () => ({ clonePaths: vi.fn(async () => undefined) }));
vi.mock("../../data", () => ({
	updateTask: vi.fn(async () => undefined),
	deleteTask: vi.fn(async () => undefined),
	updateTaskWith: vi.fn(),
}));
vi.mock("../../git", () => ({
	removeWorktree: vi.fn(async () => ({ deleted: [], kept: [] })),
	assertWorkspaceReclaimable: vi.fn(async () => undefined),
	getBranchDiffStats: vi.fn(async () => ({ files: 1, insertions: 2, deletions: 3 })),
	resolveCompareRef: vi.fn(async (_path: string, base: string) => `origin/${base}`),
	taskDir: vi.fn(() => "/managed/task"),
	virtualWorkDir: vi.fn(() => "/managed/ops"),
}));
vi.mock("../../paths", () => ({ DEV3_HOME: "/home/.dev3.0", OPS_DIR: "/home/.dev3.0/ops" }));
vi.mock("../../port-pool", () => ({ releasePorts: vi.fn(), getPortAssignments: vi.fn(() => []) }));
vi.mock("../../preparation-runtime", () => ({
	assertTaskPreparationActive: vi.fn(),
	markTaskPreparationCancelled: vi.fn(() => ({
		pids: [],
		settled: Promise.resolve(),
		trackedProcessesExited: Promise.resolve(),
		reentrant: false,
	})),
	reportCurrentPreparationStage: vi.fn(),
	withTaskPreparationRunId: vi.fn(),
}));

vi.mock("../../agent-graceful-exit", () => ({
	requestGracefulAgentExit: vi.fn(async () => ({ kind: "skipped", reason: "no-agent-pane" })),
}));

vi.mock("../../pty-server", () => ({
	destroySession: vi.fn(),
	destroyNativeTaskSession: vi.fn(async () => undefined),
}));

vi.mock("../../repo-config", () => ({}));
vi.mock("../../settings", () => ({ loadSettings: vi.fn(async () => ({})), loadSettingsSync: vi.fn(() => ({})) }));
vi.mock("../../shell-env", () => ({ getUserShell: vi.fn(() => "/bin/zsh") }));
vi.mock("../../spawn", () => ({ spawn: vi.fn(() => ({ exited: Promise.resolve(0) })) }));
vi.mock("../../temp-paths", () => ({ dev3TaskTempPath: vi.fn(() => "/tmp/dev3/task") }));

vi.mock("../../tmux", () => ({
	DEFAULT_TMUX_SOCKET: "dev3",
	activeTmuxConfigPath: vi.fn(() => "/tmp/dev3.tmux.conf"),
	cleanupSessionName: vi.fn((taskId: string) => `dev3-cleanup-${taskId.slice(0, 8)}`),
	tmux: {
		killSession: vi.fn(async () => undefined),
		spawnAttachedSession: vi.fn(() => ({ exited: Promise.resolve(0) })),
	},
}));

vi.mock("../../rpc-handlers/tmux-pty", () => ({
	cleanupTaskTmuxState: vi.fn(),
	killDevServerSession: vi.fn(async () => undefined),
	launchColumnAgent: vi.fn(async () => undefined),
	launchTaskPty: vi.fn(async () => undefined),
}));

vi.mock("../../rpc-handlers/settings-config", () => ({
	resolveOperationalProjectConfig: vi.fn(async () => ({ devScript: "", portCount: 0 })),
}));

vi.mock("../../rpc-handlers/shared", () => ({
	buildScriptRunnerCommand: vi.fn((path: string) => `/bin/zsh ${path}`),
	buildTaskLifecycleEnv: vi.fn(() => ({})),
	getPushMessage: vi.fn(() => null),
	log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
	notifyWatchedTaskEvent: vi.fn(),
	notifyWatchedTaskStatusChange: vi.fn(),
	pushCliAttention: vi.fn(),
}));


vi.mock("../../worktree-trust", () => ({ forgetWorktreeTrust: vi.fn(async () => undefined) }));
vi.mock("../../board-operations/task-notes", () => ({ addNote: vi.fn(async () => undefined) }));
vi.mock("../../board-operations/runtime", () => ({ boardPorts: { push: vi.fn(), clearMergeNotification: vi.fn() } }));
vi.mock("../../agent-requests", () => ({ voidAgentRequest: vi.fn(() => false) }));
vi.mock("../../board-operations/types", () => ({ AGENT_ACTOR: { kind: "agent" } }));

import * as data from "../../data";
import * as git from "../../git";
import { voidAgentRequest } from "../../agent-requests";
import { addNote } from "../../board-operations/task-notes";
import { AGENT_ACTOR } from "../../board-operations/types";
import { executeLifecycleEffect, type LifecycleExecutionContext } from "../executor";
import type { LifecycleEffect } from "../effects";
import type { Project, Task } from "../../../shared/types";

const TASK_ID = "aabbccdd-1111-2222-3333-444444444444";
const PATH = "/wt/aabbccdd/worktree";
const STARTED = "2026-09-25T10:00:00.000Z";
const CONSENT = { worktreePath: PATH, lifecycleStartedAt: STARTED };

function project(): Project {
	return { id: "proj-1", name: "P", path: "/repo", setupScript: "", devScript: "", cleanupScript: "", defaultBaseBranch: "main", createdAt: "" };
}

function liveTask(overrides: Partial<Task> = {}): Task {
	return {
		id: TASK_ID, seq: 7, projectId: "proj-1", title: "Build it", customTitle: "Build the thing", titleEditedByUser: true,
		description: "Do the work", overview: "halfway", status: "review-by-user", priority: "P1", baseBranch: "main",
		worktreePath: PATH, branchName: "feat/dev3-thing", groupId: "g1", variantIndex: 1, agentId: "claude", configId: "c1",
		accountId: "acct", existingBranch: null, labelIds: ["l1"], notes: [{ id: "n1", content: "keep me", source: "user", createdAt: "", updatedAt: "" }],
		customColumnId: "col-1", hibernated: true, sessionState: { panes: [] }, prNumber: 12, prUrl: "https://pr", prStatusCache: null,
		mergeCompletionPrompt: null, preparationError: "old", setupFailedExitCode: 1, setupFailedAgentRunning: true, cloneFailures: [],
		lifecycleStartedAt: STARTED, runtimeState: { runtime: "running", updatedAt: 1 }, createdAt: "", updatedAt: "",
		...overrides,
	} as Task;
}

function ctx(task: Task): LifecycleExecutionContext {
	return { project: project(), sourceTask: task, task, stateTask: task } as unknown as LifecycleExecutionContext;
}

function storeWith(current: Task): { get: () => Task } {
	let stored = { ...current };
	vi.mocked(data.updateTaskWith).mockImplementation(async (_p, _id, mutator) => {
		const { updates, result } = await mutator({ ...stored });
		stored = { ...stored, ...updates };
		return { task: stored, result } as never;
	});
	return { get: () => stored };
}

const persist = (consent = CONSENT) => ({ type: "persistResetTask", consent, onError: "abort" }) as LifecycleEffect;

beforeEach(() => vi.clearAllMocks());

describe("persistResetTask — the one compare-and-set write (S2, T11, T12)", () => {
	it("keeps the card's identity and reusable configuration, clears the discarded run", async () => {
		const store = storeWith(liveTask());
		await executeLifecycleEffect(persist(), ctx(liveTask()));
		const after = store.get();
		expect(after).toMatchObject({
			id: TASK_ID, seq: 7, title: "Build it", customTitle: "Build the thing", titleEditedByUser: true,
			description: "Do the work", overview: "halfway", priority: "P1", groupId: "g1", variantIndex: 1,
			agentId: "claude", configId: "c1", accountId: "acct", labelIds: ["l1"],
		});
		expect(after.notes?.map((n) => n.content)).toEqual(["keep me"]);
		expect(after).toMatchObject({
			status: "todo", customColumnId: null, worktreePath: null, branchName: null, hibernated: false,
			sessionState: null, prNumber: null, prUrl: null, preparationError: null, setupFailedExitCode: null, cloneFailures: null,
		});
		expect(after.lifecycleStartedAt).toBeUndefined();
		expect(after.runtimeState?.runtime).toBe("idle");
		// S7: no approval about the ended run may land on the fresh card.
		expect(vi.mocked(voidAgentRequest).mock.calls.map(([kind]) => kind).sort()).toEqual(["cancel", "complete", "reset"]);
	});

	it("S8: drops messages queued for the stopped agent, keeps the card's own deferred start", async () => {
		const scheduledLaunch = { at: "2026-09-26T09:00:00.000Z" } as Task["scheduledLaunch"];
		const store = storeWith(liveTask({ scheduledMessages: [{ id: "m1" }] as never, scheduledLaunch }));
		await executeLifecycleEffect(persist(), ctx(liveTask()));
		expect(store.get().scheduledMessages).toBeNull();
		expect(store.get().scheduledLaunch).toEqual(scheduledLaunch);
	});

	it("S1: records the branches it kept, and hands the outcome to the door", async () => {
		storeWith(liveTask());
		const { takeResetBranchOutcome } = await import("../executor");
		const outcome = { deleted: [], kept: [{ name: "release/2.0", reason: "not-owned" as const }, { name: "gone", reason: "missing" as const }] };
		const context = { ...ctx(liveTask()), resetBranchOutcome: outcome } as LifecycleExecutionContext;
		await executeLifecycleEffect(persist(), context);
		const [, , , content] = vi.mocked(addNote).mock.calls[0]!;
		expect(content).toContain("kept `release/2.0` (dev3 did not create it for this task)");
		expect(content).not.toContain("gone");
		expect(takeResetBranchOutcome(TASK_ID)).toEqual(outcome);
		expect(takeResetBranchOutcome(TASK_ID)).toBeNull();
	});

	it("writes nothing when another writer moved the task to a new run under the lock", async () => {
		const store = storeWith(liveTask({ lifecycleStartedAt: "2026-09-25T12:00:00.000Z" }));
		await expect(executeLifecycleEffect(persist(), ctx(liveTask()))).rejects.toThrow(/changed elsewhere.*nothing was written/);
		expect(store.get().status).toBe("review-by-user");
		expect(store.get().worktreePath).toBe(PATH);
	});

	it("says the worktree is already gone when the CAS misses after removal", async () => {
		storeWith(liveTask({ worktreePath: "/other" }));
		const context = { ...ctx(liveTask()), resetWorktreeRemoved: true } as LifecycleExecutionContext;
		await expect(executeLifecycleEffect(persist(), context)).rejects.toThrow(/already removed — reset it again/);
	});

	it("refuses to resurrect a task that was completed meanwhile", async () => {
		storeWith(liveTask({ status: "completed" }));
		await expect(executeLifecycleEffect(persist(), ctx(liveTask()))).rejects.toThrow(/changed elsewhere/);
	});

	it("writes the Codex scan floor in the same compare-and-set, raising an older one", async () => {
		const store = storeWith(liveTask({ codexScanFloorAt: "2026-01-01T00:00:00.000Z" }));
		const before = Date.now();
		await executeLifecycleEffect(persist(), ctx(liveTask()));
		expect(Date.parse(store.get().codexScanFloorAt!)).toBeGreaterThanOrEqual(before);
		expect(vi.mocked(data.updateTaskWith)).toHaveBeenCalledTimes(1);
	});

	it("writes no floor when the compare-and-set misses", async () => {
		const store = storeWith(liveTask({ lifecycleStartedAt: "2026-09-25T12:00:00.000Z" }));
		await expect(executeLifecycleEffect(persist(), ctx(liveTask()))).rejects.toThrow(/changed elsewhere/);
		expect(store.get().codexScanFloorAt).toBeUndefined();
	});
});

describe("resetWorktree — owned branches only, noted first (S1, S4, S7)", () => {
	it("removes with the task-owned policy and writes an intent-worded recovery note per deleted branch", async () => {
		vi.mocked(git.removeWorktree).mockImplementation(async (_p, _t, options) => {
			await options?.beforeBranchDelete?.({ name: "feat/dev3-thing", sha: "abc123", commitsOnlyHere: 2 });
			return { deleted: [{ name: "feat/dev3-thing", sha: "abc123" }], kept: [] };
		});
		const context = ctx(liveTask());
		await executeLifecycleEffect({ type: "resetWorktree", onError: "abort" } as LifecycleEffect, context);
		expect(vi.mocked(git.removeWorktree).mock.calls[0]![2]).toMatchObject({ branchPolicy: "task-owned" });
		const [, noteProject, noteTaskId, content, actor, source] = vi.mocked(addNote).mock.calls[0]!;
		expect([noteProject.id, noteTaskId, actor, source]).toEqual(["proj-1", TASK_ID, AGENT_ACTOR, undefined]);
		expect(content).toContain("is deleting branch `feat/dev3-thing` at abc123");
		expect(content).toContain("git branch feat/dev3-thing-recovered abc123");
		expect(content).not.toMatch(/was deleted|two weeks|2 weeks/);
		expect(context.resetWorktreeRemoved).toBe(true);
		// S9: a note written mid-teardown must not push the still-active record.
		const ports = vi.mocked(addNote).mock.calls[0]![0] as unknown as { push: () => void };
		expect(ports.push).not.toBe((await import("../../board-operations/runtime")).boardPorts.push);
	});

	it("a count git could not compute reads as unknown, not zero", async () => {
		vi.mocked(git.removeWorktree).mockImplementation(async (_p, _t, options) => {
			await options?.beforeBranchDelete?.({ name: "dev3/task-aabbccdd", sha: "abc", commitsOnlyHere: null });
			return { deleted: [], kept: [] };
		});
		await executeLifecycleEffect({ type: "resetWorktree", onError: "abort" } as LifecycleEffect, ctx(liveTask()));
		expect(vi.mocked(addNote).mock.calls[0]![3]).toContain("an unknown number of commit(s)");
	});

	it("a failing removal propagates (abort) and does not mark the worktree removed", async () => {
		vi.mocked(git.removeWorktree).mockRejectedValue(new Error("worktree is locked"));
		const context = ctx(liveTask());
		await expect(executeLifecycleEffect({ type: "resetWorktree", onError: "abort" } as LifecycleEffect, context)).rejects.toThrow("locked");
		expect(context.resetWorktreeRemoved).toBeUndefined();
	});
});

describe("episode end voids pending reset approvals", () => {
	it("persistTerminalTask voids a reset request for that task", async () => {
		vi.mocked(data.updateTask).mockResolvedValue(liveTask({ status: "cancelled" }));
		await executeLifecycleEffect({ type: "persistTerminalTask", status: "cancelled", onError: "abort" } as LifecycleEffect, ctx(liveTask()));
		expect(voidAgentRequest).toHaveBeenCalledWith("reset", TASK_ID);
	});

	it("persistTerminalTask writes the Codex scan floor with the terminal status", async () => {
		vi.mocked(data.updateTask).mockResolvedValue(liveTask({ status: "completed" }));
		const before = Date.now();
		await executeLifecycleEffect({ type: "persistTerminalTask", status: "completed", onError: "abort" } as LifecycleEffect, ctx(liveTask()));
		const updates = vi.mocked(data.updateTask).mock.calls[0]![2];
		expect(updates).toMatchObject({ status: "completed" });
		expect(Date.parse(updates.codexScanFloorAt!)).toBeGreaterThanOrEqual(before);
	});
});

describe("judgeFailureWorkspace fails closed (S-F1a)", () => {
	it("ANY error from the judge keeps the folder: cleanup script, reaper and removal all stand down", async () => {
		vi.mocked(git.assertWorkspaceReclaimable).mockRejectedValue(new Error("EIO: i/o error"));
		const context = ctx(liveTask({ worktreePath: null }));
		await executeLifecycleEffect({ type: "judgeFailureWorkspace", onError: "continue" } as LifecycleEffect, context);
		expect(context.failureWorkspaceKept).toContain("could not be checked (EIO: i/o error)");
		await executeLifecycleEffect({ type: "removeWorktree", allowDerivedPath: true, failureCleanup: true, onError: "continue" } as LifecycleEffect, context);
		expect(git.removeWorktree).not.toHaveBeenCalled();
	});
});
