/**
 * Lifecycle teardown routed by the task's own persisted backend (seq 1292).
 *
 * `destroyTaskPty` must stop the tree the task actually owns, and `killDevServer`
 * must not reach for tmux on behalf of a native task that has no tmux session at
 * all. The resolver is REAL — the task record drives both branches.
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

vi.mock("../../cow-clone", () => ({ clonePaths: vi.fn(async () => undefined) }));
vi.mock("../../data", () => ({ updateTask: vi.fn(async () => undefined), deleteTask: vi.fn(async () => undefined) }));
vi.mock("../../git", () => ({
	removeWorktree: vi.fn(async () => undefined),
	taskDir: vi.fn(() => "/managed/task"),
	virtualWorkDir: vi.fn(() => "/managed/ops"),
}));
vi.mock("../../paths", () => ({ DEV3_HOME: "/home/.dev3.0", OPS_DIR: "/home/.dev3.0/ops" }));
vi.mock("../../port-pool", () => ({ releasePorts: vi.fn(), getPortAssignments: vi.fn(() => []) }));
vi.mock("../../preparation-runtime", () => ({
	assertTaskPreparationActive: vi.fn(),
	markTaskPreparationCancelled: vi.fn(),
	reportCurrentPreparationStage: vi.fn(),
	withTaskPreparationRunId: vi.fn(),
}));

vi.mock("../../pty-server", () => ({
	destroySession: vi.fn(),
	destroyNativeTaskSession: vi.fn(),
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
	tmux: { killSession: vi.fn(async () => undefined) },
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

import * as pty from "../../pty-server";
import { killDevServerSession } from "../../rpc-handlers/tmux-pty";
import { executeLifecycleEffect } from "../executor";

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
