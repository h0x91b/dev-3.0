/**
 * Reopening a Codex task without a recorded conversation must refuse to guess
 * (#1847) WITHOUT failing the preparation: a failed preparation moves the task to
 * To Do, runs the cleanup script and removes the worktree. Drives the REAL
 * `prepareTask` through the REAL executor.
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
const chooseTaskCodexConversations = vi.fn();
vi.mock("../../codex-task-selection", () => ({ chooseTaskCodexConversations: (...args: unknown[]) => chooseTaskCodexConversations(...args) }));
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
vi.mock("../../settings", () => ({ loadSettingsSync: vi.fn(() => ({ defaultAgentId: "builtin-codex", defaultConfigId: "codex-default" })) }));
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
import { pushCliAttention } from "../../rpc-handlers/shared";
import { executeLifecycleEffect } from "../executor";

const TASK_ID = "aabbccdd-1111-2222-3333-444444444444";
const SESSION = "00000000-0000-4000-8000-0000c0de2704";

const project = { id: "proj-1", name: "Project", path: "/repo", setupScript: "", devScript: "", cleanupScript: "rm -rf everything", defaultBaseBranch: "main", clonePaths: [], createdAt: "2026-07-01T00:00:00.000Z" } as unknown as Project;

function task(overrides: Partial<Task> = {}): Task {
	return { id: TASK_ID, seq: 1, projectId: "proj-1", title: "Task", description: "Task", status: "completed", baseBranch: "main", agentId: "builtin-codex", configId: "codex-default", ...overrides } as unknown as Task;
}

function context(sourceTask: Task): LifecycleExecutionContext {
	return {
		project,
		sourceTask,
		task: sourceTask,
		stateTask: sourceTask,
		hooks: { processInline: vi.fn(async () => sourceTask), dispatchFollowUp: vi.fn(async () => sourceTask), runDetached: vi.fn() },
	} as unknown as LifecycleExecutionContext;
}

const reopen = (isReopen = true): LifecycleEffect => ({
	type: "prepareTask",
	runId: "run-1",
	awaitCompletion: true,
	columnReserved: false,
	isReopen,
	successPatch: "activation",
	origin: { status: "completed", customColumnId: null },
	target: { status: "in-progress", customColumnId: null },
	onError: "abort",
}) as unknown as LifecycleEffect;

const launchArgs = () => { const calls = vi.mocked(launchTaskPty).mock.calls; return calls[calls.length - 1]!; };

beforeEach(() => {
	vi.clearAllMocks();
	vi.mocked(data.updateTask).mockImplementation(async (_p, id, updates) => ({ id, ...updates }) as unknown as Task);
});

describe("reopen of a Codex task", () => {
	it("resumes the recorded conversation exactly", async () => {
		chooseTaskCodexConversations.mockResolvedValue(new Map([[0, { sessionId: SESSION, codexHome: "/h/acct" }]]));
		const recorded = task({ sessionState: { panes: [{ agentCmd: "codex", agentId: "builtin-codex", configId: "codex-default", sessionId: SESSION }] } });

		const outcome = await executeLifecycleEffect(reopen(), context(recorded));

		expect(chooseTaskCodexConversations).toHaveBeenCalledWith(expect.objectContaining({ id: "proj-1" }), expect.objectContaining({ worktreePath: "/tmp/wt" }), [expect.objectContaining({ sessionId: SESSION })], "reopen", { persist: false });
		expect(launchArgs()[6]).toBe(true);
		expect(launchArgs()[7]).toMatchObject({ sessionId: SESSION, codexHome: "/h/acct" });
		expect(outcome).toMatchObject({ followUp: { type: "preparationSucceeded" } });
	});

	it("without a recorded conversation opens the pane with the refusal, not the agent, and preparation still succeeds", async () => {
		const reason = "Cannot resume Codex: The previous Codex conversation of this task is not recorded, so it was not reopened. Run `codex resume <id>` in the task's terminal to continue it.";
		chooseTaskCodexConversations.mockRejectedValue(new Error(reason));

		const outcome = await executeLifecycleEffect(reopen(), context(task()));

		// The project-default agent is what launchTaskPty would run, so that is what is checked.
		expect(chooseTaskCodexConversations.mock.calls[0][2]).toEqual([expect.objectContaining({ agentId: "builtin-codex", sessionId: null })]);
		expect(launchArgs()[6]).toBe(false);
		expect(launchArgs()[7]).toMatchObject({ agentRefusal: reason });
		expect(launchArgs()[7]).not.toHaveProperty("sessionId");
		expect(pushCliAttention).toHaveBeenCalledWith({ taskId: TASK_ID, projectId: "proj-1", reason });
		// Success, not preparationFailed: no To Do move, no cleanup script, worktree kept.
		expect(outcome).toMatchObject({ followUp: { type: "preparationSucceeded", worktreePath: "/tmp/wt" } });
		expect(data.updateTask).not.toHaveBeenCalledWith(expect.anything(), TASK_ID, expect.objectContaining({ status: "todo" }));
	});

	it("checks the project default agent when the task names none", async () => {
		chooseTaskCodexConversations.mockRejectedValue(new Error("Cannot resume Codex: not recorded"));
		await executeLifecycleEffect(reopen(), context(task({ agentId: null, configId: null })));
		expect(chooseTaskCodexConversations.mock.calls[0][2]).toEqual([expect.objectContaining({ agentId: "builtin-codex", configId: "codex-default" })]);
		expect(launchArgs()[6]).toBe(false);
	});

	it("refuses the same way in an Operations project", async () => {
		chooseTaskCodexConversations.mockRejectedValue(new Error("Cannot resume Codex: not recorded"));
		const ops = { ...project, kind: "virtual" } as unknown as Project;
		const outcome = await executeLifecycleEffect(reopen(), { ...context(task()), project: ops } as unknown as LifecycleExecutionContext);
		expect(launchArgs()[6]).toBe(false);
		expect(launchArgs()[7]).toMatchObject({ agentRefusal: "Cannot resume Codex: not recorded" });
		expect(outcome).toMatchObject({ followUp: { type: "preparationSucceeded" } });
	});

	it("the counter-case: a throwing launch would fail the preparation, which is what the refusal avoids", async () => {
		chooseTaskCodexConversations.mockResolvedValue(new Map());
		vi.mocked(launchTaskPty).mockRejectedValueOnce(new Error("Codex resume needs a conversation ID; dev3 never resumes Codex with --last."));
		await expect(executeLifecycleEffect(reopen(), context(task()))).rejects.toThrow(/never resumes Codex with --last/);
	});

	it("a first activation never consults the selection", async () => {
		await executeLifecycleEffect(reopen(false), context(task({ status: "todo" })));
		expect(chooseTaskCodexConversations).not.toHaveBeenCalled();
		expect(launchArgs()[6]).toBe(false);
	});
});
