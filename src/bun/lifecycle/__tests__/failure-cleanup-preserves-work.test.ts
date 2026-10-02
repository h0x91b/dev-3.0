/**
 * F1 (Seq 2003 recheck 2003-012): a preparation that fails — for ANY reason, or
 * because the app restarted mid-preparation — must not destroy a stale task folder
 * or branch that holds work. Drives the REAL transition table through the REAL
 * executor against a real git repo; only processes and the task store are doubles.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Project, Task } from "../../../shared/types";
import type { LifecycleEvent, LifecycleState } from "../events";
import type { LifecycleExecutionContext } from "../executor";

const TEST_HOME = vi.hoisted(() => `${process.env.DEV3_TEST_ROOT}/failure-cleanup-preserves-work`);

vi.mock("../../logger", () => ({ createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }) }));
vi.mock("../../paths", () => ({ DEV3_HOME: TEST_HOME, OPS_DIR: `${TEST_HOME}/ops` }));
vi.mock("../../spawn", async () => {
	const { createSpawnMock } = await import("../../__tests__/git-test-helpers");
	return createSpawnMock();
});
vi.mock("../../data", () => ({ updateTask: vi.fn(), deleteTask: vi.fn(), updateTaskWith: vi.fn() }));
vi.mock("../../port-pool", () => ({ releasePorts: vi.fn(), getPortAssignments: vi.fn(() => []) }));
vi.mock("../../preparation-runtime", () => ({
	assertTaskPreparationActive: vi.fn(),
	markTaskPreparationCancelled: vi.fn(() => ({ pids: [], settled: Promise.resolve(), trackedProcessesExited: Promise.resolve(), reentrant: false })),
	reportCurrentPreparationStage: vi.fn(),
	withTaskPreparationRunId: vi.fn(),
}));
vi.mock("../../agent-graceful-exit", () => ({ requestGracefulAgentExit: vi.fn(async () => ({ kind: "skipped" })) }));
vi.mock("../../pty-server", () => ({ destroySession: vi.fn(), destroyNativeTaskSession: vi.fn(async () => undefined) }));
vi.mock("../../worktree-reaper", () => ({ reapWorktreeProcesses: vi.fn(async () => undefined) }));
vi.mock("../../worktree-trust", () => ({ forgetWorktreeTrust: vi.fn(async () => undefined) }));
vi.mock("../../settings", () => ({ loadSettings: vi.fn(async () => ({})), loadSettingsSync: vi.fn(() => ({})) }));
vi.mock("../../shell-env", () => ({ getUserShell: vi.fn(() => "/bin/zsh") }));
vi.mock("../../temp-paths", () => ({ dev3TaskTempPath: vi.fn(() => "/tmp/dev3/task") }));
vi.mock("../../tmux", () => ({
	DEFAULT_TMUX_SOCKET: "dev3",
	activeTmuxConfigPath: vi.fn(() => "/tmp/dev3.tmux.conf"),
	cleanupSessionName: vi.fn((taskId: string) => `dev3-cleanup-${taskId.slice(0, 8)}`),
	tmux: { killSession: vi.fn(async () => undefined), spawnAttachedSession: vi.fn(() => ({ exited: Promise.resolve(0) })), hasSession: vi.fn(async () => false) },
}));
vi.mock("../../rpc-handlers/tmux-pty", () => ({
	cleanupTaskTmuxState: vi.fn(),
	killDevServerSession: vi.fn(async () => undefined),
	launchColumnAgent: vi.fn(async () => undefined),
	launchTaskPty: vi.fn(async () => undefined),
}));
vi.mock("../../rpc-handlers/settings-config", () => ({
	resolveOperationalProjectConfig: vi.fn(async () => ({ devScript: "", portCount: 0, cleanupScript: "" })),
}));
vi.mock("../../rpc-handlers/shared", () => ({
	buildScriptRunnerCommand: vi.fn((path: string) => `/bin/zsh ${path}`),
	buildTaskLifecycleEnv: vi.fn(() => ({})),
	buildCleanupScriptEnv: vi.fn(() => ({})),
	getPushMessage: vi.fn(() => null),
	log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
	notifyWatchedTaskEvent: vi.fn(),
	notifyWatchedTaskStatusChange: vi.fn(),
	pushCliAttention: vi.fn(),
}));

import * as data from "../../data";
import { tmux } from "../../tmux";
import { createWorktree, _resetFetchState } from "../../git";
import { executeLifecycleEffect } from "../executor";
import { transition } from "../machine";
import { cleanup, createTestRepo, g, type TestRepo } from "../../__tests__/git-test-helpers";

const TASK_ID = "f1f1f1f1-0000-0000-0000-000000000000";
const OWN = "dev3/task-f1f1f1f1";
let repo: TestRepo;

function project(): Project {
	return { id: "p", name: "P", path: repo.local, setupScript: "", devScript: "", cleanupScript: "", defaultBaseBranch: "main", createdAt: "" };
}
function task(): Task {
	return {
		id: TASK_ID, seq: 1, projectId: "p", title: "t", description: "", status: "in-progress", baseBranch: "main",
		worktreePath: null, branchName: null, groupId: null, variantIndex: null, agentId: null, configId: null, createdAt: "", updatedAt: "",
	} as Task;
}
function preparing(): LifecycleState {
	return {
		column: { status: "in-progress", customColumnId: null },
		runtime: { phase: "preparing", stage: "creating-worktree", runId: "r1", origin: { status: "todo", customColumnId: null } },
		facts: { hasWorktree: false, usesWorktrees: true, hasPrIdentity: false, peerReviewEnabled: true },
	};
}

async function run(event: LifecycleEvent): Promise<void> {
	const source = task();
	const ctx = {
		project: project(), sourceTask: source, task: source, stateTask: source,
		hooks: { dispatchFollowUp: vi.fn(), processInline: vi.fn(), runDetached: vi.fn(), reserveMergePrompt: vi.fn(), setPrPromoted: vi.fn(), setPrSignalKey: vi.fn(), clearMergeThrottle: vi.fn(), clearTaskRuntime: vi.fn() },
	} as unknown as LifecycleExecutionContext;
	for (const declared of transition(preparing(), event).effects) {
		if (declared.type === "push") continue;
		try {
			await executeLifecycleEffect(declared, ctx);
		} catch (error) {
			if (declared.onError === "continue") continue;
			throw error;
		}
	}
}

function commit(dir: string, file: string): string {
	writeFileSync(join(dir, file), `${file}\n`);
	g(`git add ${file} && git commit -m ${file}`, dir);
	return g("git rev-parse HEAD", dir).trim();
}
function persistedError(): string {
	const call = vi.mocked(data.updateTask).mock.calls.find(([, , updates]) => "preparationError" in (updates as object));
	return String((call?.[2] as Partial<Task>).preparationError);
}

const FAILURES: Array<[string, LifecycleEvent]> = [
	["a base-branch error before createWorktree judged anything", { type: "preparationFailed", runId: "r1", error: 'Branch "main" does not exist locally or on the remote.' }],
	["an app restart while preparing", { type: "bootObserved", reality: { worktreeExists: true, terminalAlive: false } }],
];

beforeEach(() => {
	_resetFetchState();
	repo = createTestRepo();
	vi.mocked(data.updateTask).mockImplementation(async (_p, _id, updates) => ({ ...task(), ...updates }) as Task);
	(globalThis as unknown as { Bun: { write: unknown } }).Bun.write = vi.fn(async () => 0);
});
afterEach(() => {
	cleanup(repo);
	vi.clearAllMocks();
});

describe("preparation-failure cleanup judges the folder before destroying it", () => {
	it.each(FAILURES)("keeps a stale dirty folder and its unique-commit branch after %s", async (_label, event) => {
		const wt = await createWorktree(project(), task());
		const sha = commit(wt.worktreePath, "work.txt");
		writeFileSync(join(wt.worktreePath, "notes.txt"), "uncommitted\n");

		await run(event);

		expect(existsSync(join(wt.worktreePath, "notes.txt"))).toBe(true);
		expect(g(`git rev-parse ${OWN}`, repo.local).trim()).toBe(sha);
		expect(tmux.spawnAttachedSession).not.toHaveBeenCalled(); // no cleanup script ran in it
		expect(persistedError()).toContain("uncommitted or untracked files");
	});

	it("an ordinary failure on the run's own fresh folder still cleans up", async () => {
		const wt = await createWorktree(project(), task());
		await run(FAILURES[0]![1]);
		expect(existsSync(wt.worktreePath)).toBe(false);
		expect(g(`git branch --list ${OWN}`, repo.local).trim()).toBe("");
		expect(tmux.spawnAttachedSession).toHaveBeenCalled();
	});

	it("a clean folder is removed but a branch holding unique commits is kept", async () => {
		const wt = await createWorktree(project(), task());
		const sha = commit(wt.worktreePath, "only-here.txt");
		await run(FAILURES[1]![1]);
		expect(existsSync(wt.worktreePath)).toBe(false);
		expect(g(`git rev-parse ${OWN}`, repo.local).trim()).toBe(sha);
	});
});
