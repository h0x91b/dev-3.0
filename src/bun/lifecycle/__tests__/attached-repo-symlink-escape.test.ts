import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../logger", () => ({
	createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));


vi.mock("../../cow-clone", () => ({ clonePaths: vi.fn(async () => undefined) }));
vi.mock("../../data", () => ({
	updateTask: vi.fn(async () => undefined),
	deleteTask: vi.fn(async () => undefined),
	updateTaskWith: vi.fn(),
	getProject: vi.fn(),
	getTask: vi.fn(),
}));
const ROOT = vi.hoisted(() => `${process.env.DEV3_TEST_ROOT ?? "/tmp"}/attached-symlink-${process.pid}`);
vi.mock("../../paths", () => ({ DEV3_HOME: ROOT, OPS_DIR: `${ROOT}/ops` }));
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
vi.mock("../../spawn", async () => {
	const { createSpawnMock } = await import("../../__tests__/git-test-helpers");
	return createSpawnMock();
});
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


vi.mock("../../task-aux-panes", () => ({ openAuxPane: vi.fn(), auxPaneAlive: vi.fn(async () => false), auxPaneTitle: () => "Git" }));
vi.mock("../../github", () => ({ getGitHubShellExports: vi.fn(async () => []), findOpenPullRequest: vi.fn() }));
vi.mock("../../agent-prompt-delivery", () => ({ deliverAgentPrompt: vi.fn() }));
vi.mock("../../scheduled-message-scheduler", () => ({ scheduleMessage: vi.fn(), cancelScheduledMessage: vi.fn(), sendScheduledMessageNow: vi.fn() }));
vi.mock("../../lifecycle/activities", () => ({
	PR_DETECTION_TIMEOUT_MS: 1000,
	dismissMergeCompletionPrompt: vi.fn(),
	persistProjectPrIdentities: vi.fn(),
	persistTaskPrIdentity: vi.fn(),
	prepareMergeCompletionPrompt: vi.fn(),
	refreshTaskPrStatus: vi.fn(),
	reportTaskPrStatus: vi.fn(),
}));
vi.mock("../../task-branch-sync", () => ({ syncTaskBranchName: vi.fn() }));
vi.mock("../../lifecycle/service", () => ({ lifecycleActorRuntime: vi.fn(() => ({})) }));
vi.mock("../../lifecycle/merge-fingerprint", () => ({ getMergeCompletionFingerprint: vi.fn() }));
vi.mock("../../worktree-trust", () => ({ forgetWorktreeTrust: vi.fn(async () => undefined) }));
vi.mock("../../board-operations/task-notes", () => ({ addNote: vi.fn(async () => undefined) }));
vi.mock("../../board-operations/runtime", () => ({ boardPorts: { push: vi.fn(), clearMergeNotification: vi.fn(), syncTerminalTitle: vi.fn() } }));
vi.mock("../../agent-requests", () => ({ voidAgentRequestsForTask: vi.fn() }));
vi.mock("../../board-operations/types", () => ({ AGENT_ACTOR: { kind: "agent" } }));

import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as data from "../../data";
import { gitOperationHandlers } from "../../rpc-handlers/git-operations";
import { executeLifecycleEffect, type LifecycleExecutionContext } from "../executor";
import type { LifecycleEffect } from "../effects";
import type { Project, Task } from "../../../shared/types";
import { cleanup, createTestRepo, g, type TestRepo } from "../../__tests__/git-test-helpers";

const FOLDER = `${ROOT}/ops/slug/aabbccdd/work`;
const project = { id: "vp1", name: "Ops", kind: "virtual", path: `${ROOT}/ops/slug`, setupScript: "", devScript: "", cleanupScript: "", defaultBaseBranch: "main", createdAt: "" } as Project;

let repo: TestRepo;
let external: string;
// The stored row the locked writes see.
let row: Task;

const taskWith = (attachedRepo: string) =>
	({ id: "aabbccdd-1111-2222-3333-444444444444", projectId: "vp1", worktreePath: FOLDER, attachedRepo }) as Task;
const ctxFor = (t: Task) => ({ project, sourceTask: t, task: t, stateTask: t }) as unknown as LifecycleExecutionContext;
const step = (type: string, ctx: LifecycleExecutionContext, extra: object = {}) =>
	executeLifecycleEffect({ type, onError: "continue", ...extra } as LifecycleEffect, ctx);

beforeEach(() => {
	vi.clearAllMocks();
	repo = createTestRepo();
	mkdirSync(FOLDER, { recursive: true });
	// A linked worktree of the user's own repo, outside the task folder, with unsaved work in it.
	external = join(repo.dir, "external-wt");
	g(`git worktree add -b external "${external}"`, repo.local);
	writeFileSync(join(external, "dirty.ts"), "uncommitted\n");
	vi.mocked(data.updateTask).mockImplementation(async (_p, id, updates) => ({ id, ...updates }) as never);
	vi.mocked(data.updateTaskWith).mockImplementation(async (_p, _id, mutator) => {
		const { updates, result } = await mutator({ ...row });
		return { task: { ...row, ...updates }, result } as never;
	});
});

afterEach(() => {
	cleanup(repo);
	rmSync(ROOT, { recursive: true, force: true });
});

const externalSurvives = () => {
	expect(readFileSync(join(external, "dirty.ts"), "utf-8")).toBe("uncommitted\n");
	expect(g("git worktree list", repo.local)).toContain("external-wt");
};

describe("a symlink swapped in for the attached repo after attaching", () => {
	const WT = `${FOLDER}/wt`;

	// The folder holds a real linked worktree, as the attach check saw it.
	const attachWorktree = (path: string) => g(`git worktree add -b inside-${Math.random().toString(36).slice(2, 8)} "${path}"`, repo.local);

	it("closing removes a genuine linked worktree in the folder (control)", async () => {
		attachWorktree(WT);
		const ctx = ctxFor(row = taskWith(WT));
		await step("removeAttachedWorktree", ctx, { approvedAttachedRepo: WT });
		await step("persistTerminalTask", ctx, { status: "completed", onError: "abort" });
		expect(existsSync(WT)).toBe(false);
		expect(ctx.task.attachedRepo).toBeNull();
	});

	it("closing never removes the external worktree a symlink points to, and still detaches", async () => {
		symlinkSync(external, WT);
		const ctx = ctxFor(row = taskWith(WT));
		await step("removeAttachedWorktree", ctx, { approvedAttachedRepo: WT });
		await step("persistTerminalTask", ctx, { status: "completed", onError: "abort" });
		externalSurvives();
		expect(ctx.task.attachedRepo).toBeNull();
	});

	it("closing never follows a symlinked folder above the attached path", async () => {
		symlinkSync(repo.dir, `${FOLDER}/up`);
		const through = `${FOLDER}/up/external-wt`;
		const ctx = ctxFor(row = taskWith(through));
		await step("removeAttachedWorktree", ctx, { approvedAttachedRepo: through });
		await step("persistTerminalTask", ctx, { status: "cancelled", onError: "abort" });
		externalSurvives();
		expect(ctx.task.attachedRepo).toBeNull();
	});

	it("resetting never removes the external worktree and still detaches", async () => {
		symlinkSync(external, WT);
		const ctx = ctxFor(row = { ...taskWith(WT), status: "in-progress", lifecycleStartedAt: "S" } as Task);
		await step("removeAttachedWorktree", ctx, { approvedAttachedRepo: WT });
		await step("persistResetTask", ctx, { consent: { worktreePath: FOLDER, lifecycleStartedAt: "S", attachedRepo: WT, approvedAttachedRepo: WT }, onError: "abort" });
		externalSurvives();
		expect(ctx.task).toMatchObject({ status: "todo", attachedRepo: null });
	});

	it("deleting the task removes the folder but never the external worktree behind a symlink", async () => {
		symlinkSync(external, WT);
		await step("removeTaskWorkspace", ctxFor(taskWith(WT)));
		expect(existsSync(FOLDER)).toBe(false);
		externalSurvives();
	});

	it("deleting the task never follows a symlinked folder above the attached path", async () => {
		symlinkSync(repo.dir, `${FOLDER}/up`);
		await step("removeTaskWorkspace", ctxFor(taskWith(`${FOLDER}/up/external-wt`)));
		expect(existsSync(FOLDER)).toBe(false);
		externalSurvives();
	});

	it("deleting the task still removes a genuine linked worktree through git first", async () => {
		attachWorktree(WT);
		await step("removeTaskWorkspace", ctxFor(taskWith(WT)));
		expect(existsSync(FOLDER)).toBe(false);
		expect(g("git worktree list", repo.local)).not.toContain(WT);
	});

	// The external tree mirrors the managed layout and holds a dirty linked worktree of the same name.
	const externalTree = () => {
		const tree = join(repo.dir, "external-tree");
		g(`git worktree add -b same-name "${join(tree, "wt")}"`, repo.local);
		writeFileSync(join(tree, "wt", "dirty.ts"), "uncommitted\n");
		return tree;
	};
	const swapTaskFolder = () => {
		const tree = externalTree();
		rmSync(FOLDER, { recursive: true });
		symlinkSync(tree, FOLDER);
		return join(tree, "wt");
	};
	const swapAncestor = () => {
		const tree = join(repo.dir, "external-ancestor");
		const wt = join(tree, "work", "wt");
		mkdirSync(join(tree, "work"), { recursive: true });
		g(`git worktree add -b same-name-2 "${wt}"`, repo.local);
		writeFileSync(join(wt, "dirty.ts"), "uncommitted\n");
		rmSync(`${ROOT}/ops/slug/aabbccdd`, { recursive: true });
		symlinkSync(tree, `${ROOT}/ops/slug/aabbccdd`);
		return wt;
	};
	const survives = (wt: string) => {
		expect(readFileSync(join(wt, "dirty.ts"), "utf-8")).toBe("uncommitted\n");
		expect(g("git worktree list", repo.local)).toContain(realpathSync(wt));
	};

	for (const [name, swap] of [["the task folder itself", swapTaskFolder], ["an ancestor of the task folder", swapAncestor]] as const) {
		describe(`${name} swapped for a symlink to an external tree`, () => {
			it("closing keeps the external worktree and still detaches", async () => {
				const wt = swap();
				const ctx = ctxFor(row = taskWith(`${FOLDER}/wt`));
				await step("removeAttachedWorktree", ctx, { approvedAttachedRepo: `${FOLDER}/wt` });
				await step("persistTerminalTask", ctx, { status: "completed", onError: "abort" });
				survives(wt);
				expect(ctx.task.attachedRepo).toBeNull();
			});

			it("resetting keeps the external worktree and still detaches", async () => {
				const wt = swap();
				const ctx = ctxFor(row = { ...taskWith(`${FOLDER}/wt`), status: "in-progress", lifecycleStartedAt: "S" } as Task);
				await step("removeAttachedWorktree", ctx, { approvedAttachedRepo: `${FOLDER}/wt` });
				await step("persistResetTask", ctx, { consent: { worktreePath: FOLDER, lifecycleStartedAt: "S", attachedRepo: `${FOLDER}/wt`, approvedAttachedRepo: `${FOLDER}/wt` }, onError: "abort" });
				survives(wt);
				expect(ctx.task).toMatchObject({ status: "todo", attachedRepo: null });
			});

			it("deleting the task keeps the external worktree", async () => {
				const wt = swap();
				await step("removeTaskWorkspace", ctxFor(taskWith(`${FOLDER}/wt`)));
				survives(wt);
			});
		});
	}

	it("a dirty worktree parked aside while a symlink stood in for it survives a close that carries no approval", async () => {
		const wt = `${FOLDER}/wt`;
		const held = `${FOLDER}/held`;
		g(`git worktree add -b parked "${wt}"`, repo.local);
		writeFileSync(join(wt, "dirty.ts"), "uncommitted\n");
		g(`git worktree move "${wt}" "${held}"`, repo.local);
		symlinkSync(held, wt);
		const ctxTask = taskWith(wt);
		vi.mocked(data.getProject).mockResolvedValue(project);
		vi.mocked(data.getTask).mockResolvedValue(ctxTask);

		// The dialog's check fails, so nothing is reported as checked and the close carries no approval.
		await expect(gitOperationHandlers.getUnsavedWork({ taskId: ctxTask.id, projectId: "vp1", expectedAttachedRepo: wt })).rejects.toThrow();
		unlinkSync(wt);
		g(`git worktree move "${held}" "${wt}"`, repo.local);
		await step("removeAttachedWorktree", ctxFor(row = ctxTask), { approvedAttachedRepo: null });

		expect(readFileSync(join(wt, "dirty.ts"), "utf-8")).toBe("uncommitted\n");
		expect(g("git worktree list", repo.local)).toContain(realpathSync(wt));
	});
});
