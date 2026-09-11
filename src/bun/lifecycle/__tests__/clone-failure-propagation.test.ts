/**
 * A clone path that fails to copy must reach the task, not just the log (issue #1728).
 *
 * Cloning is the only preparation hook that finishes BEFORE the agent launches, so
 * a silent miss changes what the agent reads with nothing on screen to say so. The
 * suite drives the REAL `prepareTask` effect through the REAL executor with a faked
 * `clonePaths`, and asserts on what is written to the task record.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Project, Task } from "../../../shared/types";
import type { LifecycleEffect } from "../effects";
import type { LifecycleExecutionContext } from "../executor";

vi.mock("../../logger", () => ({
	createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock("node:fs", () => ({ existsSync: vi.fn(() => true) }));
vi.mock("node:fs/promises", () => ({ mkdir: vi.fn(async () => undefined), rm: vi.fn(async () => undefined) }));

const clonePaths = vi.fn(async () => [] as unknown[]);
vi.mock("../../cow-clone", () => ({ clonePaths: (...args: unknown[]) => clonePaths(...(args as [])) }));

vi.mock("../../data", () => ({
	updateTask: vi.fn(async (_project: Project, id: string, updates: Partial<Task>) => ({ id, ...updates })),
	deleteTask: vi.fn(async () => undefined),
}));
vi.mock("../../git", () => ({
	createWorktree: vi.fn(async () => ({ worktreePath: "/tmp/wt", branchName: "feat/x" })),
	applySparseCheckout: vi.fn(async () => undefined),
	taskDir: vi.fn(() => "/managed/task"),
	virtualWorkDir: vi.fn(() => "/managed/ops"),
}));
vi.mock("../../paths", () => ({ DEV3_HOME: "/home/.dev3.0", OPS_DIR: "/home/.dev3.0/ops" }));
vi.mock("../../port-pool", () => ({ releasePorts: vi.fn(), getPortAssignments: vi.fn(() => []) }));
vi.mock("../../preparation-runtime", () => ({
	assertTaskPreparationActive: vi.fn(),
	markTaskPreparationCancelled: vi.fn(),
	reportCurrentPreparationStage: vi.fn(async () => undefined),
	withTaskPreparationRunId: vi.fn(async (
		_taskId: string,
		_label: string,
		_runId: string,
		fn: () => Promise<unknown>,
	) => fn()),
}));
vi.mock("../../pty-server", () => ({ destroySession: vi.fn(), destroyNativeTaskSession: vi.fn() }));
vi.mock("../../repo-config", () => ({ resolveProjectConfig: vi.fn(async (p: Project) => p) }));
vi.mock("../../settings", () => ({ loadSettingsSync: vi.fn(() => ({})) }));
vi.mock("../../shell-env", () => ({ getUserShell: vi.fn(() => "/bin/zsh") }));
vi.mock("../../spawn", () => ({ spawn: vi.fn(() => ({ exited: Promise.resolve(0) })) }));
vi.mock("../../temp-paths", () => ({ dev3TaskTempPath: vi.fn(() => "/tmp/dev3/task") }));
vi.mock("../../tmux", () => ({
	DEFAULT_TMUX_SOCKET: "dev3",
	activeTmuxConfigPath: vi.fn(() => "/tmp/dev3.tmux.conf"),
	cleanupSessionName: vi.fn(() => "dev3-cleanup"),
	tmux: { killSession: vi.fn(), spawnAttachedSession: vi.fn() },
}));
vi.mock("../../rpc-handlers/tmux-pty", () => ({
	cleanupTaskTmuxState: vi.fn(),
	killDevServerSession: vi.fn(),
	launchColumnAgent: vi.fn(),
	launchTaskPty: vi.fn(async () => undefined),
}));
vi.mock("../../rpc-handlers/settings-config", () => ({
	resolveOperationalProjectConfig: vi.fn(async (p: Project) => ({ ...p, devScript: "", portCount: 0 })),
}));

const pushMessage = vi.fn();
vi.mock("../../rpc-handlers/shared", () => ({
	buildScriptRunnerCommand: vi.fn(() => "/bin/zsh /tmp/run"),
	buildTaskLifecycleEnv: vi.fn(() => ({})),
	getPushMessage: () => pushMessage,
	log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
	notifyWatchedTaskEvent: vi.fn(),
	notifyWatchedTaskStatusChange: vi.fn(),
	pushCliAttention: vi.fn(),
}));

import * as data from "../../data";
import { launchTaskPty } from "../../rpc-handlers/tmux-pty";
import { executeLifecycleEffect } from "../executor";

const TASK_ID = "aabbccdd-1111-2222-3333-444444444444";

function project(clonePathList: string[]): Project {
	return {
		id: "proj-1",
		name: "Project",
		path: "/repo",
		setupScript: "",
		devScript: "",
		cleanupScript: "",
		defaultBaseBranch: "main",
		clonePaths: clonePathList,
		createdAt: "2026-07-01T00:00:00.000Z",
	} as unknown as Project;
}

function task(overrides: Partial<Task> = {}): Task {
	return {
		id: TASK_ID,
		seq: 1,
		projectId: "proj-1",
		title: "Task",
		description: "Task",
		status: "in-progress",
		baseBranch: "main",
		...overrides,
	} as unknown as Task;
}

function context(proj: Project, sourceTask: Task): LifecycleExecutionContext {
	return {
		project: proj,
		sourceTask,
		task: sourceTask,
		stateTask: sourceTask,
		hooks: {
			processInline: vi.fn(async () => sourceTask),
			dispatchFollowUp: vi.fn(async () => sourceTask),
			runDetached: vi.fn(),
		},
	} as unknown as LifecycleExecutionContext;
}

const prepareEffect: LifecycleEffect = {
	type: "prepareTask",
	runId: "run-1",
	awaitCompletion: true,
	columnReserved: false,
	isReopen: false,
	successPatch: "activation",
	origin: { status: "todo", customColumnId: null },
	target: { status: "in-progress", customColumnId: null },
	onError: "abort",
} as unknown as LifecycleEffect;

function cloneWrites(): Partial<Task>[] {
	return vi.mocked(data.updateTask).mock.calls
		.map((c) => c[2] as Partial<Task>)
		.filter((updates) => "cloneFailures" in updates);
}

beforeEach(() => {
	vi.clearAllMocks();
	vi.mocked(data.updateTask).mockImplementation(
		async (_project, id, updates) => ({ id, ...updates }) as unknown as Task,
	);
});

describe("clone failures during task preparation", () => {
	it("records the failed paths on the task and pushes the update", async () => {
		clonePaths.mockResolvedValue([
			{ path: "node_modules", method: "clonefile", durationMs: 3 },
			{ path: ".env", method: "copy", durationMs: 2, error: "Permission denied (cp -R exited 1)" },
		]);

		await executeLifecycleEffect(prepareEffect, context(project(["node_modules", ".env"]), task()));

		expect(cloneWrites()).toEqual([
			{ cloneFailures: [{ path: ".env", error: "Permission denied (cp -R exited 1)" }] },
		]);
		expect(pushMessage).toHaveBeenCalledWith("taskUpdated", expect.objectContaining({ projectId: "proj-1" }));
	});

	it("still launches the agent — a missing cache must not cost the whole task", async () => {
		clonePaths.mockResolvedValue([
			{ path: ".env", method: "copy", durationMs: 2, error: "cp -R exited 1" },
		]);

		await executeLifecycleEffect(prepareEffect, context(project([".env"]), task()));

		expect(launchTaskPty).toHaveBeenCalled();
	});

	it("writes nothing when every path copied or was skipped", async () => {
		clonePaths.mockResolvedValue([
			{ path: "node_modules", method: "copy", durationMs: 2 },
			{ path: ".venv", method: "copy", durationMs: 1, skipped: true },
		]);

		await executeLifecycleEffect(prepareEffect, context(project(["node_modules", ".venv"]), task()));

		expect(cloneWrites()).toEqual([]);
	});

	it("clears a previous launch's failures when the retry copies everything", async () => {
		clonePaths.mockResolvedValue([{ path: ".env", method: "copy", durationMs: 1 }]);

		await executeLifecycleEffect(
			prepareEffect,
			context(project([".env"]), task({ cloneFailures: [{ path: ".env", error: "cp -R exited 1" }] })),
		);

		expect(cloneWrites()).toEqual([{ cloneFailures: null }]);
	});
});
