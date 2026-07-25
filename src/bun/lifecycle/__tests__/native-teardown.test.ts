/**
 * Lifecycle teardown routed by the task's own persisted backend (seq 1292), and
 * ORDERED against the rest of teardown (seq 1298).
 *
 * `destroyTaskPty` must stop the tree the task actually owns, and `killDevServer`
 * must not reach for tmux on behalf of a native task that has no tmux session at
 * all. The resolver is REAL — the task record drives both branches. The ordering
 * suite drives the REAL transition table through the REAL executor, so "the native
 * tree stops before the cleanup script and the worktree removal" is proven on the
 * effect list the lifecycle actually emits for Complete, Cancel, preparation
 * cancellation, deletion, and a boot-time resume.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Project, Task, TaskStatus } from "../../../shared/types";
import type { LifecycleEffect } from "../effects";
import type { LifecycleEvent, LifecycleState } from "../events";
import type { LifecycleExecutionContext } from "../executor";

vi.mock("../../logger", () => ({
	createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

vi.mock("node:fs", () => ({ existsSync: vi.fn(() => true) }));
vi.mock("node:fs/promises", () => ({ mkdir: vi.fn(async () => undefined), rm: vi.fn(async () => undefined) }));

vi.mock("../../cow-clone", () => ({ clonePaths: vi.fn(async () => undefined) }));
vi.mock("../../data", () => ({ updateTask: vi.fn(async () => undefined), deleteTask: vi.fn(async () => undefined) }));
vi.mock("../../git", () => ({
	removeWorktree: vi.fn(async () => undefined),
	getBranchDiffStats: vi.fn(async () => ({ files: 1, insertions: 2, deletions: 3 })),
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

import * as data from "../../data";
import * as git from "../../git";
import * as pty from "../../pty-server";
import { killDevServerSession } from "../../rpc-handlers/tmux-pty";
import { tmux } from "../../tmux";
import { executeLifecycleEffect } from "../executor";
import { transition } from "../machine";

const TASK_ID = "aabbccdd-1111-2222-3333-444444444444";

function project(): Project {
	return {
		id: "proj-1",
		name: "Project",
		path: "/repo",
		setupScript: "",
		devScript: "",
		cleanupScript: "",
		defaultBaseBranch: "main",
		createdAt: "2026-07-01T00:00:00.000Z",
	};
}

function task(overrides: Record<string, unknown> = {}): Task {
	return {
		id: TASK_ID,
		seq: 1,
		projectId: "proj-1",
		title: "Task",
		description: "Task",
		status: "completed",
		baseBranch: "main",
		worktreePath: "/tmp/wt",
		tmuxSocket: "dev3",
		...overrides,
	} as unknown as Task;
}

function context(sourceTask: Task): LifecycleExecutionContext {
	return { project: project(), sourceTask, task: sourceTask } as unknown as LifecycleExecutionContext;
}

function effect(type: "destroyTaskPty" | "killDevServer"): LifecycleEffect {
	return { type, onError: "continue" } as LifecycleEffect;
}

beforeEach(() => {
	vi.clearAllMocks();
});

describe("destroyTaskPty", () => {
	it("stops the native tree for a task marked native", async () => {
		await executeLifecycleEffect(effect("destroyTaskPty"), context(task({ terminalBackend: "native" })));

		expect(pty.destroyNativeTaskSession).toHaveBeenCalledWith(TASK_ID);
		expect(pty.destroySession).not.toHaveBeenCalled();
	});

	it("keeps the tmux teardown for an unmarked task", async () => {
		await executeLifecycleEffect(effect("destroyTaskPty"), context(task()));

		expect(pty.destroySession).toHaveBeenCalledWith(TASK_ID, "dev3");
		expect(pty.destroyNativeTaskSession).not.toHaveBeenCalled();
	});
});

describe("killDevServer", () => {
	it("is skipped for a native task, which owns no tmux dev session", async () => {
		await executeLifecycleEffect(effect("killDevServer"), context(task({ terminalBackend: "native" })));

		expect(killDevServerSession).not.toHaveBeenCalled();
	});

	it("still tears the dev session down for an unmarked task", async () => {
		await executeLifecycleEffect(effect("killDevServer"), context(task()));

		expect(killDevServerSession).toHaveBeenCalledWith(TASK_ID, "dev3", "/tmp/wt");
	});
});

const calls: string[] = [];

function recordSideEffects(): void {
	calls.length = 0;
	vi.mocked(pty.destroyNativeTaskSession).mockImplementation(async () => {
		calls.push("stopNative");
	});
	vi.mocked(pty.destroySession).mockImplementation(() => {
		calls.push("destroyTmux");
	});
	vi.mocked(tmux.spawnAttachedSession).mockImplementation(() => {
		calls.push("cleanupScript");
		return { exited: Promise.resolve(0) } as unknown as ReturnType<typeof tmux.spawnAttachedSession>;
	});
	vi.mocked(git.getBranchDiffStats).mockImplementation(async () => {
		calls.push("diffStats");
		return { files: 1, insertions: 2, deletions: 3, fileStats: [] };
	});
	vi.mocked(git.removeWorktree).mockImplementation(async () => {
		calls.push("removeWorktree");
	});
	vi.mocked(data.deleteTask).mockImplementation(async () => {
		calls.push("deleteTaskRecord");
	});
	vi.mocked(data.updateTask).mockImplementation(async (_project, id, updates) => ({
		...task({ id }),
		...updates,
	}) as Task);
	(globalThis as unknown as { Bun: { write: unknown } }).Bun.write = vi.fn(async () => 0);
}

function fullContext(sourceTask: Task): LifecycleExecutionContext {
	return {
		project: project(),
		sourceTask,
		task: sourceTask,
		stateTask: sourceTask,
		dropPosition: "top",
		hooks: {
			dispatchFollowUp: vi.fn(async () => sourceTask),
			processInline: vi.fn(async () => sourceTask),
			runDetached: vi.fn(),
			reserveMergePrompt: vi.fn(),
			setPrPromoted: vi.fn(),
			setPrSignalKey: vi.fn(),
			clearMergeThrottle: vi.fn(),
			clearTaskRuntime: vi.fn(),
		},
	} as unknown as LifecycleExecutionContext;
}

function activeState(status: TaskStatus, overrides: Partial<LifecycleState> = {}): LifecycleState {
	return {
		column: { status, customColumnId: null },
		runtime: { phase: "running" },
		facts: {
			hasWorktree: true,
			projectKind: "git",
			hasPrIdentity: false,
			peerReviewEnabled: true,
		},
		...overrides,
	};
}

interface TeardownRun {
	order: string[];
	error: Error | null;
	compensation: LifecycleEvent | null;
}

/**
 * Run a transition's effects the way the lifecycle service does — in order, with
 * `abort` stopping the run — so the assertions read the real sequencing.
 */
async function runTeardown(state: LifecycleState, event: LifecycleEvent, sourceTask: Task): Promise<TeardownRun> {
	const ctx = fullContext(sourceTask);
	for (const declared of transition(state, event).effects) {
		try {
			await executeLifecycleEffect(declared, ctx);
		} catch (error) {
			if (declared.onError === "continue") continue;
			return {
				order: [...calls],
				error: error as Error,
				compensation: declared.compensatingEvent ?? null,
			};
		}
	}
	return { order: [...calls], error: null, compensation: null };
}

function nativeTask(overrides: Record<string, unknown> = {}): Task {
	return task({ terminalBackend: "native", status: "in-progress", ...overrides });
}

describe("native teardown ordering", () => {
	beforeEach(() => {
		recordSideEffects();
	});

	it.each([
		["completed" as const],
		["cancelled" as const],
	])("stops the native tree before cleanup and worktree removal when moving to %s", async (terminalStatus) => {
		const run = await runTeardown(activeState("in-progress"), {
			type: "moveRequested",
			target: { status: terminalStatus },
			runId: "run-1",
		}, nativeTask());

		expect(run.error).toBeNull();
		expect(run.order).toEqual(["stopNative", "cleanupScript", "diffStats", "removeWorktree"]);
	});

	it("stops the native tree before cleanup when a preparation is cancelled", async () => {
		const preparing = activeState("in-progress", {
			runtime: { phase: "preparing", stage: "launching-pty", runId: "run-p", origin: { status: "todo", customColumnId: null } },
			facts: { hasWorktree: true, projectKind: "git", hasPrIdentity: false, peerReviewEnabled: true },
		});

		const run = await runTeardown(preparing, { type: "preparationCancelled", runId: "run-p" }, nativeTask());

		expect(run.error).toBeNull();
		expect(run.order).toEqual(["stopNative", "cleanupScript", "removeWorktree"]);
	});

	it("stops the native tree before workspace removal and the record delete", async () => {
		const run = await runTeardown(activeState("in-progress"), { type: "deleteRequested" }, nativeTask());

		expect(run.error).toBeNull();
		expect(run.order).toEqual(["stopNative", "cleanupScript", "removeWorktree", "deleteTaskRecord"]);
	});

	it("stops an unattached native tree first when boot resumes an interrupted teardown", async () => {
		const tearingDown = activeState("completed", {
			runtime: { phase: "tearing-down", targetStatus: "completed", runId: "run-b" },
		});

		const run = await runTeardown(tearingDown, {
			type: "bootObserved",
			reality: { worktreeExists: true, terminalAlive: false },
		}, nativeTask({ status: "completed" }));

		expect(run.error).toBeNull();
		expect(run.order).toEqual(["stopNative", "cleanupScript", "diffStats", "removeWorktree"]);
	});

	it("aborts before cleanup, diff capture and worktree removal when the native stop fails", async () => {
		vi.mocked(pty.destroyNativeTaskSession).mockImplementation(async () => {
			calls.push("stopNative");
			throw new Error("native session dev3-task-aabbccdd is still present after teardown");
		});

		const run = await runTeardown(activeState("in-progress"), {
			type: "moveRequested",
			target: { status: "completed" },
			runId: "run-1",
		}, nativeTask());

		expect(run.order).toEqual(["stopNative"]);
		expect(run.error?.message).toMatch(/still present after teardown/);
		expect(run.compensation).toMatchObject({ type: "teardownFailed", runId: "run-1" });
	});

	it("keeps the task record and workspace when a delete's native stop fails", async () => {
		vi.mocked(pty.destroyNativeTaskSession).mockRejectedValue(new Error("host did not exit"));

		const run = await runTeardown(activeState("in-progress"), { type: "deleteRequested" }, nativeTask());

		expect(run.order).toEqual([]);
		expect(run.error?.message).toBe("host did not exit");
		expect(data.deleteTask).not.toHaveBeenCalled();
		expect(git.removeWorktree).not.toHaveBeenCalled();
	});

	it("completes cleanup exactly once on the retry after the stop finally succeeds", async () => {
		vi.mocked(pty.destroyNativeTaskSession).mockRejectedValueOnce(new Error("host did not exit"));
		const complete = (): Promise<TeardownRun> => runTeardown(activeState("in-progress"), {
			type: "moveRequested",
			target: { status: "completed" },
			runId: "run-1",
		}, nativeTask());

		const failed = await complete();
		const retried = await complete();

		expect(failed.error).not.toBeNull();
		expect(retried.error).toBeNull();
		expect(retried.order).toEqual(["stopNative", "cleanupScript", "diffStats", "removeWorktree"]);
		expect(tmux.spawnAttachedSession).toHaveBeenCalledTimes(1);
		expect(git.removeWorktree).toHaveBeenCalledTimes(1);
	});

	it("never lets a legacy tmux teardown abort the rest of the lifecycle", async () => {
		vi.mocked(pty.destroySession).mockImplementation(() => {
			calls.push("destroyTmux");
			throw new Error("tmux kill-session blew up");
		});

		const run = await runTeardown(activeState("in-progress"), {
			type: "moveRequested",
			target: { status: "completed" },
			runId: "run-1",
		}, task({ status: "in-progress" }));

		expect(run.error).toBeNull();
		expect(run.order).toEqual(["destroyTmux", "cleanupScript", "diffStats", "removeWorktree"]);
		expect(pty.destroyNativeTaskSession).not.toHaveBeenCalled();
	});
});
