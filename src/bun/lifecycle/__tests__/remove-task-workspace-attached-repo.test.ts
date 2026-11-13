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
	classifyLinkedWorktree: vi.fn(async () => ({ kind: "plain" })),
	removeLinkedWorktree: vi.fn(async () => true),
	pruneWorktrees: vi.fn(async () => undefined),
	isWorktreeDirtyOrUnknown: vi.fn(async () => false),
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
vi.mock("../../temp-paths", () => ({ dev3TaskTempPath: vi.fn(() => "/tmp/dev3/task"), dev3TempPath: vi.fn((name: string) => `/tmp/${name}`) }));

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
	dropQueuedQuestionsAttention: vi.fn(),
}));


vi.mock("../../worktree-trust", () => ({ forgetWorktreeTrust: vi.fn(async () => undefined) }));
vi.mock("../../board-operations/task-notes", () => ({ addNote: vi.fn(async () => undefined) }));
vi.mock("../../board-operations/runtime", () => ({ boardPorts: { push: vi.fn(), clearMergeNotification: vi.fn(), syncTerminalTitle: vi.fn() } }));
vi.mock("../../agent-requests", () => ({ voidAgentRequestsForTask: vi.fn() }));
vi.mock("../../board-operations/types", () => ({ AGENT_ACTOR: { kind: "agent" } }));

import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import * as data from "../../data";
import * as git from "../../git";
import { executeLifecycleEffect, type LifecycleExecutionContext } from "../executor";
import type { LifecycleEffect } from "../effects";
import type { Project, Task } from "../../../shared/types";

const FOLDER = "/home/.dev3.0/ops/slug/aabbccdd/work";
const MAIN = "/repos/main";

const project = { id: "vp1", name: "Ops", kind: "virtual", path: "/home/.dev3.0/ops/slug", setupScript: "", devScript: "", cleanupScript: "", defaultBaseBranch: "main", createdAt: "" } as Project;
const remove = { type: "removeTaskWorkspace", onError: "abort" } as LifecycleEffect;

function run(task: Partial<Task>) {
	const full = { id: "aabbccdd-1111-2222-3333-444444444444", projectId: "vp1", worktreePath: FOLDER, ...task } as Task;
	return executeLifecycleEffect(remove, { project, sourceTask: full, task: full, stateTask: full } as unknown as LifecycleExecutionContext);
}

beforeEach(() => {
	vi.clearAllMocks();
	vi.mocked(git.classifyLinkedWorktree).mockResolvedValue({ kind: "plain" });
	vi.mocked(git.pruneWorktrees).mockResolvedValue(undefined);
	vi.mocked(rm).mockResolvedValue(undefined);
	vi.mocked(existsSync).mockReturnValue(true);
	vi.mocked(git.removeLinkedWorktree).mockResolvedValue(true);
	vi.mocked(data.updateTask).mockImplementation(async (_p, id, updates) => ({ id, ...updates }) as never);
});

describe("removeTaskWorkspace — a repo the agent made inside the task folder", () => {
	it("removes a linked worktree through git before deleting the folder, then prunes the main repo", async () => {
		vi.mocked(git.classifyLinkedWorktree).mockResolvedValue({ kind: "linked", mainRepo: MAIN });
		const order: string[] = [];
		vi.mocked(git.removeLinkedWorktree).mockImplementation(async () => { order.push("remove"); return true; });
		vi.mocked(rm).mockImplementation(async () => { order.push("rm"); });
		vi.mocked(git.pruneWorktrees).mockImplementation(async () => { order.push("prune"); });

		await run({ attachedRepo: `${FOLDER}/wt` });

		expect(git.classifyLinkedWorktree).toHaveBeenCalledWith(`${FOLDER}/wt`);
		expect(git.removeLinkedWorktree).toHaveBeenCalledWith(MAIN, `${FOLDER}/wt`);
		expect(rm).toHaveBeenCalledWith(FOLDER, { recursive: true, force: true });
		expect(git.pruneWorktrees).toHaveBeenCalledWith(MAIN);
		expect(order).toEqual(["remove", "rm", "prune"]);
	});

	it("on deletion also removes the folder itself when it is the linked worktree", async () => {
		vi.mocked(git.classifyLinkedWorktree).mockResolvedValue({ kind: "linked", mainRepo: MAIN });
		await run({ attachedRepo: FOLDER });
		expect(git.removeLinkedWorktree).toHaveBeenCalledWith(MAIN, FOLDER);
		expect(git.pruneWorktrees).toHaveBeenCalledWith(MAIN);
	});

	it("only removes the folder for a plain clone", async () => {
		await run({ attachedRepo: `${FOLDER}/clone` });
		expect(rm).toHaveBeenCalledWith(FOLDER, { recursive: true, force: true });
		expect(git.removeLinkedWorktree).not.toHaveBeenCalled();
		expect(git.pruneWorktrees).not.toHaveBeenCalled();
	});

	it("on deletion still removes the folder, without a git removal, when git cannot classify the repo", async () => {
		vi.mocked(git.classifyLinkedWorktree).mockResolvedValue({ kind: "unknown", error: "bad config" });
		await run({ attachedRepo: `${FOLDER}/wt` });
		expect(rm).toHaveBeenCalledTimes(1);
		expect(git.removeLinkedWorktree).not.toHaveBeenCalled();
		expect(git.pruneWorktrees).not.toHaveBeenCalled();
	});

	it("still removes the folder when the prune itself fails (it logs and never throws)", async () => {
		vi.mocked(git.classifyLinkedWorktree).mockResolvedValue({ kind: "linked", mainRepo: MAIN });
		vi.mocked(git.pruneWorktrees).mockResolvedValue(undefined);
		await expect(run({ attachedRepo: `${FOLDER}/wt` })).resolves.toEqual({});
		expect(rm).toHaveBeenCalledTimes(1);
	});

	it("deletes nothing and prunes nothing when the attached repo lies outside the folder", async () => {
		await run({ attachedRepo: "/elsewhere/repo" });
		expect(git.classifyLinkedWorktree).not.toHaveBeenCalled();
		expect(git.pruneWorktrees).not.toHaveBeenCalled();
		expect(rm).toHaveBeenCalledWith(FOLDER, { recursive: true, force: true });
	});

	it("worktree mode keeps pruning the attached repo and never asks for a main repo", async () => {
		await run({ attachedRepo: MAIN, opsWorktree: true });
		expect(git.classifyLinkedWorktree).not.toHaveBeenCalled();
		expect(git.pruneWorktrees).toHaveBeenCalledWith(MAIN);
	});
});

describe("removeAttachedWorktree — closing or resetting a plain Operations task", () => {
	const WT = `${FOLDER}/wt`;
	const task = (overrides: Partial<Task> = {}) =>
		({ id: "aabbccdd-1111-2222-3333-444444444444", projectId: "vp1", worktreePath: FOLDER, attachedRepo: WT, ...overrides }) as Task;
	const ctxFor = (t: Task) => ({ project, sourceTask: t, task: t, stateTask: t }) as unknown as LifecycleExecutionContext;
	// The user's dialog approved the repo the task has when the effect starts, unless a test says otherwise.
	const step = (type: string, ctx: LifecycleExecutionContext, extra: object = {}) =>
		executeLifecycleEffect({ type, onError: "continue", approvedAttachedRepo: WT, ...extra } as LifecycleEffect, ctx);

	it("removes a linked worktree through its main repo and detaches it in the terminal write", async () => {
		vi.mocked(git.classifyLinkedWorktree).mockResolvedValue({ kind: "linked", mainRepo: MAIN });
		const ctx = ctxFor(task());

		await step("removeAttachedWorktree", ctx);
		await step("persistTerminalTask", ctx, { status: "completed", onError: "abort" });

		expect(git.removeLinkedWorktree).toHaveBeenCalledWith(MAIN, WT);
		expect(rm).not.toHaveBeenCalled();
		expect(vi.mocked(data.updateTask).mock.calls[0]![2]).toMatchObject({ status: "completed", attachedRepo: null });
	});

	it("detaches it in the reset write too", async () => {
		vi.mocked(git.classifyLinkedWorktree).mockResolvedValue({ kind: "linked", mainRepo: MAIN });
		const current = task({ status: "in-progress", lifecycleStartedAt: "S" } as Partial<Task>);
		vi.mocked(data.updateTaskWith).mockImplementation(async (_p, _id, mutator) => {
			const { updates, result } = await mutator({ ...current });
			return { task: { ...current, ...updates }, result } as never;
		});
		const ctx = ctxFor(current);

		await step("removeAttachedWorktree", ctx);
		await step("persistResetTask", ctx, { consent: { worktreePath: FOLDER, lifecycleStartedAt: "S", attachedRepo: WT }, onError: "abort" });

		expect(ctx.task.attachedRepo).toBeNull();
		expect(ctx.task.status).toBe("todo");
	});

	it("keeps a worktree swapped in after the dialog: the approval named another repo", async () => {
		vi.mocked(git.classifyLinkedWorktree).mockResolvedValue({ kind: "linked", mainRepo: MAIN });
		const ctx = ctxFor(task({ attachedRepo: `${FOLDER}/wt-b` }));

		await step("removeAttachedWorktree", ctx, { approvedAttachedRepo: WT });
		await step("persistTerminalTask", ctx, { status: "completed", onError: "abort" });

		expect(git.removeLinkedWorktree).not.toHaveBeenCalled();
		expect(vi.mocked(data.updateTask).mock.calls[0]![2]).not.toHaveProperty("attachedRepo");
	});

	it("keeps the worktree when the move carried no approval at all", async () => {
		vi.mocked(git.classifyLinkedWorktree).mockResolvedValue({ kind: "linked", mainRepo: MAIN });
		const ctx = ctxFor(task());

		await step("removeAttachedWorktree", ctx, { approvedAttachedRepo: null });
		await step("persistTerminalTask", ctx, { status: "cancelled", onError: "abort" });

		expect(git.removeLinkedWorktree).not.toHaveBeenCalled();
		expect(vi.mocked(data.updateTask).mock.calls[0]![2]).not.toHaveProperty("attachedRepo");
	});

	it("removes it when the approval matches the attached repo", async () => {
		vi.mocked(git.classifyLinkedWorktree).mockResolvedValue({ kind: "linked", mainRepo: MAIN });
		await step("removeAttachedWorktree", ctxFor(task()), { approvedAttachedRepo: WT });
		expect(git.removeLinkedWorktree).toHaveBeenCalledWith(MAIN, WT);
	});

	it("detaches a worktree that is already gone (a retry after an earlier removal) without touching git", async () => {
		vi.mocked(existsSync).mockReturnValue(false);
		const ctx = ctxFor(task());

		await step("removeAttachedWorktree", ctx);
		await step("persistTerminalTask", ctx, { status: "completed", onError: "abort" });

		expect(git.classifyLinkedWorktree).not.toHaveBeenCalled();
		expect(git.removeLinkedWorktree).not.toHaveBeenCalled();
		expect(vi.mocked(data.updateTask).mock.calls[0]![2]).toMatchObject({ attachedRepo: null });
	});

	it("says the attached worktree is already removed when the reset write misses afterwards", async () => {
		vi.mocked(existsSync).mockReturnValue(false);
		const current = task({ status: "in-progress", lifecycleStartedAt: "S" } as Partial<Task>);
		vi.mocked(data.updateTaskWith).mockImplementation(async (_p, _id, mutator) => {
			const { updates, result } = await mutator({ ...current, lifecycleStartedAt: "other-run" });
			return { task: { ...current, ...updates }, result } as never;
		});
		const ctx = ctxFor(current);

		await step("removeAttachedWorktree", ctx);
		await expect(step("persistResetTask", ctx, { consent: { worktreePath: FOLDER, lifecycleStartedAt: "S", attachedRepo: WT }, onError: "abort" }))
			.rejects.toThrow(/its attached worktree is already removed/);
	});

	it("refuses the reset write when another client swapped the attached repo after the dialog", async () => {
		const current = task({ status: "in-progress", lifecycleStartedAt: "S", attachedRepo: `${FOLDER}/wt-b` } as Partial<Task>);
		vi.mocked(data.updateTaskWith).mockImplementation(async (_p, _id, mutator) => {
			const { updates, result } = await mutator({ ...current });
			return { task: { ...current, ...updates }, result } as never;
		});

		await expect(step("persistResetTask", ctxFor(current), { consent: { worktreePath: FOLDER, lifecycleStartedAt: "S", attachedRepo: WT }, onError: "abort" }))
			.rejects.toThrow(/changed elsewhere/);
	});

	it("removes nothing and keeps the attachment when git cannot classify the repo (it may hold unsaved work)", async () => {
		vi.mocked(git.classifyLinkedWorktree).mockResolvedValue({ kind: "unknown", error: "bad config" });
		const ctx = ctxFor(task());

		await expect(step("removeAttachedWorktree", ctx)).resolves.toEqual({});
		await step("persistTerminalTask", ctx, { status: "completed", onError: "abort" });

		expect(git.removeLinkedWorktree).not.toHaveBeenCalled();
		expect(vi.mocked(data.updateTask).mock.calls[0]![2]).not.toHaveProperty("attachedRepo");
	});

	it("keeps the attachment when the worktree could not be removed, and never throws", async () => {
		vi.mocked(git.classifyLinkedWorktree).mockResolvedValue({ kind: "linked", mainRepo: MAIN });
		vi.mocked(git.removeLinkedWorktree).mockResolvedValue(false);
		const ctx = ctxFor(task());

		await expect(step("removeAttachedWorktree", ctx)).resolves.toEqual({});
		await step("persistTerminalTask", ctx, { status: "cancelled", onError: "abort" });

		expect(vi.mocked(data.updateTask).mock.calls[0]![2]).not.toHaveProperty("attachedRepo");
	});

	it("leaves a plain clone alone", async () => {
		await step("removeAttachedWorktree", ctxFor(task()));
		expect(git.removeLinkedWorktree).not.toHaveBeenCalled();
	});

	it("does nothing for a repo outside the folder, the folder itself, nothing attached, or worktree mode", async () => {
		vi.mocked(git.classifyLinkedWorktree).mockResolvedValue({ kind: "linked", mainRepo: MAIN });
		await step("removeAttachedWorktree", ctxFor(task({ attachedRepo: FOLDER })));
		await step("removeAttachedWorktree", ctxFor(task({ attachedRepo: "/elsewhere/wt" })));
		await step("removeAttachedWorktree", ctxFor(task({ attachedRepo: null })));
		await step("removeAttachedWorktree", ctxFor(task({ opsWorktree: true })));
		expect(git.removeLinkedWorktree).not.toHaveBeenCalled();
	});
});
