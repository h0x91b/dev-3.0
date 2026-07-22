import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdir, rm } from "node:fs/promises";
import type { GlobalSettings, Project, Task, TaskDiffResponse } from "../../shared/types";
import { buildTaskDialogSubject, getPreparingStageProgress, resolveTaskCompareBaseBranch } from "../../shared/types";
import { ENV_UNSET } from "../../shared/agent-accounts";

// ---- Mocks ----

vi.mock("electrobun/bun", () => ({
	PATHS: {
		VIEWS_FOLDER: "/fake-bundle/Resources/app/views/",
	},
	Utils: {
		showMessageBox: vi.fn(),
		showNotification: vi.fn(),
		openFileDialog: vi.fn(),
		quit: vi.fn(),
	},
	Updater: {
		localInfo: {
			version: vi.fn().mockResolvedValue("0.0.0-test"),
			hash: vi.fn().mockResolvedValue("deadbeef"),
			channel: vi.fn().mockResolvedValue("dev"),
		},
		checkForUpdate: vi.fn(),
		downloadUpdate: vi.fn(),
		updateInfo: vi.fn().mockReturnValue(null),
		applyUpdate: vi.fn(),
	},
}));

const mockBundledChangelog: any[] = [];
vi.mock("../changelog-bundled", () => ({
	get BUNDLED_CHANGELOG() { return mockBundledChangelog; },
}));

vi.mock("../data", () => ({
	getProject: vi.fn(),
	getTask: vi.fn(),
	loadProjects: vi.fn(),
	loadVirtualProjects: vi.fn(() => Promise.resolve([])),
	ensureBuiltinOperationsBoard: vi.fn(() => Promise.resolve(undefined)),
	addVirtualProject: vi.fn(),
	loadTasks: vi.fn(),
	updateTask: vi.fn(),
	setTaskPriority: vi.fn(),
	addTask: vi.fn(),
	addProject: vi.fn(),
	reorderProjects: vi.fn(),
	deleteTask: vi.fn(),
	removeProject: vi.fn(),
	updateProject: vi.fn(),
	updateProjectWith: vi.fn(),
	getLastPickedFolder: vi.fn(),
	setLastPickedFolder: vi.fn(),
	updateTaskWith: vi.fn(),
	loadLastRoute: vi.fn(),
	saveLastRoute: vi.fn(),
}));

vi.mock("../git", () => ({
	removeWorktree: vi.fn(),
	createWorktree: vi.fn(),
	applySparseCheckout: vi.fn(),
	isGitRepo: vi.fn(),
	getDefaultBranch: vi.fn(),
	fetchOrigin: vi.fn().mockResolvedValue(true),
	fetchFork: vi.fn().mockResolvedValue(true),
	getBranchStatus: vi.fn(),
	getTaskDiff: vi.fn(),
	getUncommittedChanges: vi.fn(),
	getUnpushedCount: vi.fn(),
	getBehindOriginCount: vi.fn().mockResolvedValue(0),
	getBranchDiffStats: vi.fn(),
	canRebaseCleanly: vi.fn(),
	isContentMergedInto: vi.fn(),
	isBranchMergedViaGitHubPR: vi.fn(),
	cloneRepo: vi.fn(),
	extractRepoName: vi.fn(),
	getCurrentBranch: vi.fn(),
	getHeadSha: vi.fn(),
	isWorktreeDirty: vi.fn(),
	listBranches: vi.fn(),
	pullOrigin: vi.fn(),
	saveDiffSnapshot: vi.fn().mockResolvedValue(undefined),
	taskDir: vi.fn(),
	virtualWorkDir: vi.fn((p: any, t: any) => `${p.path}/${String(t.id).slice(0, 8)}/work`),
	run: vi.fn(),
	getOriginUrl: vi.fn().mockResolvedValue("https://github.com/test/repo.git"),
}));

vi.mock("../github", () => ({
	runGitHub: vi.fn(),
	getGitHubShellExports: vi.fn().mockResolvedValue([]),
	getGitHubCliStatus: vi.fn(),
}));

vi.mock("../pty-server", () => ({
	createSession: vi.fn(),
	destroySession: vi.fn(),
	hasSession: vi.fn(),
	hasDeadSession: vi.fn(),
	tmuxSessionExists: vi.fn(() => true),
	listPaneIds: vi.fn(() => Promise.resolve(["%5"])),
	getPtyPort: vi.fn(() => 9999),
	getSessionProjectId: vi.fn(() => null),
	getSessionSocket: vi.fn(() => "dev3"),
	getSessionTmuxName: vi.fn((key: string) => `dev3-${key.slice(0, 8)}`),
	getSessionType: vi.fn(() => null),
	capturePane: vi.fn(),
	applyTmuxTheme: vi.fn(),
}));

// The tmux module stays REAL — its singleton is rebuilt over the shared spawn
// mock so existing `mockSpawn.mock.calls` assertions (has-session, split-window,
// new-session …) observe the exact argv the client builds. Only the binary
// surface (selectBinary/probeVersion/dereferenceShim) is stubbed: those hit
// disk/probe logic that settings-config tests control per-case.
vi.mock("../tmux", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../tmux")>();
	const client = new actual.TmuxClient({ spawn: ((...args: unknown[]) => mockSpawn(...args)) as never });
	client.selectBinary = vi.fn(async (preferred: string) => preferred) as never;
	client.probeVersion = vi.fn(async () => "tmux 3.6a") as never;
	client.dereferenceShim = vi.fn((p: string) => (p === "/mock/dev3-home/bin/tmux" ? "/opt/homebrew/bin/tmux" : p)) as never;
	return { ...actual, tmux: client };
});

vi.mock("../system-clipboard", () => ({
	writeSystemClipboard: vi.fn(() => "pbcopy"),
}));

vi.mock("../agents", () => ({
	ensureClaudeTrust: vi.fn(),
	ensureCodexTrust: vi.fn(),
	ensureGeminiTrust: vi.fn(),
	isClaudeCommand: vi.fn(() => false),
	skillInvocationPrefix: vi.fn((command: string) => (command === "codex" ? "$" : "/")),
	supportsPreAssignedSessionId: vi.fn(() => false),
	resolveCommandForAgent: vi.fn(() => ({ command: "claude", extraEnv: {} })),
	resolveCommandForProject: vi.fn(() => ({ command: "claude", extraEnv: {} })),
	getAllAgents: vi.fn(() => []),
	saveAllAgents: vi.fn(),
}));

vi.mock("../updater", () => ({
	checkForUpdateWithChannel: vi.fn(),
	downloadUpdateForChannel: vi.fn(),
	applyUpdate: vi.fn(),
	getLocalVersion: vi.fn(),
}));

vi.mock("../settings", () => ({
	loadSettings: vi.fn(() => ({ updateChannel: "stable", taskDropPosition: "top" })),
	loadSettingsSync: vi.fn(() => ({ playSoundOnTaskComplete: false })),
	saveSettings: vi.fn(),
	recordFavoriteUsages: vi.fn(),
}));

vi.mock("../repo-config", () => {
	const resolveProjectConfig = vi.fn((project: any, _configPath?: string) => project);
	const pickScript = (p: string | undefined, w: string | undefined): string =>
		p && p.trim() !== "" ? p : (w ?? "");
	// resolveOperationalProjectConfig now lives in repo-config (its real worktree+main
	// cascade is integration-tested in repo-config.test.ts). Here it delegates to the
	// test-overridable resolveProjectConfig mock the same number of times the real one
	// reads configs, so existing mockResolvedValueOnce setups are consumed identically.
	const resolveOperationalProjectConfig = vi.fn(async (project: any, worktreePath?: string) => {
		const projectResolved = await resolveProjectConfig(project);
		if (!worktreePath || worktreePath === project.path) return projectResolved;
		const worktreeResolved = await resolveProjectConfig(project, worktreePath);
		return {
			...worktreeResolved,
			setupScript: pickScript(projectResolved.setupScript, worktreeResolved.setupScript),
			setupScriptLaunchMode: projectResolved.setupScriptLaunchMode ?? worktreeResolved.setupScriptLaunchMode ?? "parallel",
			devScript: pickScript(projectResolved.devScript, worktreeResolved.devScript),
			cleanupScript: pickScript(projectResolved.cleanupScript, worktreeResolved.cleanupScript),
		};
	});
	return {
		resolveProjectConfig,
		resolveOperationalProjectConfig,
		migrateProjectConfig: vi.fn(),
		loadRepoConfigRaw: vi.fn(() => ({})),
		loadLocalConfigRaw: vi.fn(() => ({})),
		saveRepoConfig: vi.fn(),
		saveRepoLocalConfig: vi.fn(),
		getConfigSources: vi.fn(() => []),
		hasRepoConfig: vi.fn(() => false),
		hasLocalConfig: vi.fn(() => false),
	};
});

vi.mock("../agent-hooks", () => ({
	setupAgentHooks: vi.fn(),
}));

vi.mock("../artifact-template", () => ({
	ensureArtifactTemplateEnv: vi.fn(() => ({
		DEV3_ARTIFACT_TEMPLATE_DIR: "/tmp/test-dev3/artifact-template-v1",
	})),
}));

vi.mock("../cow-clone", () => ({
	clonePaths: vi.fn(),
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
	OPS_DIR: "/tmp/test-dev3/ops",
}));

vi.mock("node:fs/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs/promises")>();
	return { ...actual, mkdir: vi.fn(() => Promise.resolve(undefined)), rm: vi.fn(() => Promise.resolve(undefined)) };
});

const mockSpawn = vi.fn();
const mockSpawnSync = vi.fn();
vi.mock("../spawn", () => ({
	spawn: (...args: any[]) => mockSpawn(...args),
	spawnSync: (...args: any[]) => mockSpawnSync(...args),
}));

// Mock node:fs for existsSync and readdirSync (the symlink members keep the
// real tmux module's shim management away from the runner's ~/.dev3.0/bin)
vi.mock("node:fs", () => ({
	accessSync: vi.fn(() => undefined),
	constants: { X_OK: 1 },
	existsSync: vi.fn(() => true),
	readdirSync: vi.fn(() => []),
	statSync: vi.fn(() => ({ isDirectory: () => true, isFile: () => true, mode: 0o755, size: 0 })),
	mkdirSync: vi.fn(() => undefined),
	writeFileSync: vi.fn(() => undefined),
	lstatSync: vi.fn(() => { throw new Error("ENOENT"); }),
	readlinkSync: vi.fn(() => { throw new Error("EINVAL"); }),
	realpathSync: vi.fn((p: string) => p),
	unlinkSync: vi.fn(() => undefined),
	symlinkSync: vi.fn(() => undefined),
}));

const mockObjcGetClass = vi.fn(() => "NSApplication_ptr");
const mockSelRegisterName = vi.fn((buf: Buffer) => `sel_${buf.toString().replace(/\0$/, "")}`);
const mockObjcMsgSend = vi.fn(() => "NSApp_instance");
vi.mock("bun:ffi", () => ({
	dlopen: vi.fn(() => ({
		symbols: {
			objc_getClass: mockObjcGetClass,
			sel_registerName: mockSelRegisterName,
			objc_msgSend: mockObjcMsgSend,
		},
	})),
	FFIType: { ptr: "ptr", function: "function", i32: "i32", void: "void" },
	// Used by native-notifications.ts (imported via rpc-handlers/shared.ts);
	// never instantiated in these tests — the native channel stays uninitialized.
	JSCallback: class {
		ptr = 1;
		close() {}
	},
	CString: class {},
}));

import * as data from "../data";
import * as git from "../git";
import * as github from "../github";
import * as pty from "../pty-server";
import { tmux } from "../tmux";
import * as systemClipboard from "../system-clipboard";
import * as agents from "../agents";
import * as updater from "../updater";
import { setupAgentHooks } from "../agent-hooks";
import { loadSettings, loadSettingsSync, saveSettings } from "../settings";
import * as repoConfig from "../repo-config";
import * as cowClone from "../cow-clone";
import { Utils } from "electrobun/bun";
import { accessSync, existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { createTaskPreparation, registerPreparationSpawn } from "../preparation-runtime";

// Import handlers and pure helper functions after all mocks are set up
const {
	handlers,
	escapeForDoubleQuotes,
	shellQuote,
	buildEnvExports,
	buildCmdScript,
	isActive,
	handleBellAutoStatus,
	setPushMessage,
	getPushMessage,
	getPushMessageLocal,
	checkOpenPRsForPromotion,
	_resetPRPollerState,
	_resetMergePollerState,
	_setScheduleRandomForTest,
	startMergeDetectionPoller,
	stopMergeDetectionPoller,
	startPRDetectionPoller,
	stopPRDetectionPoller,
	resolveBinaryPath,
	bundledTmuxCandidates,
	launchTaskPty,
	addVirtualShellPane,
	activateTask,
	triggerColumnAgentIfNeeded,
	notifyWatchedTaskStatusChange,
	notifyWatchedTaskEvent,
	notifyFromCliDesktop,
	consumeRecentWatchedNotification,
	_resetWatchedNotificationState,
	NOTIFICATION_CLICK_TTL_MS,
	setAppForeground,
	isAppForeground,
	setActiveContext,
	setTerminalFocus,
	setFocusMode,
	isNotificationSuppressed,
	emitTaskSound,
	runCleanupScript,
	portableReadKey,
} = await import("../rpc-handlers");
const { _resetLifecycleActorsForTest } = await import("../lifecycle/service");

beforeEach(async () => {
	await _resetLifecycleActorsForTest();
});

// ---- Test helpers ----

function makeProject(overrides?: Partial<Project>): Project {
	return {
		id: "proj-1",
		name: "Test Project",
		path: "/tmp/test-project",
		setupScript: "",
		devScript: "",
		cleanupScript: "echo cleanup",
		defaultBaseBranch: "main",
		createdAt: new Date().toISOString(),
		...overrides,
	};
}

function makeTask(overrides?: Partial<Task>): Task {
	return {
		id: "task-1",
		seq: 1,
		projectId: "proj-1",
		title: "Test task",
		description: "Test task description",
		status: "in-progress",
		baseBranch: "main",
		worktreePath: "/tmp/test-worktree",
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

function mockTaskWrites(...tasks: Task[]): void {
	const tasksById = new Map(tasks.map((task) => [task.id, { ...task }]));
	vi.mocked(data.getTask).mockImplementation(async (_project, taskId) => {
		const task = tasksById.get(taskId);
		if (!task) throw new Error(`Task not found: ${taskId}`);
		return { ...task };
	});
	vi.mocked(data.updateTask).mockImplementation(async (_project, taskId, updates) => {
		const current = tasksById.get(taskId) ?? makeTask({ id: taskId });
		const updated = { ...current, ...updates, updatedAt: new Date().toISOString() } as Task;
		tasksById.set(taskId, updated);
		return updated;
	});
}

// ---- Tests ----

// ================================================================
// Pure helper functions
// ================================================================

describe("isActive", () => {
	it("returns true for all active statuses", () => {
		expect(isActive("in-progress")).toBe(true);
		expect(isActive("user-questions")).toBe(true);
		expect(isActive("review-by-ai")).toBe(true);
		expect(isActive("review-by-user")).toBe(true);
		expect(isActive("review-by-colleague")).toBe(true);
	});

	it("returns false for inactive statuses", () => {
		expect(isActive("todo")).toBe(false);
		expect(isActive("completed")).toBe(false);
		expect(isActive("cancelled")).toBe(false);
	});
});

describe("handleBellAutoStatus", () => {
	beforeEach(() => {
		vi.mocked(data.loadProjects).mockReset();
		vi.mocked(data.loadTasks).mockReset();
		vi.mocked(data.updateTask).mockReset();
		vi.mocked(loadSettings).mockResolvedValue({ updateChannel: "stable", taskDropPosition: "top" } as any);
	});

	it("moves in-progress task to user-questions", async () => {
		const project = makeProject();
		const task = makeTask({ status: "in-progress" });
		vi.mocked(data.loadProjects).mockResolvedValue([project]);
		vi.mocked(data.loadTasks).mockResolvedValue([task]);
		vi.mocked(data.updateTask).mockResolvedValue({ ...task, status: "user-questions" });

		const push = vi.fn();
		setPushMessage(push);

		await handleBellAutoStatus("task-1");

		expect(data.updateTask).toHaveBeenCalledWith(
			project,
			"task-1",
			expect.objectContaining({ status: "user-questions", runtimeState: expect.objectContaining({ runtime: "running" }) }),
			{ dropPosition: "top", ifStatus: "in-progress" },
		);
		expect(push).toHaveBeenCalledWith("taskUpdated", {
			projectId: "proj-1",
			task: expect.objectContaining({ status: "user-questions" }),
		});
	});

	it("does not push when the in-lock guard blocks the transition (TOCTOU with a concurrent Stop-hook)", async () => {
		const project = makeProject();
		const task = makeTask({ status: "in-progress" });
		vi.mocked(data.loadProjects).mockResolvedValue([project]);
		vi.mocked(data.loadTasks).mockResolvedValue([task]);
		// The snapshot says in-progress, but by the time the write runs a concurrent
		// Stop-hook has moved the task to review-by-ai. The ifStatus guard makes the
		// write a no-op that returns the task in its current (non-user-questions)
		// status — the bell must NOT drag it back, and must NOT push.
		vi.mocked(data.updateTask).mockResolvedValue({ ...task, status: "review-by-ai" });

		const push = vi.fn();
		setPushMessage(push);

		await handleBellAutoStatus("task-1");

		expect(data.updateTask).toHaveBeenCalledWith(
			project,
			"task-1",
			expect.objectContaining({ status: "user-questions", runtimeState: expect.objectContaining({ runtime: "running" }) }),
			{ dropPosition: "top", ifStatus: "in-progress" },
		);
		expect(push).not.toHaveBeenCalled();
	});

	it("does not move task when status is not in-progress", async () => {
		const project = makeProject();
		const task = makeTask({ status: "user-questions" });
		vi.mocked(data.loadProjects).mockResolvedValue([project]);
		vi.mocked(data.loadTasks).mockResolvedValue([task]);

		await handleBellAutoStatus("task-1");

		expect(data.updateTask).not.toHaveBeenCalled();
	});

	it("does not throw when task is not found", async () => {
		vi.mocked(data.loadProjects).mockResolvedValue([makeProject()]);
		vi.mocked(data.loadTasks).mockResolvedValue([]);

		await expect(handleBellAutoStatus("unknown-task")).resolves.toBeUndefined();
	});
});

describe("runCleanupScript", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		// Default: pretend the worktree directory exists. Individual tests
		// override this to exercise the missing-directory branch.
		vi.mocked(existsSync).mockReturnValue(true);
		mockSpawn.mockReturnValue({
			stdout: new Response(""),
			stderr: new Response(""),
			exited: Promise.resolve(0),
		});
	});

	it("passes lifecycle env vars to the cleanup shell", async () => {
		const project = makeProject({ path: "/tmp/project-root", name: "Alpha Project", cleanupScript: "echo cleanup" });
		const task = makeTask({
			id: "task-123",
			title: "Ship it",
			worktreePath: "/tmp/test-worktree",
			status: "in-progress",
		});

		await runCleanupScript(task, project, {
			fromStatus: "in-progress",
			toStatus: "completed",
		});

		expect(mockSpawn).toHaveBeenCalledTimes(1);
		// The tmux CLIENT spawns from the stable dev3 home (tmuxClientCwd), NOT
		// the worktree — otherwise a server started by this client would keep a
		// cwd that this very cleanup is about to delete (tmux 3.7 then ignores
		// `-c` for all future panes). The script itself runs in the worktree via
		// the `-c` flag asserted below.
		expect(mockSpawn.mock.calls[0]?.[1]).toMatchObject({
			cwd: "/tmp/test-dev3",
			env: expect.objectContaining({
				TERM: "xterm-256color",
				DEV3_TASK_TITLE: "Ship it",
				DEV3_TASK_ID: "task-123",
				DEV3_PROJECT_NAME: "Alpha Project",
				DEV3_PROJECT_PATH: "/tmp/project-root",
				DEV3_WORKTREE_PATH: "/tmp/test-worktree",
				DEV3_BRANCH_NAME: "dev3/task-test",
				DEV3_TASK_STATUS: "completed",
				DEV3_TASK_FROM_STATUS: "in-progress",
				DEV3_TASK_TO_STATUS: "completed",
			}),
		});
		const cleanupArgs = mockSpawn.mock.calls[0]?.[0] as string[];
		const cFlagIndex = cleanupArgs.indexOf("-c");
		expect(cFlagIndex).toBeGreaterThan(-1);
		expect(cleanupArgs[cFlagIndex + 1]).toBe("/tmp/test-worktree");
	});

	it("reports status 'deleted' when the worktree dies via task deletion", async () => {
		const project = makeProject({ path: "/tmp/project-root", cleanupScript: "echo cleanup" });
		const task = makeTask({
			id: "task-123",
			worktreePath: "/tmp/test-worktree",
			status: "in-progress",
		});

		await runCleanupScript(task, project, { fromStatus: "in-progress", toStatus: "deleted" });

		expect(mockSpawn.mock.calls[0]?.[1]).toMatchObject({
			env: expect.objectContaining({
				DEV3_TASK_STATUS: "deleted",
				DEV3_TASK_FROM_STATUS: "in-progress",
				DEV3_TASK_TO_STATUS: "deleted",
			}),
		});
	});

	it("passes lifecycle env vars to tmux new-session via -e flags (no leak)", async () => {
		// Without -e KEY=VAL on new-session, the tmux server's global env (from
		// whichever task started the server) leaks into the cleanup script —
		// e.g. cleanup running with DEV3_TASK_ID from a SIBLING task would
		// destroy the wrong docker container.
		const project = makeProject({ path: "/tmp/project-root", name: "Alpha Project", cleanupScript: "echo cleanup" });
		const task = makeTask({
			id: "task-123",
			title: "Ship it",
			worktreePath: "/tmp/test-worktree",
			status: "in-progress",
		});

		await runCleanupScript(task, project, { fromStatus: "in-progress", toStatus: "completed" });

		const args = mockSpawn.mock.calls[0]?.[0] as string[];
		expect(args).toContain("new-session");
		expect(args).toContain("DEV3_TASK_ID=task-123");
		expect(args).toContain("DEV3_TASK_TITLE=Ship it");
		expect(args).toContain("DEV3_PROJECT_NAME=Alpha Project");
		expect(args).toContain("DEV3_WORKTREE_PATH=/tmp/test-worktree");
		expect(args).toContain("DEV3_TASK_STATUS=completed");
		expect(args).toContain("DEV3_TASK_FROM_STATUS=in-progress");
		expect(args).toContain("DEV3_TASK_TO_STATUS=completed");
		// Every env var must be preceded by a -e flag. Walk the args array and
		// confirm at least one DEV3_* sits right after a -e.
		const taskIdIndex = args.indexOf("DEV3_TASK_ID=task-123");
		expect(args[taskIdIndex - 1]).toBe("-e");
	});

	it("uses existsSync (not Bun.file) so worktree directory detection works", async () => {
		// Regression: a previous iteration used `Bun.file(dir).exists()` which
		// always returns false for directories — silently skipping cleanup on
		// every task move-to-done/cancel. We assert that an unmocked Bun.file
		// is NOT consulted: existsSync alone decides.
		const fileSpy = vi.spyOn(Bun, "file");
		const project = makeProject({ path: "/tmp/project-root", cleanupScript: "echo cleanup" });
		const task = makeTask({
			id: "task-existsSync",
			worktreePath: "/tmp/test-worktree",
			status: "in-progress",
		});

		await runCleanupScript(task, project, { fromStatus: "in-progress", toStatus: "completed" });

		expect(vi.mocked(existsSync)).toHaveBeenCalledWith("/tmp/test-worktree");
		// Bun.file may still be used by Bun.write for the script body, but
		// must not be the gate that decides whether the worktree exists.
		const dirChecks = fileSpy.mock.calls.filter(([arg]) => String(arg) === "/tmp/test-worktree");
		expect(dirChecks).toHaveLength(0);
		expect(mockSpawn).toHaveBeenCalledTimes(1);
		fileSpy.mockRestore();
	});

	it("skips cleanup when worktree directory is missing", async () => {
		vi.mocked(existsSync).mockReturnValue(false);
		const project = makeProject({ path: "/tmp/project-root", cleanupScript: "echo cleanup" });
		const task = makeTask({
			id: "task-missing",
			worktreePath: "/tmp/already-gone",
			status: "in-progress",
		});

		await runCleanupScript(task, project, { fromStatus: "in-progress", toStatus: "completed" });

		expect(mockSpawn).not.toHaveBeenCalled();
	});
});

describe("uploadFileBase64", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.mocked(data.getProject).mockResolvedValue(makeProject({ path: "/tmp/project-root" }));
		mockSpawn.mockReturnValue({
			exited: Promise.resolve(0),
		});
		(globalThis as any).Bun.write = vi.fn().mockResolvedValue(undefined);
	});

	it("stores dropped files inside the worktree uploads directory", async () => {
		const result = await handlers.uploadFileBase64({
			projectId: "proj-1",
			base64: "bm90ZXM=",
			filename: "notes.txt",
			mimeType: "text/plain",
		});

		expect(mockSpawn).toHaveBeenCalledWith(["mkdir", "-p", "/tmp/test-dev3/worktrees/tmp-project-root/uploads"]);
		expect((globalThis as any).Bun.write).toHaveBeenCalledTimes(1);

		const [path, fileData] = (globalThis as any).Bun.write.mock.calls[0];
		expect(path).toMatch(/^\/tmp\/test-dev3\/worktrees\/tmp-project-root\/uploads\/upload-\d+-[0-9a-f]{4}-notes\.txt$/);
		expect(Buffer.from(fileData).toString()).toBe("notes");
		expect(result).toEqual({ path });
	});

	it("uses the mime-derived extension when no filename is provided", async () => {
		await handlers.uploadFileBase64({
			projectId: "proj-1",
			base64: "YQ==",
			mimeType: "image/png",
		});

		const [path] = (globalThis as any).Bun.write.mock.calls[0];
		expect(path).toMatch(/^\/tmp\/test-dev3\/worktrees\/tmp-project-root\/uploads\/upload-\d+-[0-9a-f]{4}\.png$/);
	});

	it("truncates filenames that would exceed NAME_MAX", async () => {
		// 250-char ASCII name — combined with the ~26-char prefix would exceed 255-byte NAME_MAX
		const longName = `${"a".repeat(240)}.txt`;
		await handlers.uploadFileBase64({
			projectId: "proj-1",
			base64: "YQ==",
			filename: longName,
		});

		const [path] = (globalThis as any).Bun.write.mock.calls[0];
		const basename = path.split("/").pop() as string;
		// The full filename (prefix + suffix) must be under 255 bytes
		expect(Buffer.byteLength(basename, "utf8")).toBeLessThanOrEqual(255);
		// The suffix itself must be at most 200 bytes
		const suffix = basename.replace(/^upload-\d+-[0-9a-f]{4}-/, "");
		expect(Buffer.byteLength(suffix, "utf8")).toBeLessThanOrEqual(200);
	});
});

describe("setPushMessage / getPushMessage", () => {
	beforeEach(() => {
		// Reset to null
		setPushMessage(() => {});
	});

	it("stores and retrieves the push message function", () => {
		const fn = vi.fn();
		setPushMessage(fn);
		// getPushMessage() returns a broadcast wrapper, not fn directly
		const wrapped = getPushMessage();
		expect(wrapped).toBeTruthy();
		wrapped!("testEvent", { data: 1 });
		expect(fn).toHaveBeenCalledWith("testEvent", { data: 1 });
	});

	it("getPushMessageLocal returns the raw function without broadcast", () => {
		const fn = vi.fn();
		setPushMessage(fn);
		expect(getPushMessageLocal()).toBe(fn);
	});
});

// ================================================================
// escapeForDoubleQuotes
// ================================================================

describe("escapeForDoubleQuotes", () => {
	it("returns plain text unchanged", () => {
		expect(escapeForDoubleQuotes("hello world")).toBe("hello world");
	});

	it("escapes double quotes", () => {
		expect(escapeForDoubleQuotes('say "hello"')).toBe('say \\"hello\\"');
	});

	it("escapes dollar signs", () => {
		expect(escapeForDoubleQuotes("$HOME/path")).toBe("\\$HOME/path");
	});

	it("escapes backticks", () => {
		expect(escapeForDoubleQuotes("run `whoami`")).toBe("run \\`whoami\\`");
	});

	it("escapes backslashes", () => {
		expect(escapeForDoubleQuotes("path\\to\\file")).toBe("path\\\\to\\\\file");
	});

	it("escapes exclamation marks", () => {
		expect(escapeForDoubleQuotes("hello! world!")).toBe("hello\\! world\\!");
	});

	it("escapes multiple special chars in one string", () => {
		expect(escapeForDoubleQuotes('$HOME/`cmd` "arg" \\path!')).toBe(
			'\\$HOME/\\`cmd\\` \\"arg\\" \\\\path\\!',
		);
	});

	it("preserves single quotes (they are safe in double-quoted context)", () => {
		expect(escapeForDoubleQuotes("it's fine")).toBe("it's fine");
	});

	it("preserves semicolons and pipes", () => {
		expect(escapeForDoubleQuotes("cmd1; cmd2 | cmd3")).toBe("cmd1; cmd2 | cmd3");
	});

	it("preserves parentheses", () => {
		expect(escapeForDoubleQuotes("(subshell)")).toBe("(subshell)");
	});

	it("handles empty string", () => {
		expect(escapeForDoubleQuotes("")).toBe("");
	});

	it("handles string with only special chars", () => {
		expect(escapeForDoubleQuotes('"$`\\!')).toBe('\\"\\$\\`\\\\\\!');
	});

	it("preserves newlines", () => {
		expect(escapeForDoubleQuotes("line1\nline2")).toBe("line1\nline2");
	});

	it("handles unicode characters", () => {
		expect(escapeForDoubleQuotes("Привет $мир")).toBe("Привет \\$мир");
	});
});

// ================================================================
// buildCmdScript
// ================================================================

describe("buildCmdScript", () => {
	it("produces a valid bash script with shebang", () => {
		const result = buildCmdScript("claude 'Fix bug'");
		expect(result.startsWith("#!/bin/bash\n")).toBe(true);
	});

	it("includes echo and the command (without exec)", () => {
		const cmd = "claude 'Fix bug'";
		const result = buildCmdScript(cmd);
		expect(result).toContain(`&& ${cmd}`);
		expect(result).toContain("echo \"Starting:");
		// Should NOT exec the agent command (exec shell is at the end for post-agent shell)
		expect(result).not.toContain(`exec ${cmd}`);
	});

	it("defaults to keepShell=false: drops into the selected shell on failure", () => {
		const result = buildCmdScript("claude", undefined, { shellPath: "/bin/zsh" });
		expect(result).toContain("__EC=$?");
		expect(result).toContain("if [ $__EC -ne 0 ]; then");
		expect(result).toContain("exec '/bin/zsh'");
		expect(result).not.toContain("exec bash");
	});

	it("keepShell=true: always drops into user shell after command finishes", () => {
		const result = buildCmdScript("claude", undefined, { keepShell: true, shellPath: "/bin/zsh" });
		expect(result).toContain("__EC=$?");
		expect(result).toContain("exec '/bin/zsh'");
		expect(result).not.toContain("exec bash");
	});

	it("keepShell=true: shows error message on non-zero exit", () => {
		const result = buildCmdScript("claude", undefined, { keepShell: true });
		expect(result).toContain("Process exited with code");
	});

	it("keepShell=true: shows dim message on zero exit", () => {
		const result = buildCmdScript("claude", undefined, { keepShell: true });
		expect(result).toContain("Agent session ended (exit 0)");
	});

	it("keepShell=false: no success message on zero exit", () => {
		const result = buildCmdScript("claude");
		expect(result).not.toContain("Agent session ended");
	});

	it("ends with a newline", () => {
		const result = buildCmdScript("claude");
		expect(result.endsWith("\n")).toBe(true);
	});

	it("escapes double quotes in echo but preserves command verbatim", () => {
		const cmd = 'claude "arg"';
		const result = buildCmdScript(cmd);
		expect(result).toContain('\\"arg\\"');
		expect(result).toContain(`&& claude "arg"`);
	});

	it("escapes dollar signs in echo but preserves command verbatim", () => {
		const cmd = "claude '$HOME'";
		const result = buildCmdScript(cmd);
		expect(result).toContain("\\$HOME");
		expect(result).toContain(`&& claude '$HOME'`);
	});

	it("handles complex command with all special chars", () => {
		const desc = "'Fix \"bug\" ($HOME); `test` \\path'";
		const cmd = `claude ${desc}`;
		const result = buildCmdScript(cmd);

		const lines = result.split("\n");
		const echoLine = lines.find((l) => l.startsWith("echo"));
		expect(echoLine).toBeDefined();

		expect(result).toContain(`&& ${cmd}`);
	});

	it("includes export lines when env is provided", () => {
		const env = { MY_VAR: "hello", ANOTHER: "world" };
		const result = buildCmdScript("claude", env);
		const lines = result.split("\n");
		expect(lines[1]).toBe("export MY_VAR='hello'");
		expect(lines[2]).toBe("export ANOTHER='world'");
		// Command comes after exports
		expect(result).toContain("&& claude");
	});

	it("does not include export lines when env is empty", () => {
		const result = buildCmdScript("claude", {});
		expect(result).not.toContain("export ");
	});

	it("does not include export lines when env is undefined", () => {
		const result = buildCmdScript("claude");
		expect(result).not.toContain("export ");
	});

	it("shell-quotes env values with special characters", () => {
		const env = { PATH: "/usr/bin:/usr/local/bin", TITLE: "it's a test" };
		const result = buildCmdScript("claude", env);
		expect(result).toContain("export PATH='/usr/bin:/usr/local/bin'");
		expect(result).toContain("export TITLE='it'\\''s a test'");
	});

	it("includes onExitCommand inside else block on success (keepShell=false)", () => {
		const result = buildCmdScript("claude", undefined, { onExitCommand: "dev3 task move abc --status review-by-user" });
		expect(result).toContain("dev3 task move abc --status review-by-user");
		// onExitCommand must be inside the else branch (after "else", before "fi")
		const lines = result.split("\n");
		const elseIdx = lines.findIndex((l) => l.trim() === "else");
		const fiIdx = lines.findIndex((l) => l.trim() === "fi");
		const exitCmdIdx = lines.findIndex((l) => l.includes("dev3 task move abc"));
		expect(elseIdx).toBeGreaterThan(-1);
		expect(exitCmdIdx).toBeGreaterThan(elseIdx);
		expect(exitCmdIdx).toBeLessThan(fiIdx);
	});

	it("includes onExitCommand inside else block (keepShell=true)", () => {
		const result = buildCmdScript("claude", undefined, { keepShell: true, onExitCommand: "dev3 task move abc --status done" });
		expect(result).toContain("dev3 task move abc --status done");
		// onExitCommand should be in the else (success) branch
		const lines = result.split("\n");
		const elseIdx = lines.findIndex((l) => l.includes("else"));
		const exitCmdIdx = lines.findIndex((l) => l.includes("dev3 task move abc"));
		expect(exitCmdIdx).toBeGreaterThan(elseIdx);
	});

	it("does not include onExitCommand when not provided", () => {
		const result = buildCmdScript("claude", undefined, { keepShell: true });
		expect(result).not.toContain("dev3 task move");
	});
});

// ================================================================
// portableReadKey
// ================================================================

describe("portableReadKey", () => {
	// Regression for the setup pane crash: the wrapper carries a #!/bin/bash
	// shebang but runs under the user's login shell (usually zsh). A bare
	// `read -t 15 -n 1 -s` makes zsh die with "not an identifier: -s".
	it("branches on $ZSH_VERSION so it is safe under both bash and zsh", () => {
		const snippet = portableReadKey({ timeoutSeconds: 15 });
		expect(snippet).toContain('[ -n "$ZSH_VERSION" ]');
		// zsh spells "read N chars" as -k, bash as -n
		expect(snippet).toContain("read -t 15 -k 1 -s");
		expect(snippet).toContain("read -t 15 -n 1 -s");
	});

	it("is a single line (safe to inline in a wrapper script)", () => {
		expect(portableReadKey({ timeoutSeconds: 15 })).not.toContain("\n");
	});

	it("omits the timeout flag when no timeout is given", () => {
		const snippet = portableReadKey();
		expect(snippet).not.toContain("-t ");
		expect(snippet).toContain("read -k 1 -s");
		expect(snippet).toContain("read -n 1 -s");
	});
});

// ================================================================
// shellQuote
// ================================================================

describe("shellQuote", () => {
	it("wraps simple values in single quotes", () => {
		expect(shellQuote("hello")).toBe("'hello'");
	});

	it("escapes single quotes in values", () => {
		expect(shellQuote("it's")).toBe("'it'\\''s'");
	});

	it("handles empty string", () => {
		expect(shellQuote("")).toBe("''");
	});

	it("preserves dollar signs (no expansion in single quotes)", () => {
		expect(shellQuote("$HOME/path")).toBe("'$HOME/path'");
	});
});

// ================================================================
// buildEnvExports
// ================================================================

describe("buildEnvExports", () => {
	it("generates export lines for each key-value pair", () => {
		const lines = buildEnvExports({ A: "1", B: "2" });
		expect(lines).toEqual(["export A='1'", "export B='2'"]);
	});

	it("returns empty array for empty env", () => {
		expect(buildEnvExports({})).toEqual([]);
	});

	it("handles values with spaces and special chars", () => {
		const lines = buildEnvExports({ MSG: "hello world", QUOTED: "it's \"fine\"" });
		expect(lines[0]).toBe("export MSG='hello world'");
		expect(lines[1]).toBe("export QUOTED='it'\\''s \"fine\"'");
	});

	it("emits `unset KEY` for ENV_UNSET sentinel values", () => {
		const lines = buildEnvExports({ ANTHROPIC_API_KEY: ENV_UNSET, CLAUDE_CONFIG_DIR: "/tmp/acc" });
		expect(lines).toEqual(["unset ANTHROPIC_API_KEY", "export CLAUDE_CONFIG_DIR='/tmp/acc'"]);
	});
});

// ================================================================
// end-to-end: task description → shell command escaping
// ================================================================

describe("end-to-end: task description → shell command escaping", () => {
	function shellEscape(s: string): string {
		return "'" + s.replace(/'/g, "'\\''") + "'";
	}

	function simulatePipeline(taskDescription: string): {
		shellEscaped: string;
		agentCmd: string;
		cmdScript: string;
	} {
		const shellEscaped = shellEscape(taskDescription);
		const agentCmd = `claude --append-system-prompt 'MANDATORY' ${shellEscaped}`;
		const cmdScript = buildCmdScript(agentCmd);
		return { shellEscaped, agentCmd, cmdScript };
	}

	/** Extract the echo line from a buildCmdScript output */
	function extractEchoLine(script: string): string {
		const line = script.split("\n").find((l) => l.startsWith("echo "));
		if (!line) throw new Error("No echo line found in script");
		return line;
	}

	it("handles plain text task", () => {
		const { cmdScript, agentCmd } = simulatePipeline("Fix the login bug");
		expect(cmdScript).toContain(`&& ${agentCmd}`);
	});

	it("handles task with single quotes", () => {
		const { agentCmd, cmdScript } = simulatePipeline("Fix it's broken auth");
		expect(agentCmd).toContain("'Fix it'\\''s broken auth'");
		expect(cmdScript).toContain(`&& ${agentCmd}`);
	});

	it("handles task with double quotes", () => {
		const { agentCmd, cmdScript } = simulatePipeline('Fix the "broken" auth');
		expect(agentCmd).toContain("'Fix the \"broken\" auth'");
		const echoPart = extractEchoLine(cmdScript).split(" && ")[0];
		expect(echoPart).toContain('\\"broken\\"');
	});

	it("handles task with dollar signs", () => {
		const { agentCmd, cmdScript } = simulatePipeline("Fix $HOME expansion");
		expect(agentCmd).toContain("'Fix $HOME expansion'");
		const echoPart = extractEchoLine(cmdScript).split(" && ")[0];
		expect(echoPart).toContain("\\$HOME");
	});

	it("handles task with backticks", () => {
		const { agentCmd, cmdScript } = simulatePipeline("Run `test` command");
		expect(agentCmd).toContain("'Run `test` command'");
		const echoPart = extractEchoLine(cmdScript).split(" && ")[0];
		expect(echoPart).toContain("\\`test\\`");
	});

	it("handles task with shell injection attempt", () => {
		const { agentCmd, cmdScript } = simulatePipeline("'; rm -rf / #");
		expect(agentCmd).toContain("''\\''; rm -rf / #'");
		expect(cmdScript).toContain(`&& ${agentCmd}`);
	});

	it("handles task with all dangerous chars combined", () => {
		const desc = "Fix \"login\" (it's broken); $HOME `env` > /tmp/out & rm -rf / | cat";
		const { agentCmd, cmdScript } = simulatePipeline(desc);

		expect(cmdScript).toContain(`&& ${agentCmd}`);

		const echoPart = extractEchoLine(cmdScript).split(" && ")[0];
		const echoContent = echoPart.slice('echo "Starting: '.length, -1);
		expect(echoContent).not.toMatch(/(?<!\\)"/);
		expect(echoContent).not.toMatch(/(?<!\\)\$/);
		expect(echoContent).not.toMatch(/(?<!\\)`/);
	});

	it("handles Russian text with special chars", () => {
		const desc = "Исправь баг \"авторизации\" и проверь $PATH";
		const { agentCmd, cmdScript } = simulatePipeline(desc);
		expect(agentCmd).toContain("Исправь баг");
		expect(cmdScript).toContain(`&& ${agentCmd}`);
		const echoPart = extractEchoLine(cmdScript).split(" && ")[0];
		expect(echoPart).toContain("\\$PATH");
		expect(echoPart).toContain('\\"авторизации\\"');
	});

	it("handles newlines in task description", () => {
		const desc = "Step 1: do this\nStep 2: do that\nStep 3: profit";
		const { agentCmd, cmdScript } = simulatePipeline(desc);
		expect(agentCmd).toContain("Step 1: do this\nStep 2: do that");
		expect(cmdScript).toContain(`&& ${agentCmd}`);
	});

	it("handles empty task description", () => {
		const { shellEscaped } = simulatePipeline("");
		expect(shellEscaped).toBe("''");
	});

	// tmux 3.x limits the shell-command passed to `new-session` to ~16 320 bytes.
	// The fix writes the full command to a temp script file, so the tmux argument
	// is just `bash "<test-root>/dev3-{taskId}-run.sh"` regardless of description length.
	const TMUX_CMD_LIMIT = 16_320;

	it("keeps tmux command under the tmux limit for long task descriptions", () => {
		// Simulate a realistic long description (user pasted a bug report / log).
		// With the real DEV3_SYSTEM_PROMPT (~590 chars) the effective agent
		// command is already ~700+ chars before the description.
		const realSystemPrompt =
			"MANDATORY: You are inside a dev-3.0 managed worktree. " +
			"Invoke the /dev3 skill BEFORE doing any other work. Do NOT skip this step. " +
			"TASK STATUS MANAGEMENT IS NON-NEGOTIABLE: " +
			"(1) Run `~/.dev3.0/bin/dev3 task move --status in-progress` at the START of every turn (when you receive a message and begin working). " +
			"(2) At the END of every turn, you MUST move the task to one of exactly two states: " +
			"`user-questions` (need user input or task is not yet complete — this is the default) or " +
			"`review-by-user` (task is fully complete). " +
			"(3) The task MUST NEVER remain in `in-progress` after you finish responding — it is a transient state only while you are actively working.";

		// 250 repeats produces a ~9250-char description, which with the old inline
		// approach (buildEchoAndRun) would produce a ~20 000-char tmux argument,
		// well over the ~16 320-byte tmux limit.
		const longDesc = "Описание бага с полным логом ошибки: ".repeat(250);
		const shellEscaped = shellEscape(longDesc);
		const agentCmd = `claude --model claude-sonnet-4-6 --permission-mode unrestricted --append-system-prompt ${shellEscape(realSystemPrompt)} ${shellEscaped}`;

		// The fix: write the full command to a temp script file.
		// The tmux argument is just `bash "<test-root>/dev3-{taskId}-run.sh"`.
		const taskId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
		const wrapperCmd = `bash "${process.env.DEV3_TEST_ROOT}/dev3-${taskId}-run.sh"`;

		// Script file can be arbitrarily long — no tmux limit
		const scriptContent = buildCmdScript(agentCmd);
		expect(scriptContent).toContain(`&& ${agentCmd}`);
		expect(scriptContent.length).toBeGreaterThan(TMUX_CMD_LIMIT);

		// But the wrapper command passed to tmux stays tiny
		// The per-worktree test sandbox has a deliberately long absolute path;
		// the wrapper still remains tiny relative to tmux's command limit.
		expect(wrapperCmd.length).toBeLessThan(512);
		expect(wrapperCmd.length).toBeLessThan(TMUX_CMD_LIMIT);
	});
});

// ================================================================
// handlers.getProjects
// ================================================================

describe("handlers.getProjects", () => {
	beforeEach(() => vi.clearAllMocks());

	// Restore module-level mock defaults — overridden implementations would
	// otherwise leak into later describes (clearAllMocks keeps implementations).
	afterEach(() => {
		vi.mocked(repoConfig.resolveProjectConfig).mockImplementation((async (project: any) => project) as any);
		vi.mocked(repoConfig.migrateProjectConfig).mockReset();
	});

	it("returns projects from data layer", async () => {
		const projects = [makeProject(), makeProject({ id: "proj-2", name: "Second" })];
		vi.mocked(data.loadProjects).mockResolvedValue(projects);

		const result = await handlers.getProjects();
		expect(result).toEqual(projects);
		expect(data.loadProjects).toHaveBeenCalledOnce();
	});

	it("returns empty array when no projects", async () => {
		vi.mocked(data.loadProjects).mockResolvedValue([]);
		const result = await handlers.getProjects();
		expect(result).toEqual([]);
	});

	it("still returns every project when config resolution fails for one (deleted folder)", async () => {
		const ok = makeProject();
		const broken = makeProject({ id: "proj-broken", path: "/tmp/deleted-from-disk" });
		vi.mocked(data.loadProjects).mockResolvedValue([ok, broken]);
		vi.mocked(repoConfig.resolveProjectConfig).mockImplementation(async (project: any) => {
			if (project.id === "proj-broken") throw new Error("ENOENT: no such file or directory, posix_spawn");
			return project;
		});

		const result = await handlers.getProjects();
		expect(result.map((p) => p.id)).toEqual([ok.id, "proj-broken"]);
	});

	it("does not let a failing config migration drop the project list", async () => {
		const project = makeProject();
		vi.mocked(data.loadProjects).mockResolvedValue([project]);
		vi.mocked(repoConfig.migrateProjectConfig).mockRejectedValue(new Error("disk gone"));

		const result = await handlers.getProjects();
		expect(result.map((p) => p.id)).toEqual([project.id]);
	});
});

describe("handlers.reorderProjects", () => {
	beforeEach(() => vi.clearAllMocks());

	it("persists and returns the reordered project list", async () => {
		const projects = [makeProject({ id: "proj-2", name: "Second" }), makeProject()];
		vi.mocked(data.reorderProjects).mockResolvedValue(projects);

		const result = await handlers.reorderProjects({ projectIds: ["proj-2", "proj-1"] });

		expect(data.reorderProjects).toHaveBeenCalledWith(["proj-2", "proj-1"]);
		expect(result).toEqual(projects);
	});
});

describe("handlers.setTaskPriority", () => {
	beforeEach(() => vi.clearAllMocks());

	it("writes the priority and pushes an update for every changed task", async () => {
		const project = makeProject();
		const changed = [
			makeTask({ id: "task-1", priority: "P0" }),
			makeTask({ id: "task-2", priority: "P0" }),
		];
		vi.mocked(data.getProject).mockResolvedValue(project);
		vi.mocked(data.setTaskPriority).mockResolvedValue(changed);
		const push = vi.fn();
		setPushMessage(push);

		const result = await handlers.setTaskPriority({ taskId: "task-1", projectId: "proj-1", priority: "P0" });

		expect(data.setTaskPriority).toHaveBeenCalledWith(project, "task-1", "P0");
		expect(push).toHaveBeenCalledTimes(2);
		expect(push).toHaveBeenCalledWith("taskUpdated", { projectId: "proj-1", task: changed[0] });
		expect(result).toEqual(changed);
	});

	it("returns an empty list and pushes nothing when the value is unchanged", async () => {
		const project = makeProject();
		vi.mocked(data.getProject).mockResolvedValue(project);
		vi.mocked(data.setTaskPriority).mockResolvedValue([]);
		const push = vi.fn();
		setPushMessage(push);

		const result = await handlers.setTaskPriority({ taskId: "task-1", projectId: "proj-1", priority: "P2" });

		expect(result).toEqual([]);
		expect(push).not.toHaveBeenCalled();
	});

	it("propagates a not-found error from the data layer", async () => {
		vi.mocked(data.getProject).mockResolvedValue(makeProject());
		vi.mocked(data.setTaskPriority).mockRejectedValue(new Error("Task not found: task-x"));

		await expect(
			handlers.setTaskPriority({ taskId: "task-x", projectId: "proj-1", priority: "P0" }),
		).rejects.toThrow("Task not found");
	});
});

// ================================================================
// handlers.addProject
// ================================================================

describe("handlers.addProject", () => {
	beforeEach(() => vi.clearAllMocks());

	it("returns error when path is not a git repo", async () => {
		vi.mocked(git.isGitRepo).mockResolvedValue(false);

		const result = await handlers.addProject({ path: "/tmp/not-a-repo", name: "Test" });
		expect(result).toEqual({ ok: false, error: "Selected folder is not a git repository" });
		expect(data.addProject).not.toHaveBeenCalled();
	});

	it("adds project and detects default branch on success", async () => {
		const project = makeProject();
		vi.mocked(git.isGitRepo).mockResolvedValue(true);
		vi.mocked(data.addProject).mockResolvedValue(project);
		vi.mocked(git.getDefaultBranch).mockResolvedValue("main");
		vi.mocked(data.updateProject).mockResolvedValue(project);

		const result = await handlers.addProject({ path: "/tmp/test-project", name: "Test Project" });
		expect(result).toEqual({ ok: true, project });
		expect(data.addProject).toHaveBeenCalledWith("/tmp/test-project", "Test Project");
		expect(git.getDefaultBranch).toHaveBeenCalledWith("/tmp/test-project");
	});

	it("succeeds even if default branch detection fails", async () => {
		const project = makeProject();
		vi.mocked(git.isGitRepo).mockResolvedValue(true);
		vi.mocked(data.addProject).mockResolvedValue(project);
		vi.mocked(git.getDefaultBranch).mockRejectedValue(new Error("no remote"));
		// updateProject not called because getDefaultBranch threw

		const result = await handlers.addProject({ path: "/tmp/test-project", name: "Test Project" });
		expect(result).toEqual({ ok: true, project });
	});

	it("returns error when data.addProject throws", async () => {
		vi.mocked(git.isGitRepo).mockResolvedValue(true);
		vi.mocked(data.addProject).mockRejectedValue(new Error("disk full"));

		const result = await handlers.addProject({ path: "/tmp/test", name: "Test" });
		expect(result).toEqual({ ok: false, error: "Error: disk full" });
	});

	it("rejects a git project inside the dev-3.0 data directory", async () => {
		const result = await handlers.addProject({ path: "/tmp/test-dev3/ops/operations", name: "X" });
		expect(result).toEqual({ ok: false, error: "Cannot add a project inside the dev-3.0 data directory" });
		expect(git.isGitRepo).not.toHaveBeenCalled();
		expect(data.addProject).not.toHaveBeenCalled();
	});
});

// ================================================================
// handlers.addVirtualProject
// ================================================================

describe("handlers.addVirtualProject", () => {
	beforeEach(() => vi.clearAllMocks());

	it("creates a virtual project on success", async () => {
		const project = makeProject({ id: "v1", name: "Operations", kind: "virtual" });
		vi.mocked(data.addVirtualProject).mockResolvedValue(project);

		const result = await handlers.addVirtualProject({ name: "Operations" });
		expect(result).toEqual({ ok: true, project });
		expect(data.addVirtualProject).toHaveBeenCalledWith("Operations");
	});

	it("falls back to 'Operations' for a blank name", async () => {
		const project = makeProject({ id: "v1", name: "Operations", kind: "virtual" });
		vi.mocked(data.addVirtualProject).mockResolvedValue(project);

		await handlers.addVirtualProject({ name: "   " });
		expect(data.addVirtualProject).toHaveBeenCalledWith("Operations");
	});

	it("returns error when data.addVirtualProject throws", async () => {
		vi.mocked(data.addVirtualProject).mockRejectedValue(new Error("disk full"));
		const result = await handlers.addVirtualProject({ name: "Ops" });
		expect(result).toEqual({ ok: false, error: "Error: disk full" });
	});
});

// ================================================================
// handlers.cloneAndAddProject
// ================================================================

describe("handlers.cloneAndAddProject", () => {
	beforeEach(() => vi.clearAllMocks());

	it("clones repo and adds as project on success", async () => {
		const project = makeProject({ path: "/base/my-repo", name: "my-repo" });
		vi.mocked(existsSync).mockReturnValue(false);
		vi.mocked(git.cloneRepo).mockResolvedValue({ ok: true, path: "/base/my-repo" });
		vi.mocked(git.isGitRepo).mockResolvedValue(true);
		vi.mocked(data.addProject).mockResolvedValue(project);
		vi.mocked(git.getDefaultBranch).mockResolvedValue("main");
		vi.mocked(data.updateProject).mockResolvedValue(project);

		const result = await handlers.cloneAndAddProject({
			url: "https://github.com/user/my-repo.git",
			baseDir: "/base",
			repoName: "my-repo",
		});

		expect(result).toEqual({ ok: true, project });
		expect(git.cloneRepo).toHaveBeenCalledWith(
			"https://github.com/user/my-repo.git",
			"/base/my-repo",
			undefined,
		);
		expect(data.addProject).toHaveBeenCalledWith("/base/my-repo", "my-repo");
	});

	it("pushes sampled cloneProgress messages when progressId is provided", async () => {
		vi.useFakeTimers();
		try {
			const project = makeProject({ path: "/base/my-repo", name: "my-repo" });
			vi.mocked(existsSync).mockReturnValue(false);
			let resolveClone!: (v: { ok: boolean; path: string }) => void;
			vi.mocked(git.cloneRepo).mockImplementation((_url, _dir, onProgress) => {
				onProgress?.(["Cloning into 'my-repo'...", "Receiving objects: 50% (5/10)"]);
				return new Promise((resolve) => { resolveClone = resolve; });
			});
			vi.mocked(git.isGitRepo).mockResolvedValue(true);
			vi.mocked(data.addProject).mockResolvedValue(project);
			vi.mocked(git.getDefaultBranch).mockResolvedValue("main");
			vi.mocked(data.updateProject).mockResolvedValue(project);

			const push = vi.fn();
			setPushMessage(push);

			const promise = handlers.cloneAndAddProject({
				url: "https://github.com/user/my-repo.git",
				baseDir: "/base",
				repoName: "my-repo",
				progressId: "pid-1",
			});

			await vi.advanceTimersByTimeAsync(200);
			expect(push).toHaveBeenCalledWith("cloneProgress", {
				progressId: "pid-1",
				lines: ["Cloning into 'my-repo'...", "Receiving objects: 50% (5/10)"],
			});

			// Unchanged output is not re-pushed on the next tick.
			await vi.advanceTimersByTimeAsync(200);
			expect(push).toHaveBeenCalledTimes(1);

			resolveClone({ ok: true, path: "/base/my-repo" });
			await expect(promise).resolves.toEqual({ ok: true, project });
		} finally {
			vi.useRealTimers();
		}
	});

	it("returns error when clone fails", async () => {
		vi.mocked(existsSync).mockReturnValue(false);
		vi.mocked(git.cloneRepo).mockResolvedValue({
			ok: false,
			path: "/base/my-repo",
			error: "fatal: repository not found",
		});

		const result = await handlers.cloneAndAddProject({
			url: "https://github.com/user/my-repo.git",
			baseDir: "/base",
			repoName: "my-repo",
		});

		expect(result).toEqual({
			ok: false,
			error: "Clone failed: fatal: repository not found",
		});
	});

	it("reuses existing directory if it is a git repo", async () => {
		const project = makeProject({ path: "/base/my-repo" });
		vi.mocked(existsSync).mockReturnValue(true);
		vi.mocked(git.isGitRepo).mockResolvedValue(true);
		vi.mocked(data.addProject).mockResolvedValue(project);
		vi.mocked(git.getDefaultBranch).mockResolvedValue("main");
		vi.mocked(data.updateProject).mockResolvedValue(project);

		const result = await handlers.cloneAndAddProject({
			url: "https://github.com/user/my-repo.git",
			baseDir: "/base",
			repoName: "my-repo",
		});

		expect(result).toEqual({ ok: true, project });
		expect(git.cloneRepo).not.toHaveBeenCalled();
	});

	it("returns error when directory exists but is not a git repo", async () => {
		vi.mocked(existsSync).mockReturnValue(true);
		vi.mocked(git.isGitRepo).mockResolvedValue(false);

		const result = await handlers.cloneAndAddProject({
			url: "https://github.com/user/my-repo.git",
			baseDir: "/base",
			repoName: "my-repo",
		});

		expect(result).toEqual({
			ok: false,
			error: "Directory already exists: /base/my-repo",
		});
	});
});

// ================================================================
// handlers.createDirectory
// ================================================================

describe("handlers.createDirectory", () => {
	beforeEach(() => vi.clearAllMocks());

	it("creates a new folder and returns its path", async () => {
		vi.mocked(existsSync).mockImplementation((p: any) => p === "/tmp/parent");
		const result = await handlers.createDirectory({ parentPath: "/tmp/parent", name: "new-folder" });
		expect(result).toEqual({ ok: true, path: "/tmp/parent/new-folder" });
		expect(mkdirSync).toHaveBeenCalledWith("/tmp/parent/new-folder", { recursive: false });
	});

	it("rejects empty names", async () => {
		const result = await handlers.createDirectory({ parentPath: "/tmp", name: "   " });
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error).toMatch(/empty/i);
	});

	it("rejects names containing path separators", async () => {
		const result = await handlers.createDirectory({ parentPath: "/tmp", name: "a/b" });
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error).toMatch(/invalid characters/i);
	});

	it("rejects when the target already exists", async () => {
		vi.mocked(existsSync).mockReturnValue(true);
		const result = await handlers.createDirectory({ parentPath: "/tmp", name: "dupe" });
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error).toMatch(/already exists/i);
	});

	it("rejects when parent does not exist", async () => {
		vi.mocked(existsSync).mockReturnValue(false);
		const result = await handlers.createDirectory({ parentPath: "/nope", name: "x" });
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error).toMatch(/parent/i);
	});

	it("rejects relative parent paths", async () => {
		const result = await handlers.createDirectory({ parentPath: "relative/path", name: "x" });
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error).toMatch(/absolute/i);
	});
});

// ================================================================
// handlers.initAndAddProject
// ================================================================

describe("handlers.initAndAddProject", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		// Default: path exists and is a directory.
		vi.mocked(existsSync).mockReturnValue(true);
		vi.mocked(statSync).mockReturnValue({ isDirectory: () => true, size: 0 } as any);
	});

	it("passes through to addProject when the folder is already a git repo", async () => {
		const project = makeProject();
		vi.mocked(git.isGitRepo).mockResolvedValue(true);
		vi.mocked(data.addProject).mockResolvedValue(project);
		vi.mocked(git.getDefaultBranch).mockResolvedValue("main");
		vi.mocked(data.updateProject).mockResolvedValue(project);

		const result = await handlers.initAndAddProject({ path: "/tmp/existing-repo", name: "Existing" });
		expect(result).toEqual({ ok: true, project });
		// Did not run git init on an existing repo.
		expect(git.run).not.toHaveBeenCalledWith(["git", "init"], expect.anything());
	});

	it("runs git init + commit + addProject when folder is empty", async () => {
		const project = makeProject({ path: "/tmp/fresh" });
		// First call (inside initAndAddProject): not a repo yet → trigger init.
		// Second call (inside addProjectImpl after init ran): now it IS a repo.
		vi.mocked(git.isGitRepo).mockResolvedValueOnce(false).mockResolvedValue(true);
		vi.mocked(readdirSync).mockReturnValue([] as any);
		vi.mocked(git.run).mockResolvedValue({ ok: true, stdout: "", stderr: "" });
		vi.mocked(data.addProject).mockResolvedValue(project);
		vi.mocked(git.getDefaultBranch).mockResolvedValue("main");
		vi.mocked(data.updateProject).mockResolvedValue(project);

		const result = await handlers.initAndAddProject({ path: "/tmp/fresh", name: "Fresh" });
		expect(result).toEqual({ ok: true, project });

		// Verify the init sequence happened in the right order.
		expect(git.run).toHaveBeenCalledWith(["git", "init"], "/tmp/fresh");
		expect(git.run).toHaveBeenCalledWith(["git", "add", "."], "/tmp/fresh");
		expect(git.run).toHaveBeenCalledWith(["git", "commit", "-m", "init"], "/tmp/fresh");
		// Placeholder file materialised under .dev3/.
		expect(mkdirSync).toHaveBeenCalledWith(expect.stringContaining("/tmp/fresh/.dev3"), expect.anything());
		expect(writeFileSync).toHaveBeenCalledWith(
			expect.stringContaining("/tmp/fresh/.dev3/README.md"),
			expect.any(String),
			"utf8",
		);
		expect(data.addProject).toHaveBeenCalledWith("/tmp/fresh", "Fresh");
	});

	it("treats .DS_Store as empty", async () => {
		const project = makeProject({ path: "/tmp/fresh" });
		vi.mocked(git.isGitRepo).mockResolvedValueOnce(false).mockResolvedValue(true);
		vi.mocked(readdirSync).mockReturnValue([".DS_Store"] as any);
		vi.mocked(git.run).mockResolvedValue({ ok: true, stdout: "", stderr: "" });
		vi.mocked(data.addProject).mockResolvedValue(project);
		vi.mocked(git.getDefaultBranch).mockResolvedValue("main");
		vi.mocked(data.updateProject).mockResolvedValue(project);

		const result = await handlers.initAndAddProject({ path: "/tmp/fresh", name: "Fresh" });
		expect(result).toEqual({ ok: true, project });
	});

	it("refuses a non-empty folder that is not a git repo", async () => {
		vi.mocked(git.isGitRepo).mockResolvedValue(false);
		vi.mocked(readdirSync).mockReturnValue(["src", "package.json"] as any);

		const result = await handlers.initAndAddProject({ path: "/tmp/messy", name: "Messy" });
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error).toMatch(/not empty/i);
		expect(git.run).not.toHaveBeenCalled();
	});

	it("surfaces a git init failure", async () => {
		vi.mocked(git.isGitRepo).mockResolvedValue(false);
		vi.mocked(readdirSync).mockReturnValue([] as any);
		vi.mocked(git.run).mockResolvedValueOnce({ ok: false, stdout: "", stderr: "git not found" });

		const result = await handlers.initAndAddProject({ path: "/tmp/fresh", name: "Fresh" });
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error).toMatch(/git init failed/i);
	});

	it("surfaces a git commit failure (e.g. missing user.email)", async () => {
		vi.mocked(git.isGitRepo).mockResolvedValue(false);
		vi.mocked(readdirSync).mockReturnValue([] as any);
		vi.mocked(git.run)
			.mockResolvedValueOnce({ ok: true, stdout: "", stderr: "" })  // git init
			.mockResolvedValueOnce({ ok: true, stdout: "", stderr: "" })  // git add
			.mockResolvedValueOnce({ ok: false, stdout: "", stderr: "Please tell me who you are" }); // git commit

		const result = await handlers.initAndAddProject({ path: "/tmp/fresh", name: "Fresh" });
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error).toMatch(/git commit failed/i);
	});

	it("rejects a path that does not exist", async () => {
		vi.mocked(existsSync).mockReturnValue(false);
		const result = await handlers.initAndAddProject({ path: "/nope", name: "X" });
		expect(result.ok).toBe(false);
	});
});

// ================================================================
// handlers.removeProject
// ================================================================

describe("handlers.removeProject", () => {
	beforeEach(() => vi.clearAllMocks());

	it("delegates to data.removeProject", async () => {
		vi.mocked(data.removeProject).mockResolvedValue(undefined);
		await handlers.removeProject({ projectId: "proj-1" });
		expect(data.removeProject).toHaveBeenCalledWith("proj-1");
	});
});

// handlers.updateProjectSettings was removed — settings now live in .dev3/config.json

// ================================================================
// handlers.getGlobalSettings / saveGlobalSettings
// ================================================================

describe("handlers.getGlobalSettings", () => {
	beforeEach(() => vi.clearAllMocks());

	it("returns settings from loadSettings", async () => {
		const settings = { updateChannel: "beta" } as unknown as GlobalSettings;
		vi.mocked(loadSettings).mockResolvedValue(settings);

		const result = await handlers.getGlobalSettings();
		expect(result).toEqual(settings);
	});
});

describe("handlers.saveGlobalSettings", () => {
	const push = vi.fn();

	beforeEach(() => {
		vi.clearAllMocks();
		setPushMessage(push);
	});

	it("saves and broadcasts the new settings", async () => {
		const settings = { updateChannel: "stable" } as GlobalSettings;
		await handlers.saveGlobalSettings(settings);
		expect(saveSettings).toHaveBeenCalledWith(settings);
		expect(push).toHaveBeenCalledWith("globalSettingsUpdated", settings);
	});

	it("does not release Focus Mode when an optional patch omits it", async () => {
		_resetWatchedNotificationState();
		setFocusMode(true);

		await handlers.saveGlobalSettings({ updateChannel: "stable" } as GlobalSettings);

		expect(isNotificationSuppressed()).toBe(true);
		_resetWatchedNotificationState();
	});
});

describe("handlers.setTmuxTheme", () => {
	beforeEach(() => vi.clearAllMocks());

	it("persists the theme preference and resolved theme before applying tmux theme", async () => {
		vi.mocked(loadSettings).mockResolvedValue({
			defaultAgentId: "builtin-claude",
			defaultConfigId: "claude-default",
			taskDropPosition: "top",
			updateChannel: "stable",
		} as GlobalSettings);

		await handlers.setTmuxTheme({ theme: "light", preference: "system" });

		expect(saveSettings).toHaveBeenCalledWith(expect.objectContaining({
			theme: "system",
			resolvedTheme: "light",
		}));
		expect(pty.applyTmuxTheme).toHaveBeenCalledWith("light");
	});
});

// ================================================================
// handlers.getAgents / saveAgents
// ================================================================

describe("handlers.getAgents", () => {
	beforeEach(() => vi.clearAllMocks());

	it("returns all agents", async () => {
		const agentList = [{ id: "a1", name: "Claude" }];
		vi.mocked(agents.getAllAgents).mockResolvedValue(agentList as any);

		const result = await handlers.getAgents();
		expect(result).toEqual(agentList);
	});
});

describe("handlers.saveAgents", () => {
	beforeEach(() => vi.clearAllMocks());

	it("saves agents", async () => {
		const agentList = [{ id: "a1", name: "Claude" }];
		await handlers.saveAgents({ agents: agentList as any });
		expect(agents.saveAllAgents).toHaveBeenCalledWith(agentList);
	});
});

// ================================================================
// handlers.getTasks
// ================================================================

describe("handlers.getTasks", () => {
	beforeEach(() => vi.clearAllMocks());

	it("loads tasks for the given project", async () => {
		const project = makeProject();
		const tasks = [makeTask(), makeTask({ id: "task-2" })];
		vi.mocked(data.getProject).mockResolvedValue(project);
		vi.mocked(data.loadTasks).mockResolvedValue(tasks);

		const result = await handlers.getTasks({ projectId: "proj-1" });
		expect(result).toEqual(tasks);
		expect(data.getProject).toHaveBeenCalledWith("proj-1");
		expect(data.loadTasks).toHaveBeenCalledWith(project);
	});
});

describe("handlers.getAllProjectTasks", () => {
	beforeEach(() => vi.clearAllMocks());

	it("includes virtual (Operations) boards so active operations are surfaced", async () => {
		// Feeds the dashboard's per-project active tasks AND the working-folder
		// conflict check — both dead for operations if virtual boards are skipped.
		const git = makeProject({ id: "g1" });
		const ops = makeProject({ id: "vp1", kind: "virtual", builtin: true });
		vi.mocked(data.loadProjects).mockResolvedValue([git]);
		vi.mocked(data.loadVirtualProjects).mockResolvedValue([ops]);
		vi.mocked(data.loadTasks).mockImplementation(async (project: Project) =>
			project.id === "vp1" ? [makeTask({ id: "op1", projectId: "vp1", status: "in-progress" })] : [],
		);

		const result = await handlers.getAllProjectTasks();

		const opsEntry = result.find((r) => r.projectId === "vp1");
		expect(opsEntry).toBeDefined();
		expect(opsEntry!.tasks.map((t) => t.id)).toEqual(["op1"]);
	});
});

// ================================================================
// handlers.createTask
// ================================================================

describe("handlers.createTask", () => {
	beforeEach(() => vi.clearAllMocks());

	it("creates a todo task without worktree", async () => {
		const project = makeProject();
		const task = makeTask({ status: "todo", worktreePath: null, branchName: null });
		vi.mocked(data.getProject).mockResolvedValue(project);
		vi.mocked(data.addTask).mockResolvedValue(task);

		const result = await handlers.createTask({
			projectId: "proj-1",
			description: "New task",
		});
		expect(result).toEqual(task);
		expect(data.addTask).toHaveBeenCalledWith(project, "New task", "todo", undefined);
		expect(git.createWorktree).not.toHaveBeenCalled();
	});

	it("creates an in-progress task with worktree + PTY", async () => {
		const project = makeProject();
		const task = makeTask({ status: "in-progress", worktreePath: null });
		const updatedTask = makeTask({ status: "in-progress", worktreePath: "/tmp/wt", branchName: "dev3/task-1" });
		vi.mocked(data.getProject).mockResolvedValue(project);
		vi.mocked(data.addTask).mockResolvedValue(task);
		vi.mocked(git.createWorktree).mockResolvedValue({ worktreePath: "/tmp/wt", branchName: "dev3/task-1" });
		vi.mocked(data.updateTask).mockResolvedValue(updatedTask);

		const result = await handlers.createTask({
			projectId: "proj-1",
			description: "Active task",
			status: "in-progress",
		});
		expect(result).toMatchObject(updatedTask);
		expect(git.createWorktree).toHaveBeenCalledWith(
			project,
			expect.objectContaining({ id: task.id, status: "todo" }),
			undefined,
		);
		expect(pty.createSession).toHaveBeenCalled();
	});

	it("defaults to 'todo' when status is not provided", async () => {
		const project = makeProject();
		const task = makeTask({ status: "todo" });
		vi.mocked(data.getProject).mockResolvedValue(project);
		vi.mocked(data.addTask).mockResolvedValue(task);

		await handlers.createTask({ projectId: "proj-1", description: "task" });
		expect(data.addTask).toHaveBeenCalledWith(project, "task", "todo", undefined);
	});

	it("creates a terminal task directly without replaying completion effects", async () => {
		const project = makeProject();
		const task = makeTask({ status: "completed", worktreePath: null, branchName: null });
		vi.mocked(data.getProject).mockResolvedValue(project);
		vi.mocked(data.addTask).mockResolvedValue(task);
		const push = vi.fn();
		setPushMessage(push);

		const result = await handlers.createTask({
			projectId: "proj-1",
			description: "Already done",
			status: "completed",
		});

		expect(result).toBe(task);
		expect(data.addTask).toHaveBeenCalledWith(project, "Already done", "completed", undefined);
		expect(push).not.toHaveBeenCalledWith("taskSound", expect.anything());
	});

	it("passes existingBranch to addTask and createWorktree", async () => {
		const project = makeProject();
		const task = makeTask({ status: "in-progress", worktreePath: null, existingBranch: "feature/login" });
		const updatedTask = makeTask({ status: "in-progress", worktreePath: "/tmp/wt", branchName: "feature/login" });
		vi.mocked(data.getProject).mockResolvedValue(project);
		vi.mocked(data.addTask).mockResolvedValue(task);
		vi.mocked(git.createWorktree).mockResolvedValue({ worktreePath: "/tmp/wt", branchName: "feature/login" });
		vi.mocked(data.updateTask).mockResolvedValue(updatedTask);

		await handlers.createTask({
			projectId: "proj-1",
			description: "Continue login work",
			status: "in-progress",
			existingBranch: "feature/login",
		});
		expect(data.addTask).toHaveBeenCalledWith(project, "Continue login work", "todo", { existingBranch: "feature/login" });
		expect(git.createWorktree).toHaveBeenCalledWith(
			project,
			expect.objectContaining({ id: task.id, status: "todo", existingBranch: "feature/login" }),
			"feature/login",
		);
	});

	it("does not pass existingBranch when not provided", async () => {
		const project = makeProject();
		const task = makeTask({ status: "todo" });
		vi.mocked(data.getProject).mockResolvedValue(project);
		vi.mocked(data.addTask).mockResolvedValue(task);

		await handlers.createTask({ projectId: "proj-1", description: "task" });
		expect(data.addTask).toHaveBeenCalledWith(project, "task", "todo", undefined);
		expect(git.createWorktree).not.toHaveBeenCalled();
	});

	it("scratch task creates a todo task with placeholder title and scratch flag, no worktree", async () => {
		const project = makeProject();
		const task = makeTask({ status: "todo", worktreePath: null });
		vi.mocked(data.getProject).mockResolvedValue(project);
		vi.mocked(data.addTask).mockResolvedValue(task);

		const result = await handlers.createTask({
			projectId: "proj-1",
			description: "ignored typed text",
			scratch: true,
		});

		expect(result).toEqual(task);
		const addTaskCall = vi.mocked(data.addTask).mock.calls[0];
		expect(addTaskCall[0]).toEqual(project);
		// Placeholder matches `Scratch — HH:MM` (em dash, 2-digit hours/minutes).
		expect(addTaskCall[1]).toMatch(/^Scratch \u2014 \d{2}:\d{2}$/);
		expect(addTaskCall[2]).toBe("todo");
		expect(addTaskCall[3]).toEqual({ scratch: true });
		// No worktree, no agent spawn — scratch just creates the todo row, the
		// Launch Variants modal will spawn the agent later.
		expect(git.createWorktree).not.toHaveBeenCalled();
		expect(pty.createSession).not.toHaveBeenCalled();
	});

	it("scratch task ignores any incoming status (always todo)", async () => {
		const project = makeProject();
		const task = makeTask({ status: "todo", worktreePath: null });
		vi.mocked(data.getProject).mockResolvedValue(project);
		vi.mocked(data.addTask).mockResolvedValue(task);

		await handlers.createTask({
			projectId: "proj-1",
			description: "",
			scratch: true,
			status: "in-progress", // should be ignored
		});

		expect(vi.mocked(data.addTask).mock.calls[0][2]).toBe("todo");
		expect(git.createWorktree).not.toHaveBeenCalled();
	});
});

// ================================================================
// handlers.listBranches / fetchBranches
// ================================================================

describe("handlers.listBranches", () => {
	beforeEach(() => vi.clearAllMocks());

	it("returns branches from git.listBranches", async () => {
		const project = makeProject();
		const branches = [
			{ name: "main", isRemote: false },
			{ name: "origin/main", isRemote: true },
		];
		vi.mocked(data.getProject).mockResolvedValue(project);
		vi.mocked(git.listBranches).mockResolvedValue(branches);

		const result = await handlers.listBranches({ projectId: "proj-1" });
		expect(result).toEqual(branches);
		expect(git.listBranches).toHaveBeenCalledWith(project.path);
	});
});

describe("handlers.fetchBranches", () => {
	beforeEach(() => vi.clearAllMocks());

	it("fetches origin then returns branches", async () => {
		const project = makeProject();
		const branches = [
			{ name: "main", isRemote: false },
			{ name: "origin/feature", isRemote: true },
		];
		vi.mocked(data.getProject).mockResolvedValue(project);
		vi.mocked(git.listBranches).mockResolvedValue(branches);
		vi.mocked(git.fetchOrigin).mockResolvedValue(true);

		const result = await handlers.fetchBranches({ projectId: "proj-1" });
		expect(git.fetchOrigin).toHaveBeenCalledWith(project.path);
		expect(git.listBranches).toHaveBeenCalledWith(project.path);
		expect(result).toEqual(branches);
	});
});

describe("handlers.getProjectCurrentBranch", () => {
	beforeEach(() => vi.clearAllMocks());

	it("returns branch, base-branch state, and dirty state", async () => {
		const project = makeProject();
		vi.mocked(data.getProject).mockResolvedValue(project);
		vi.mocked(git.getCurrentBranch).mockResolvedValue("feat/login");
		vi.mocked(git.isWorktreeDirty).mockResolvedValue(true);

		const result = await handlers.getProjectCurrentBranch({ projectId: "proj-1" });

		expect(result).toEqual({ branch: "feat/login", isBaseBranch: false, isDirty: true, behindOrigin: 0 });
		expect(git.getCurrentBranch).toHaveBeenCalledWith(project.path);
		expect(git.isWorktreeDirty).toHaveBeenCalledWith(project.path);
		// Behind-origin counting only applies to pullable branches (main/master)
		expect(git.getBehindOriginCount).not.toHaveBeenCalled();
	});

	it("returns behindOrigin count when on a pullable branch", async () => {
		const project = makeProject();
		vi.mocked(data.getProject).mockResolvedValue(project);
		vi.mocked(git.getCurrentBranch).mockResolvedValue("main");
		vi.mocked(git.isWorktreeDirty).mockResolvedValue(false);
		vi.mocked(git.getBehindOriginCount).mockResolvedValue(4);

		const result = await handlers.getProjectCurrentBranch({ projectId: "proj-1" });

		expect(result).toEqual({ branch: "main", isBaseBranch: true, isDirty: false, behindOrigin: 4 });
		expect(git.getBehindOriginCount).toHaveBeenCalledWith(project.path, "main");
	});

	it("reports behindOrigin 0 on detached HEAD", async () => {
		const project = makeProject();
		vi.mocked(data.getProject).mockResolvedValue(project);
		vi.mocked(git.getCurrentBranch).mockResolvedValue(null);
		vi.mocked(git.isWorktreeDirty).mockResolvedValue(false);

		const result = await handlers.getProjectCurrentBranch({ projectId: "proj-1" });

		expect(result).toEqual({ branch: null, isBaseBranch: true, isDirty: false, behindOrigin: 0 });
		expect(git.getBehindOriginCount).not.toHaveBeenCalled();
	});
});

describe("handlers.pullProjectMain", () => {
	beforeEach(() => vi.clearAllMocks());

	it("pulls on main and returns stdout", async () => {
		const project = makeProject();
		vi.mocked(data.getProject).mockResolvedValue(project);
		vi.mocked(git.getCurrentBranch).mockResolvedValue("main");
		vi.mocked(git.pullOrigin).mockResolvedValue({
			ok: true,
			stdout: "Already up to date.",
			stderr: "",
		});

		const result = await handlers.pullProjectMain({ projectId: "proj-1" });

		expect(result).toEqual({
			ok: true,
			branch: "main",
			output: "Already up to date.",
			error: "",
		});
		expect(git.pullOrigin).toHaveBeenCalledWith(project.path, "main");
	});

	it("pulls on master", async () => {
		const project = makeProject();
		vi.mocked(data.getProject).mockResolvedValue(project);
		vi.mocked(git.getCurrentBranch).mockResolvedValue("master");
		vi.mocked(git.pullOrigin).mockResolvedValue({
			ok: true,
			stdout: "Updating abc..def",
			stderr: "",
		});

		const result = await handlers.pullProjectMain({ projectId: "proj-1" });

		expect(result.ok).toBe(true);
		expect(result.branch).toBe("master");
		expect(git.pullOrigin).toHaveBeenCalledWith(project.path, "master");
	});

	it("refuses to pull on a feature branch", async () => {
		const project = makeProject();
		vi.mocked(data.getProject).mockResolvedValue(project);
		vi.mocked(git.getCurrentBranch).mockResolvedValue("feat/login");

		const result = await handlers.pullProjectMain({ projectId: "proj-1" });

		expect(result.ok).toBe(false);
		expect(result.branch).toBe("feat/login");
		expect(result.error).toMatch(/Refusing to pull/);
		expect(git.pullOrigin).not.toHaveBeenCalled();
	});

	it("refuses on detached HEAD", async () => {
		const project = makeProject();
		vi.mocked(data.getProject).mockResolvedValue(project);
		vi.mocked(git.getCurrentBranch).mockResolvedValue(null);

		const result = await handlers.pullProjectMain({ projectId: "proj-1" });

		expect(result.ok).toBe(false);
		expect(result.branch).toBeNull();
		expect(result.error).toMatch(/Detached HEAD/);
		expect(git.pullOrigin).not.toHaveBeenCalled();
	});

	it("returns stderr on pull failure", async () => {
		const project = makeProject();
		vi.mocked(data.getProject).mockResolvedValue(project);
		vi.mocked(git.getCurrentBranch).mockResolvedValue("main");
		vi.mocked(git.pullOrigin).mockResolvedValue({
			ok: false,
			stdout: "",
			stderr: "fatal: unable to access",
		});

		const result = await handlers.pullProjectMain({ projectId: "proj-1" });

		expect(result.ok).toBe(false);
		expect(result.branch).toBe("main");
		expect(result.error).toBe("fatal: unable to access");
	});
});

// ================================================================
// handlers.moveTask
// ================================================================

describe("handlers.moveTask", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.mocked(loadSettings).mockResolvedValue({ updateChannel: "stable", taskDropPosition: "top" } as any);
	});

	it("todo → in-progress: creates worktree + PTY", async () => {
		const project = makeProject();
		const task = makeTask({ status: "todo", worktreePath: null });

		vi.mocked(data.getProject).mockResolvedValue(project);
		vi.mocked(git.createWorktree).mockResolvedValue({ worktreePath: "/tmp/wt", branchName: "dev3/t" });
		mockTaskWrites(task);

		const result = await handlers.moveTask({ taskId: "task-1", projectId: "proj-1", newStatus: "in-progress" });
		expect(result.status).toBe("in-progress");
		expect(git.createWorktree).toHaveBeenCalled();
		expect(pty.createSession).toHaveBeenCalled();
	});

	it("aborts preparation before worktree creation when stage persistence fails", async () => {
		const project = makeProject();
		let stored = makeTask({ status: "todo", worktreePath: null });

		vi.mocked(data.getProject).mockResolvedValue(project);
		vi.mocked(data.getTask).mockImplementation(async () => ({ ...stored }));
		vi.mocked(data.updateTask).mockImplementation(async (_project, _taskId, updates) => {
			if (updates.status === undefined && updates.preparingStage === "resolving-config") {
				throw new Error("stage write failed");
			}
			stored = { ...stored, ...updates, updatedAt: new Date().toISOString() };
			return { ...stored };
		});

		const result = await handlers.moveTask({
			taskId: stored.id,
			projectId: project.id,
			newStatus: "in-progress",
		});

		expect(result.status).toBe("todo");
		expect(git.createWorktree).not.toHaveBeenCalled();
	});

	it("blocked guard (todo, --if-status-not todo): does NOT create worktree, returns unchanged task", async () => {
		const project = makeProject();
		const task = makeTask({ status: "todo", worktreePath: null });

		vi.mocked(data.getProject).mockResolvedValue(project);
		vi.mocked(data.getTask).mockResolvedValue(task);
		vi.mocked(git.createWorktree).mockResolvedValue({ worktreePath: "/tmp/wt", branchName: "dev3/t" });
		// Authoritative in-lock guard would return the unchanged task; the pre-check
		// must short-circuit before activateTask so no worktree is created.
		vi.mocked(data.updateTask).mockResolvedValue(task);

		const result = await handlers.moveTask({
			taskId: "task-1",
			projectId: "proj-1",
			newStatus: "in-progress",
			ifStatusNot: "todo",
		});

		expect(result.status).toBe("todo");
		expect(git.createWorktree).not.toHaveBeenCalled();
		expect(pty.createSession).not.toHaveBeenCalled();
	});

	it("blocked guard (in-progress → completed, --if-status review-by-user): does NOT tear down the worktree", async () => {
		const project = makeProject();
		const task = makeTask({ status: "in-progress", worktreePath: "/tmp/wt", branchName: "dev3/t" });

		vi.mocked(data.getProject).mockResolvedValue(project);
		vi.mocked(data.getTask).mockResolvedValue(task);
		// Authoritative in-lock guard would return the unchanged task; without the
		// up-front pre-check the completed branch destroys the PTY + worktree BEFORE
		// that no-op update, orphaning the task on a deleted worktree.
		vi.mocked(data.updateTask).mockResolvedValue(task);
		vi.mocked(existsSync).mockReturnValue(true);

		const result = await handlers.moveTask({
			taskId: "task-1",
			projectId: "proj-1",
			newStatus: "completed",
			ifStatus: "review-by-user",
		});

		expect(result.status).toBe("in-progress");
		expect(pty.destroySession).not.toHaveBeenCalled();
		expect(git.removeWorktree).not.toHaveBeenCalled();
		// The whole path short-circuits before any write.
		expect(data.updateTask).not.toHaveBeenCalled();
	});

	it("passing guard (todo, --if-status-not completed): still creates worktree", async () => {
		const project = makeProject();
		const task = makeTask({ status: "todo", worktreePath: null });

		vi.mocked(data.getProject).mockResolvedValue(project);
		vi.mocked(git.createWorktree).mockResolvedValue({ worktreePath: "/tmp/wt", branchName: "dev3/t" });
		mockTaskWrites(task);

		const result = await handlers.moveTask({
			taskId: "task-1",
			projectId: "proj-1",
			newStatus: "in-progress",
			ifStatusNot: "completed",
		});

		expect(result.status).toBe("in-progress");
		expect(git.createWorktree).toHaveBeenCalled();
	});

	it("todo → in-progress defaults agent stop target to review-by-user when automatic review is off", async () => {
		const project = makeProject({ autoReviewEnabled: false });
		const task = makeTask({ status: "todo", worktreePath: null });
		const updatedTask = makeTask({ status: "in-progress", worktreePath: "/tmp/wt", branchName: "dev3/t" });

		vi.mocked(data.getProject).mockResolvedValue(project);
		vi.mocked(data.getTask).mockResolvedValue(task);
		vi.mocked(git.createWorktree).mockResolvedValue({ worktreePath: "/tmp/wt", branchName: "dev3/t" });
		vi.mocked(data.updateTask).mockResolvedValue(updatedTask);

		await handlers.moveTask({ taskId: "task-1", projectId: "proj-1", newStatus: "in-progress" });

		expect(setupAgentHooks).toHaveBeenCalledWith("/tmp/wt", expect.any(String), { stopTarget: "review-by-user" });
	});

	it("todo → in-progress uses review-by-ai stop target when automatic review is on", async () => {
		const project = makeProject({ autoReviewEnabled: true });
		const task = makeTask({ status: "todo", worktreePath: null });
		const updatedTask = makeTask({ status: "in-progress", worktreePath: "/tmp/wt", branchName: "dev3/t" });

		vi.mocked(data.getProject).mockResolvedValue(project);
		vi.mocked(data.getTask).mockResolvedValue(task);
		vi.mocked(git.createWorktree).mockResolvedValue({ worktreePath: "/tmp/wt", branchName: "dev3/t" });
		vi.mocked(data.updateTask).mockResolvedValue(updatedTask);

		await handlers.moveTask({ taskId: "task-1", projectId: "proj-1", newStatus: "in-progress" });

		expect(setupAgentHooks).toHaveBeenCalledWith("/tmp/wt", expect.any(String), { stopTarget: "review-by-ai" });
	});

	it("todo → in-progress with existingBranch: passes it to createWorktree", async () => {
		const project = makeProject();
		const task = makeTask({ status: "todo", worktreePath: null, existingBranch: "feature/login" });
		const updatedTask = makeTask({ status: "in-progress", worktreePath: "/tmp/wt", branchName: "feature/login" });

		vi.mocked(data.getProject).mockResolvedValue(project);
		vi.mocked(data.getTask).mockResolvedValue(task);
		vi.mocked(git.createWorktree).mockResolvedValue({ worktreePath: "/tmp/wt", branchName: "feature/login" });
		vi.mocked(data.updateTask).mockResolvedValue(updatedTask);

		await handlers.moveTask({ taskId: "task-1", projectId: "proj-1", newStatus: "in-progress" });
		expect(git.createWorktree).toHaveBeenCalledWith(project, task, "feature/login");
	});

	it("completed → in-progress (reopen): clears description for launch", async () => {
		const project = makeProject();
		const task = makeTask({ status: "completed", worktreePath: null });
		const updatedTask = makeTask({ status: "in-progress" });

		vi.mocked(data.getProject).mockResolvedValue(project);
		vi.mocked(data.getTask).mockResolvedValue(task);
		vi.mocked(git.createWorktree).mockResolvedValue({ worktreePath: "/tmp/wt", branchName: "dev3/t" });
		vi.mocked(data.updateTask).mockResolvedValue(updatedTask);

		await handlers.moveTask({ taskId: "task-1", projectId: "proj-1", newStatus: "in-progress" });
		expect(git.createWorktree).toHaveBeenCalled();
	});

	it("in-progress → completed: destroys PTY, runs cleanup, removes worktree", async () => {
		const project = makeProject();
		const task = makeTask({ status: "in-progress", worktreePath: "/tmp/wt" });
		const updatedTask = makeTask({ status: "completed", worktreePath: null, branchName: null });

		vi.mocked(data.getProject).mockResolvedValue(project);
		vi.mocked(data.getTask).mockResolvedValue(task);
		vi.mocked(data.updateTask).mockResolvedValue(updatedTask);
		vi.mocked(existsSync).mockReturnValue(true);

		const result = await handlers.moveTask({ taskId: "task-1", projectId: "proj-1", newStatus: "completed" });
		expect(result.status).toBe("completed");
		expect(pty.destroySession).toHaveBeenCalledWith("task-1", undefined);
		expect(git.removeWorktree).toHaveBeenCalledWith(project, task);
	});

	it("in-progress → completed: pushes a transient shuttingDown snapshot before teardown, never persisting it", async () => {
		const project = makeProject();
		const task = makeTask({ status: "in-progress", worktreePath: "/tmp/wt" });
		const updatedTask = makeTask({ status: "completed", worktreePath: null, branchName: null });
		const push = vi.fn();

		vi.mocked(data.getProject).mockResolvedValue(project);
		vi.mocked(data.getTask).mockResolvedValue(task);
		vi.mocked(data.updateTask).mockResolvedValue(updatedTask);
		vi.mocked(existsSync).mockReturnValue(true);
		setPushMessage(push);

		await handlers.moveTask({ taskId: "task-1", projectId: "proj-1", newStatus: "completed" });

		// A shuttingDown snapshot is pushed to renderers…
		const idx = push.mock.calls.findIndex(
			(call: any[]) => call[0] === "taskUpdated" && call[1]?.task?.shuttingDown === true,
		);
		expect(idx).toBeGreaterThanOrEqual(0);
		// …before the slow teardown (removeWorktree) runs.
		expect(push.mock.invocationCallOrder[idx]).toBeLessThan(
			vi.mocked(git.removeWorktree).mock.invocationCallOrder[0],
		);

		// The transient flag is NEVER written to disk (patch is data.updateTask's 3rd arg).
		for (const call of vi.mocked(data.updateTask).mock.calls) {
			expect(call[2]).not.toHaveProperty("shuttingDown");
		}
	});

	it("in-progress → completed: emits renderer sound after teardown finishes", async () => {
		const project = makeProject();
		const task = makeTask({ status: "in-progress", worktreePath: "/tmp/wt" });
		const updatedTask = makeTask({ status: "completed", worktreePath: null, branchName: null });
		const push = vi.fn();

		vi.mocked(data.getProject).mockResolvedValue(project);
		vi.mocked(data.getTask).mockResolvedValue(task);
		vi.mocked(data.updateTask).mockResolvedValue(updatedTask);
		vi.mocked(existsSync).mockReturnValue(true);
		vi.mocked(loadSettingsSync).mockReturnValue({ playSoundOnTaskComplete: true } as any);
		setPushMessage(push);

		const result = await handlers.moveTask({ taskId: "task-1", projectId: "proj-1", newStatus: "completed" });

		const soundIndex = push.mock.calls.findIndex((call) => call[0] === "taskSound");
		expect(soundIndex).toBeGreaterThanOrEqual(0);
		expect(push.mock.invocationCallOrder[soundIndex]).toBeGreaterThan(
			vi.mocked(git.removeWorktree).mock.invocationCallOrder[0],
		);
		expect(push).toHaveBeenCalledWith("taskSound", { status: "completed", taskId: task.id });
		expect(result.status).toBe("completed");
	});

	it("emitTaskSound: pushes a renderer event when sound setting is enabled", () => {
		const push = vi.fn();
		vi.mocked(loadSettingsSync).mockReturnValue({ playSoundOnTaskComplete: true } as any);
		setPushMessage(push);

		emitTaskSound("completed", "task-1");

		expect(push).toHaveBeenCalledWith("taskSound", { status: "completed", taskId: "task-1" });
	});

	it("emitTaskSound: stays silent when the setting is disabled", () => {
		const push = vi.fn();
		vi.mocked(loadSettingsSync).mockReturnValue({ playSoundOnTaskComplete: false } as any);
		setPushMessage(push);

		emitTaskSound("cancelled", "task-2");

		expect(push).not.toHaveBeenCalledWith("taskSound", expect.anything());
	});

	it("moveTask: skips the taskSound push when the client already played it (remote double-sound fix)", async () => {
		const project = makeProject();
		const task = makeTask({ status: "in-progress", worktreePath: "/tmp/wt" });
		const updatedTask = makeTask({ status: "completed", worktreePath: null, branchName: null });
		const push = vi.fn();

		vi.mocked(data.getProject).mockResolvedValue(project);
		vi.mocked(data.getTask).mockResolvedValue(task);
		vi.mocked(data.updateTask).mockResolvedValue(updatedTask);
		vi.mocked(existsSync).mockReturnValue(true);
		vi.mocked(loadSettingsSync).mockReturnValue({ playSoundOnTaskComplete: true } as any);
		setPushMessage(push);

		const result = await handlers.moveTask({ taskId: "task-1", projectId: "proj-1", newStatus: "completed", clientPlayedSound: true });

		// The UI played the sound locally; the backend must NOT broadcast a second
		// one (which a remote browser on the same machine would also play).
		expect(push).not.toHaveBeenCalledWith("taskSound", expect.anything());
		// The board still syncs via taskUpdated — only the sound push is skipped.
		expect(push).toHaveBeenCalledWith("taskUpdated", expect.objectContaining({ projectId: project.id }));
		expect(result.status).toBe("completed");
	});

	it("in-progress → cancelled: same cleanup as completed", async () => {
		const project = makeProject();
		const task = makeTask({ status: "in-progress" });
		const updatedTask = makeTask({ status: "cancelled", worktreePath: null, branchName: null });

		vi.mocked(data.getProject).mockResolvedValue(project);
		vi.mocked(data.getTask).mockResolvedValue(task);
		vi.mocked(data.updateTask).mockResolvedValue(updatedTask);
		vi.mocked(existsSync).mockReturnValue(true);

		const result = await handlers.moveTask({ taskId: "task-1", projectId: "proj-1", newStatus: "cancelled" });
		expect(result.status).toBe("cancelled");
		expect(pty.destroySession).toHaveBeenCalled();
	});

	it("in-progress → completed: kills dev server session", async () => {
		const project = makeProject();
		const task = makeTask({ status: "in-progress", id: "abcd1234-0000-0000-0000-000000000000" });

		vi.mocked(data.getProject).mockResolvedValue(project);
		vi.mocked(data.getTask).mockResolvedValue(task);
		mockTaskWrites(task);
		vi.mocked(existsSync).mockReturnValue(true);
		mockSpawn.mockReturnValue({ stdout: "", stderr: new Response(""), exited: Promise.resolve(0) });

		await handlers.moveTask({ taskId: task.id, projectId: "proj-1", newStatus: "completed" });
		// killDevServerSession is fire-and-forget; drain microtask queue so it completes
		await new Promise((resolve) => setTimeout(resolve, 0));

		const calls = mockSpawn.mock.calls.map((c) => c[0] as string[]);
		expect(calls.some((a) => a.includes("kill-session") && a.includes("dev3-dev-abcd1234"))).toBe(true);
	});

	it("in-progress → cancelled: kills dev server session", async () => {
		const project = makeProject();
		const task = makeTask({ status: "in-progress", id: "abcd1234-0000-0000-0000-000000000000" });

		vi.mocked(data.getProject).mockResolvedValue(project);
		vi.mocked(data.getTask).mockResolvedValue(task);
		mockTaskWrites(task);
		vi.mocked(existsSync).mockReturnValue(true);
		mockSpawn.mockReturnValue({ stdout: "", stderr: new Response(""), exited: Promise.resolve(0) });

		await handlers.moveTask({ taskId: task.id, projectId: "proj-1", newStatus: "cancelled" });
		// killDevServerSession is fire-and-forget; drain microtask queue so it completes
		await new Promise((resolve) => setTimeout(resolve, 0));

		const calls = mockSpawn.mock.calls.map((c) => c[0] as string[]);
		expect(calls.some((a) => a.includes("kill-session") && a.includes("dev3-dev-abcd1234"))).toBe(true);
	});

	it("force mode: skips PTY/cleanup/worktree destruction", async () => {
		const project = makeProject();
		const task = makeTask({ status: "in-progress" });
		const updatedTask = makeTask({ status: "completed", worktreePath: null, branchName: null });

		vi.mocked(data.getProject).mockResolvedValue(project);
		vi.mocked(data.getTask).mockResolvedValue(task);
		vi.mocked(data.updateTask).mockResolvedValue(updatedTask);

		await handlers.moveTask({ taskId: "task-1", projectId: "proj-1", newStatus: "completed", force: true });
		expect(pty.destroySession).not.toHaveBeenCalled();
		expect(git.removeWorktree).not.toHaveBeenCalled();
	});

	it("active → active: only updates status", async () => {
		const project = makeProject();
		const task = makeTask({ status: "in-progress" });
		const updatedTask = makeTask({ status: "review-by-user" });

		vi.mocked(data.getProject).mockResolvedValue(project);
		vi.mocked(data.getTask).mockResolvedValue(task);
		vi.mocked(data.updateTask).mockResolvedValue(updatedTask);

		const result = await handlers.moveTask({ taskId: "task-1", projectId: "proj-1", newStatus: "review-by-user" });
		expect(result.status).toBe("review-by-user");
		expect(git.createWorktree).not.toHaveBeenCalled();
		expect(pty.destroySession).not.toHaveBeenCalled();
		expect(data.updateTask).toHaveBeenCalledWith(
			project,
			"task-1",
			expect.objectContaining({
				status: "review-by-user",
				customColumnId: null,
				runtimeState: expect.objectContaining({ runtime: "running" }),
			}),
			{ dropPosition: "top" },
		);
	});

	it("should NOT throw when worktree directory is missing (completed)", async () => {
		const project = makeProject({ cleanupScript: "echo cleanup" });
		const task = makeTask({ status: "in-progress", worktreePath: "/tmp/deleted-worktree" });
		vi.mocked(data.getProject).mockResolvedValue(project);
		vi.mocked(data.getTask).mockResolvedValue(task);
		vi.mocked(data.updateTask).mockResolvedValue({ ...task, status: "completed", worktreePath: null, branchName: null });
		vi.mocked(existsSync).mockReturnValue(false);

		const result = await handlers.moveTask({ taskId: "task-1", projectId: "proj-1", newStatus: "completed" });
		expect(result.status).toBe("completed");
		expect(result.worktreePath).toBeNull();
	});

	it("should tolerate removeWorktree failure when branch is already deleted", async () => {
		const project = makeProject({ cleanupScript: "" });
		const task = makeTask({ status: "in-progress", worktreePath: "/tmp/existing-worktree" });
		vi.mocked(data.getProject).mockResolvedValue(project);
		vi.mocked(data.getTask).mockResolvedValue(task);
		vi.mocked(data.updateTask).mockResolvedValue({ ...task, status: "completed", worktreePath: null, branchName: null });
		vi.mocked(existsSync).mockReturnValue(true);
		vi.mocked(git.removeWorktree).mockRejectedValue(new Error("branch not found"));

		const result = await handlers.moveTask({ taskId: "task-1", projectId: "proj-1", newStatus: "completed" });
		expect(result.status).toBe("completed");
		expect(data.updateTask).toHaveBeenCalled();
	});

	it("should not throw when worktreePath is null and moving to completed", async () => {
		const project = makeProject({ cleanupScript: "echo cleanup" });
		const task = makeTask({ status: "in-progress", worktreePath: null });
		vi.mocked(data.getProject).mockResolvedValue(project);
		vi.mocked(data.getTask).mockResolvedValue(task);
		vi.mocked(data.updateTask).mockResolvedValue({ ...task, status: "completed", worktreePath: null, branchName: null });

		const result = await handlers.moveTask({ taskId: "task-1", projectId: "proj-1", newStatus: "completed" });
		expect(result.status).toBe("completed");
	});

	it("tolerates destroySession failure", async () => {
		const project = makeProject();
		const task = makeTask({ status: "in-progress" });
		const updatedTask = makeTask({ status: "completed", worktreePath: null, branchName: null });

		vi.mocked(data.getProject).mockResolvedValue(project);
		vi.mocked(data.getTask).mockResolvedValue(task);
		vi.mocked(data.updateTask).mockResolvedValue(updatedTask);
		vi.mocked(pty.destroySession).mockImplementation(() => { throw new Error("session not found"); });
		vi.mocked(existsSync).mockReturnValue(true);

		const result = await handlers.moveTask({ taskId: "task-1", projectId: "proj-1", newStatus: "completed" });
		expect(result.status).toBe("completed");
	});

	it("todo → completed (with worktree): cleans up PTY and worktree", async () => {
		const project = makeProject();
		const task = makeTask({ status: "todo", worktreePath: "/tmp/wt" });
		const updatedTask = makeTask({ status: "completed", worktreePath: null, branchName: null });

		vi.mocked(data.getProject).mockResolvedValue(project);
		vi.mocked(data.getTask).mockResolvedValue(task);
		vi.mocked(data.updateTask).mockResolvedValue(updatedTask);
		vi.mocked(existsSync).mockReturnValue(true);

		const result = await handlers.moveTask({ taskId: "task-1", projectId: "proj-1", newStatus: "completed" });
		expect(result.status).toBe("completed");
		expect(pty.destroySession).toHaveBeenCalledWith("task-1", undefined);
		expect(git.removeWorktree).toHaveBeenCalledWith(project, task);
		expect(data.updateTask).toHaveBeenCalledWith(project, "task-1", expect.objectContaining({
			status: "completed",
			worktreePath: null,
			branchName: null,
			customColumnId: null,
			runtimeState: expect.objectContaining({ runtime: "idle" }),
		}), { dropPosition: "top" });
	});

	it("todo → completed (without worktree): just updates status", async () => {
		const project = makeProject();
		const task = makeTask({ status: "todo", worktreePath: null });
		const updatedTask = makeTask({ status: "completed", worktreePath: null, branchName: null });

		vi.mocked(data.getProject).mockResolvedValue(project);
		vi.mocked(data.getTask).mockResolvedValue(task);
		vi.mocked(data.updateTask).mockResolvedValue(updatedTask);

		const result = await handlers.moveTask({ taskId: "task-1", projectId: "proj-1", newStatus: "completed" });
		expect(result.status).toBe("completed");
		expect(pty.destroySession).not.toHaveBeenCalled();
		expect(git.removeWorktree).not.toHaveBeenCalled();
	});
});

// ================================================================
// handlers.deleteTask
// ================================================================

describe("handlers.deleteTask", () => {
	beforeEach(() => vi.clearAllMocks());

	it("deletes a todo task: always calls destroySession (best-effort), skips removeWorktree", async () => {
		const project = makeProject();
		const task = makeTask({ status: "todo", worktreePath: null });
		vi.mocked(data.getProject).mockResolvedValue(project);
		vi.mocked(data.getTask).mockResolvedValue(task);
		vi.mocked(pty.destroySession).mockImplementation(() => {});

		await handlers.deleteTask({ taskId: "task-1", projectId: "proj-1" });
		expect(data.deleteTask).toHaveBeenCalledWith(project, "task-1");
		expect(pty.destroySession).toHaveBeenCalledWith("task-1", undefined);
		expect(git.removeWorktree).not.toHaveBeenCalled();
	});

	it("deleteTask: tolerates destroySession failure for non-active task", async () => {
		const project = makeProject();
		const task = makeTask({ status: "completed", worktreePath: null });
		vi.mocked(data.getProject).mockResolvedValue(project);
		vi.mocked(data.getTask).mockResolvedValue(task);
		vi.mocked(pty.destroySession).mockImplementation(() => { throw new Error("session not found"); });

		await handlers.deleteTask({ taskId: "task-1", projectId: "proj-1" });
		expect(data.deleteTask).toHaveBeenCalledWith(project, "task-1");
		expect(git.removeWorktree).not.toHaveBeenCalled();
	});

	it("cleans up PTY and worktree for active task", async () => {
		const project = makeProject();
		const task = makeTask({ status: "in-progress" });
		vi.mocked(data.getProject).mockResolvedValue(project);
		vi.mocked(data.getTask).mockResolvedValue(task);
		vi.mocked(pty.destroySession).mockImplementation(() => {});
		vi.mocked(git.removeWorktree).mockResolvedValue(undefined);

		await handlers.deleteTask({ taskId: "task-1", projectId: "proj-1" });
		expect(pty.destroySession).toHaveBeenCalledWith("task-1", undefined);
		expect(git.removeWorktree).toHaveBeenCalledWith(project, task);
		expect(data.deleteTask).toHaveBeenCalledWith(project, "task-1");
	});

	it("runs the cleanup script (status 'deleted') before removing the worktree", async () => {
		// Deleting an active task destroys its worktree just like completing it —
		// the teardown hook must fire here too, or per-worktree resources (e.g.
		// dev containers brought up by the setup hook) leak.
		const project = makeProject({ cleanupScript: "echo cleanup" });
		const task = makeTask({ status: "in-progress" });
		vi.mocked(data.getProject).mockResolvedValue(project);
		vi.mocked(data.getTask).mockResolvedValue(task);
		vi.mocked(pty.destroySession).mockImplementation(() => {});
		vi.mocked(existsSync).mockReturnValue(true);

		const callOrder: string[] = [];
		mockSpawn.mockImplementation((args: string[]) => {
			if (Array.isArray(args) && args.includes("new-session")) callOrder.push("cleanup");
			return { stdout: new Response(""), stderr: new Response(""), exited: Promise.resolve(0) };
		});
		vi.mocked(git.removeWorktree).mockImplementation(async () => {
			callOrder.push("removeWorktree");
		});

		await handlers.deleteTask({ taskId: "task-1", projectId: "proj-1" });

		const cleanupCall = mockSpawn.mock.calls.find(
			([args]) => Array.isArray(args) && args.includes("DEV3_TASK_STATUS=deleted"),
		);
		expect(cleanupCall).toBeDefined();
		expect(callOrder.indexOf("cleanup")).toBeGreaterThanOrEqual(0);
		expect(callOrder.indexOf("cleanup")).toBeLessThan(callOrder.indexOf("removeWorktree"));
		expect(data.deleteTask).toHaveBeenCalledWith(project, "task-1");
	});

	it("tolerates cleanup script failure: still removes worktree and task", async () => {
		const project = makeProject({ cleanupScript: "echo cleanup" });
		const task = makeTask({ status: "in-progress" });
		vi.mocked(data.getProject).mockResolvedValue(project);
		vi.mocked(data.getTask).mockResolvedValue(task);
		vi.mocked(pty.destroySession).mockImplementation(() => {});
		vi.mocked(git.removeWorktree).mockResolvedValue(undefined);
		vi.mocked(existsSync).mockReturnValue(true);
		mockSpawn.mockImplementation(() => {
			throw new Error("tmux unavailable");
		});

		await handlers.deleteTask({ taskId: "task-1", projectId: "proj-1" });

		expect(git.removeWorktree).toHaveBeenCalledWith(project, task);
		expect(data.deleteTask).toHaveBeenCalledWith(project, "task-1");
	});

	it("releases allocated ports on delete", async () => {
		const project = makeProject();
		const task = makeTask({ status: "todo", worktreePath: null });
		vi.mocked(data.getProject).mockResolvedValue(project);
		vi.mocked(data.getTask).mockResolvedValue(task);
		vi.mocked(pty.destroySession).mockImplementation(() => {});
		const portPool = await import("../port-pool");
		const releaseSpy = vi.spyOn(portPool, "releasePorts");

		await handlers.deleteTask({ taskId: "task-1", projectId: "proj-1" });

		expect(releaseSpy).toHaveBeenCalledWith("task-1");
	});
});

// ================================================================
// Virtual ("Operations") task lifecycle
// ================================================================

describe("virtual task lifecycle", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.mocked(loadSettings).mockResolvedValue({ updateChannel: "stable", taskDropPosition: "top" } as any);
		// has-session probe → 0 (exists) so launchTaskPty treats the session as
		// pre-existing and skips the split-shell loop (keeps the test fast).
		mockSpawn.mockReturnValue({ exited: Promise.resolve(0) });
	});

	const vproject = (overrides?: Partial<Project>) =>
		makeProject({ id: "vp1", kind: "virtual", path: "/tmp/test-dev3/ops/operations", ...overrides });

	it("todo → in-progress: NO git worktree, creates managed work dir + PTY", async () => {
		const project = vproject();
		const task = makeTask({ projectId: "vp1", status: "todo", worktreePath: null });
		vi.mocked(data.getProject).mockResolvedValue(project);
		vi.mocked(data.getTask).mockResolvedValue(task);
		mockTaskWrites(task);

		const result = await handlers.moveTask({ taskId: "task-1", projectId: "vp1", newStatus: "in-progress" });

		expect(git.createWorktree).not.toHaveBeenCalled();
		expect(mkdir).toHaveBeenCalledWith("/tmp/test-dev3/ops/operations/task-1/work", { recursive: true });
		expect(pty.createSession).toHaveBeenCalledWith("task-1", "vp1", "/tmp/test-dev3/ops/operations/task-1/work", expect.anything(), expect.anything(), expect.anything());
		expect(result.worktreePath).toBe("/tmp/test-dev3/ops/operations/task-1/work");
		expect(result.branchName).toBeNull();
	});

	it("uses a chosen fixed folder (opsWorkDir) instead of a managed dir", async () => {
		const project = vproject();
		const task = makeTask({ projectId: "vp1", status: "todo", worktreePath: null, opsWorkDir: "/Users/me/Downloads" });
		vi.mocked(data.getProject).mockResolvedValue(project);
		vi.mocked(data.getTask).mockResolvedValue(task);
		mockTaskWrites(task);

		const result = await handlers.moveTask({ taskId: "task-1", projectId: "vp1", newStatus: "in-progress" });

		expect(pty.createSession).toHaveBeenCalledWith("task-1", "vp1", "/Users/me/Downloads", expect.anything(), expect.anything(), expect.anything());
		expect(result.worktreePath).toBe("/Users/me/Downloads");
	});

	it("in-progress → completed: keeps work dir (no removeWorktree, worktreePath preserved)", async () => {
		const project = vproject();
		const task = makeTask({ projectId: "vp1", status: "in-progress", worktreePath: "/tmp/test-dev3/ops/operations/task-1/work" });
		vi.mocked(data.getProject).mockResolvedValue(project);
		vi.mocked(data.getTask).mockResolvedValue(task);
		vi.mocked(pty.destroySession).mockImplementation(() => {});
		mockTaskWrites(task);

		await handlers.moveTask({ taskId: "task-1", projectId: "vp1", newStatus: "completed" });

		expect(git.removeWorktree).not.toHaveBeenCalled();
		const updateArgs = vi.mocked(data.updateTask).mock.calls.find((call) => call[2].status === "completed")?.[2] as Record<string, unknown>;
		expect(updateArgs.status).toBe("completed");
		expect("worktreePath" in updateArgs).toBe(false);
	});

	it("delete: removes a MANAGED work dir under ops/", async () => {
		const project = vproject();
		const task = makeTask({ projectId: "vp1", status: "completed", worktreePath: "/tmp/test-dev3/ops/operations/task-1/work" });
		vi.mocked(data.getProject).mockResolvedValue(project);
		vi.mocked(data.getTask).mockResolvedValue(task);
		vi.mocked(pty.destroySession).mockImplementation(() => {});

		await handlers.deleteTask({ taskId: "task-1", projectId: "vp1" });

		expect(git.removeWorktree).not.toHaveBeenCalled();
		expect(rm).toHaveBeenCalledWith("/tmp/test-dev3/ops/operations/task-1/work", { recursive: true, force: true });
		expect(data.deleteTask).toHaveBeenCalledWith(project, "task-1");
	});

	it("delete: NEVER removes a fixed folder outside ops/", async () => {
		const project = vproject();
		const task = makeTask({ projectId: "vp1", status: "completed", worktreePath: "/Users/me/Downloads", opsWorkDir: "/Users/me/Downloads" });
		vi.mocked(data.getProject).mockResolvedValue(project);
		vi.mocked(data.getTask).mockResolvedValue(task);
		vi.mocked(pty.destroySession).mockImplementation(() => {});

		await handlers.deleteTask({ taskId: "task-1", projectId: "vp1" });

		expect(rm).not.toHaveBeenCalled();
		expect(git.removeWorktree).not.toHaveBeenCalled();
		expect(data.deleteTask).toHaveBeenCalledWith(project, "task-1");
	});
});

describe("git-operations guards — virtual (Operations) tasks", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	const vproject = (overrides?: Partial<Project>) =>
		makeProject({ id: "vp1", kind: "virtual", path: "/tmp/test-dev3/ops/operations", ...overrides });
	const vtask = () => makeTask({ projectId: "vp1", worktreePath: "/tmp/test-dev3/ops/operations/task-1/work" });

	it("getBranchStatus returns an inert status without spawning git for a virtual task", async () => {
		vi.mocked(data.getProject).mockResolvedValue(vproject());
		vi.mocked(data.getTask).mockResolvedValue(vtask());

		const status = await handlers.getBranchStatus({ taskId: "task-1", projectId: "vp1" });

		expect(status.ahead).toBe(0);
		expect(status.behind).toBe(0);
		expect(status.canRebase).toBe(false);
		// The 15s renderer poll must not fire a doomed git in a non-repo dir.
		expect(git.getCurrentBranch).not.toHaveBeenCalled();
		expect(git.fetchOrigin).not.toHaveBeenCalled();
	});

	it("getTaskDiff throws a clear error (and skips git) for a virtual task", async () => {
		vi.mocked(data.getProject).mockResolvedValue(vproject());
		vi.mocked(data.getTask).mockResolvedValue(vtask());

		await expect(
			handlers.getTaskDiff({ taskId: "task-1", projectId: "vp1", mode: "uncommitted" }),
		).rejects.toThrow(/not available for Operations/i);
		expect(git.getTaskDiff).not.toHaveBeenCalled();
	});

	it("pushTask throws a clear error for a virtual task", async () => {
		vi.mocked(data.getProject).mockResolvedValue(vproject());
		vi.mocked(data.getTask).mockResolvedValue(vtask());

		await expect(handlers.pushTask({ taskId: "task-1", projectId: "vp1" })).rejects.toThrow(
			/not available for Operations/i,
		);
	});
});

// ================================================================
// handlers.editTask
// ================================================================

describe("handlers.editTask", () => {
	beforeEach(() => vi.clearAllMocks());

	it("edits description and title of a todo task", async () => {
		const project = makeProject();
		const task = makeTask({ status: "todo" });
		const updated = makeTask({ status: "todo", description: "New desc", title: "New desc" });
		vi.mocked(data.getProject).mockResolvedValue(project);
		vi.mocked(data.getTask).mockResolvedValue(task);
		vi.mocked(data.updateTask).mockResolvedValue(updated);

		const result = await handlers.editTask({ taskId: "task-1", projectId: "proj-1", description: "New desc" });
		expect(result).toEqual(updated);
		expect(data.updateTask).toHaveBeenCalledWith(project, "task-1", expect.objectContaining({
			description: "New desc",
		}));
	});

	it("converts a scratch task into a normal task when its description is edited", async () => {
		const project = makeProject();
		const task = makeTask({ status: "todo", scratch: true, description: "Scratch — 15:50" });
		const updated = makeTask({ status: "todo", scratch: false, description: "Plan HTML artifacts" });
		vi.mocked(data.getProject).mockResolvedValue(project);
		vi.mocked(data.getTask).mockResolvedValue(task);
		vi.mocked(data.updateTask).mockResolvedValue(updated);

		await handlers.editTask({
			taskId: "task-1",
			projectId: "proj-1",
			description: "Plan HTML artifacts",
		});

		expect(data.updateTask).toHaveBeenCalledWith(project, "task-1", expect.objectContaining({
			description: "Plan HTML artifacts",
			scratch: false,
		}));
	});

	it("throws when task is not in todo status", async () => {
		const project = makeProject();
		const task = makeTask({ status: "in-progress" });
		vi.mocked(data.getProject).mockResolvedValue(project);
		vi.mocked(data.getTask).mockResolvedValue(task);

		await expect(
			handlers.editTask({ taskId: "task-1", projectId: "proj-1", description: "Edit" }),
		).rejects.toThrow("Can only edit tasks in todo status");
	});
});

// ================================================================
// handlers.renameTask
// ================================================================

describe("handlers.renameTask", () => {
	beforeEach(() => vi.clearAllMocks());

	// Re-opened #583 — the renameTask RPC is the ONLY entry point that should
	// mark a title as user-edited, because it is invoked only from the UI
	// (CreateTaskModal + InlineRename). The CLI `task.update` path must not
	// touch the flag, so later agents can still rename agent-set titles.
	it("sets titleEditedByUser=true when the UI writes a non-empty custom title", async () => {
		const project = makeProject();
		const task = makeTask();
		const updated = makeTask({ customTitle: "User picked this", titleEditedByUser: true });
		vi.mocked(data.getProject).mockResolvedValue(project);
		vi.mocked(data.getTask).mockResolvedValue(task);
		vi.mocked(data.updateTask).mockResolvedValue(updated);

		const result = await handlers.renameTask({
			taskId: "task-1",
			projectId: "proj-1",
			customTitle: "User picked this",
		});
		expect(result).toEqual(updated);
		expect(data.updateTask).toHaveBeenCalledWith(project, "task-1", {
			customTitle: "User picked this",
			titleEditedByUser: true,
		});
	});

	it("clears titleEditedByUser when the UI resets the custom title to null", async () => {
		const project = makeProject();
		const task = makeTask({ customTitle: "Old", titleEditedByUser: true });
		const updated = makeTask({ customTitle: null, titleEditedByUser: false });
		vi.mocked(data.getProject).mockResolvedValue(project);
		vi.mocked(data.getTask).mockResolvedValue(task);
		vi.mocked(data.updateTask).mockResolvedValue(updated);

		await handlers.renameTask({ taskId: "task-1", projectId: "proj-1", customTitle: null });
		expect(data.updateTask).toHaveBeenCalledWith(project, "task-1", {
			customTitle: null,
			titleEditedByUser: false,
		});
	});

	it("clears scratch when the UI assigns a real title", async () => {
		const project = makeProject();
		const task = makeTask({ scratch: true, description: "Scratch — 15:50" });
		const updated = makeTask({
			scratch: false,
			customTitle: "Plan HTML artifacts",
			titleEditedByUser: true,
		});
		vi.mocked(data.getProject).mockResolvedValue(project);
		vi.mocked(data.getTask).mockResolvedValue(task);
		vi.mocked(data.updateTask).mockResolvedValue(updated);

		await handlers.renameTask({
			taskId: "task-1",
			projectId: "proj-1",
			customTitle: "Plan HTML artifacts",
		});

		expect(data.updateTask).toHaveBeenCalledWith(project, "task-1", {
			customTitle: "Plan HTML artifacts",
			titleEditedByUser: true,
			scratch: false,
		});
	});

	it("treats whitespace-only customTitle as a reset", async () => {
		const project = makeProject();
		const task = makeTask({ customTitle: "Old", titleEditedByUser: true });
		vi.mocked(data.getProject).mockResolvedValue(project);
		vi.mocked(data.getTask).mockResolvedValue(task);
		vi.mocked(data.updateTask).mockResolvedValue(task);

		await handlers.renameTask({ taskId: "task-1", projectId: "proj-1", customTitle: "   " });
		expect(data.updateTask).toHaveBeenCalledWith(project, "task-1", {
			customTitle: null,
			titleEditedByUser: false,
		});
	});
});

describe("activateTask", () => {
	beforeEach(() => vi.clearAllMocks());

	it("applies sparse checkout and CoW clones using the worktree-resolved config", async () => {
		const project = makeProject({
			setupScript: "project setup",
			clonePaths: ["project-cache"],
		} as any);
		const preResolved = {
			...project,
			setupScript: "project setup",
			clonePaths: ["project-cache"],
		} as Project;
		const worktreeResolved = {
			...project,
			sparseCheckoutEnabled: true,
			sparseCheckoutPaths: ["src", "tests"],
			clonePaths: ["branch-cache"],
			setupScript: "branch setup",
		} as Project;
		const task = makeTask({ worktreePath: null, branchName: null });

		vi.mocked(repoConfig.resolveProjectConfig)
			.mockResolvedValueOnce(preResolved)
			.mockResolvedValueOnce(preResolved)
			.mockResolvedValueOnce(worktreeResolved);
		vi.mocked(git.createWorktree).mockResolvedValue({ worktreePath: "/tmp/wt", branchName: "dev3/task-1" });

		const result = await activateTask(project, task);

		expect(result).toEqual({ worktreePath: "/tmp/wt", branchName: "dev3/task-1" });
		expect(git.createWorktree).toHaveBeenCalledWith(preResolved, task, undefined);
		expect(git.applySparseCheckout).toHaveBeenCalledWith("/tmp/wt", ["src", "tests"]);
		expect(cowClone.clonePaths).toHaveBeenCalledWith(project.path, "/tmp/wt", ["branch-cache"]);
		expect(pty.createSession).toHaveBeenCalledOnce();
	});

	it("clears description for reopened tasks before launching the agent", async () => {
		const project = makeProject();
		const task = makeTask({
			status: "completed",
			description: "old task context that should not be resent",
			worktreePath: null,
			branchName: null,
		});

		vi.mocked(git.createWorktree).mockResolvedValue({ worktreePath: "/tmp/wt", branchName: "dev3/task-1" });

		await activateTask(project, task, { isReopen: true });

		expect(agents.resolveCommandForProject).toHaveBeenCalledWith(
			expect.objectContaining({ id: project.id, path: project.path }),
			task.title,
			"",
			"/tmp/wt",
			undefined,
			{ resume: true },
		);
	});

	it("clears the placeholder description for scratch tasks on direct launch", async () => {
		const project = makeProject();
		const task = makeTask({
			status: "todo",
			scratch: true,
			description: "Scratch — 14:52",
			worktreePath: null,
			branchName: null,
		});

		vi.mocked(git.createWorktree).mockResolvedValue({ worktreePath: "/tmp/wt", branchName: "dev3/task-1" });

		await activateTask(project, task);

		expect(agents.resolveCommandForProject).toHaveBeenCalledWith(
			expect.objectContaining({ id: project.id, path: project.path }),
			task.title,
			"",
			"/tmp/wt",
			undefined,
			expect.anything(),
		);
	});

	it("does not launch a cleared scratch placeholder as a prompt", async () => {
		const project = makeProject();
		const task = makeTask({
			status: "todo",
			scratch: false,
			description: "Scratch — 14:52",
			worktreePath: null,
			branchName: null,
		});

		vi.mocked(git.createWorktree).mockResolvedValue({ worktreePath: "/tmp/wt", branchName: "dev3/task-1" });

		await activateTask(project, task);

		expect(agents.resolveCommandForProject).toHaveBeenCalledWith(
			expect.objectContaining({ id: project.id, path: project.path }),
			task.title,
			"",
			"/tmp/wt",
			undefined,
			expect.anything(),
		);
	});

	it("preserves the stored agentId when reviving a completed task", async () => {
		const project = makeProject();
		const task = makeTask({
			status: "completed",
			description: "original description",
			worktreePath: null,
			branchName: null,
			agentId: "builtin-claude",
			configId: null,
		});

		vi.mocked(git.createWorktree).mockResolvedValue({ worktreePath: "/tmp/wt", branchName: "dev3/task-1" });

		await activateTask(project, task, { isReopen: true });

		expect(agents.resolveCommandForAgent).toHaveBeenCalledWith(
			"builtin-claude",
			null,
			expect.objectContaining({ worktreePath: "/tmp/wt" }),
			{ resume: true },
		);
		expect(agents.resolveCommandForProject).not.toHaveBeenCalled();
	});

});

// ================================================================
// handlers.spawnVariants
// ================================================================

describe("handlers.spawnVariants", () => {
	beforeEach(() => vi.clearAllMocks());

	// Variant #1 transforms the source task in place via data.updateTaskWith —
	// this helper mocks that transform faithfully: it runs the real mutator
	// against the given source snapshot and returns the merged task, so tests
	// can assert on the updates the handler actually produced.
	function mockTransformSource(sourceTask: Task) {
		vi.mocked(data.updateTaskWith).mockImplementation(async (_project, taskId, mutator) => {
			if (taskId !== sourceTask.id) throw new Error(`Task not found: ${taskId}`);
			const { updates, result } = await mutator({ ...sourceTask });
			return { task: { ...sourceTask, ...updates } as Task, result };
		});
	}

	// Regression — "task create prints an id that stops resolving": launching a
	// todo task used to DELETE the source and recreate every variant under a
	// fresh UUID, so the id printed by `dev3 task create` (and any stored
	// reference to it) dangled as soon as the user launched the task. Variant #1
	// must keep the source task's id; only variants 2..N are new tasks.
	it("keeps the source task id when launching a single variant", async () => {
		const project = makeProject();
		const sourceTask = makeTask({ status: "todo", seq: 5, worktreePath: null, branchName: null });

		vi.mocked(data.getProject).mockResolvedValue(project);
		vi.mocked(data.getTask).mockResolvedValue(sourceTask);
		mockTransformSource(sourceTask);
		vi.mocked(git.createWorktree).mockResolvedValue({ worktreePath: "/tmp/vwt", branchName: "dev3/task-task-1" });
		vi.mocked(data.updateTask).mockResolvedValue(makeTask({ status: "in-progress", worktreePath: "/tmp/vwt" }));

		const result = await handlers.spawnVariants({
			taskId: "task-1",
			projectId: "proj-1",
			targetStatus: "in-progress",
			variants: [{ agentId: "agent-1", configId: null }],
		});

		expect(result).toHaveLength(1);
		expect(result[0].id).toBe("task-1");
		expect(result[0].status).toBe("in-progress");
		expect(result[0].groupId).toBeTruthy();
		expect(result[0].variantIndex).toBe(1);
		expect(result[0].agentId).toBe("agent-1");
		expect(data.deleteTask).not.toHaveBeenCalled();
		expect(data.addTask).not.toHaveBeenCalled();
	});

	it("keeps the source task id as variant #1 and creates only variants 2..N when launching multiple variants", async () => {
		const project = makeProject();
		const sourceTask = makeTask({ status: "todo", seq: 5, worktreePath: null, branchName: null });
		const secondVariant = makeTask({ id: "variant-2", status: "in-progress", preparing: true });

		vi.mocked(data.getProject).mockResolvedValue(project);
		vi.mocked(data.getTask).mockResolvedValue(sourceTask);
		mockTransformSource(sourceTask);
		vi.mocked(data.addTask).mockResolvedValue(secondVariant);
		vi.mocked(git.createWorktree).mockResolvedValue({ worktreePath: "/tmp/vwt", branchName: "dev3/v" });
		mockTaskWrites(sourceTask, secondVariant);

		const result = await handlers.spawnVariants({
			taskId: "task-1",
			projectId: "proj-1",
			targetStatus: "in-progress",
			variants: [
				{ agentId: "agent-1", configId: null },
				{ agentId: "agent-2", configId: null },
			],
		});

		expect(result).toHaveLength(2);
		expect(result[0].id).toBe("task-1");
		expect(result[1].id).toBe("variant-2");
		expect(data.addTask).toHaveBeenCalledOnce();
		expect(vi.mocked(data.addTask).mock.calls[0][3]).toEqual(
			expect.objectContaining({ variantIndex: 2, agentId: "agent-2" }),
		);
		expect(data.deleteTask).not.toHaveBeenCalled();
	});

	// The in-place transform re-checks the status under the file lock: a
	// concurrent launch that already transformed the source must make the
	// second call fail instead of silently double-launching.
	it("throws when the source leaves todo between the snapshot read and the locked transform", async () => {
		const project = makeProject();
		const sourceTask = makeTask({ status: "todo", seq: 5 });

		vi.mocked(data.getProject).mockResolvedValue(project);
		vi.mocked(data.getTask)
			.mockResolvedValueOnce(sourceTask)
			.mockResolvedValueOnce({ ...sourceTask, status: "in-progress" });

		await expect(
			handlers.spawnVariants({
				taskId: "task-1",
				projectId: "proj-1",
				targetStatus: "in-progress",
				variants: [{ agentId: "agent-1", configId: null }],
			}),
		).rejects.toThrow("Task must be in todo status");
		expect(data.addTask).not.toHaveBeenCalled();
	});

	// A pending "Start in…" schedule must not survive the launch on the
	// transformed task — the scheduler would otherwise re-fire it.
	it("clears scheduledLaunch on the transformed source task", async () => {
		const project = makeProject();
		const sourceTask = makeTask({
			status: "todo",
			seq: 5,
			scheduledLaunch: { at: "2099-01-01T00:00:00.000Z", targetStatus: "in-progress", variants: [{ agentId: "agent-1", configId: null }] },
		});

		vi.mocked(data.getProject).mockResolvedValue(project);
		vi.mocked(data.getTask).mockResolvedValue(sourceTask);
		mockTransformSource(sourceTask);
		vi.mocked(git.createWorktree).mockResolvedValue({ worktreePath: "/tmp/vwt", branchName: "dev3/v" });
		vi.mocked(data.updateTask).mockResolvedValue(makeTask({ status: "in-progress", worktreePath: "/tmp/vwt" }));

		const result = await handlers.spawnVariants({
			taskId: "task-1",
			projectId: "proj-1",
			targetStatus: "in-progress",
			variants: [{ agentId: "agent-1", configId: null }],
		});

		expect(result[0].scheduledLaunch).toBeNull();
	});

	it("throws when source task is not in todo", async () => {
		const project = makeProject();
		const task = makeTask({ status: "in-progress" });
		vi.mocked(data.getProject).mockResolvedValue(project);
		vi.mocked(data.getTask).mockResolvedValue(task);

		await expect(
			handlers.spawnVariants({
				taskId: "task-1",
				projectId: "proj-1",
				targetStatus: "in-progress",
				variants: [{ agentId: null, configId: null }],
			}),
		).rejects.toThrow("Task must be in todo status");
	});

	it("spawns variants with inactive target (no worktree)", async () => {
		const project = makeProject();
		const sourceTask = makeTask({ status: "todo", seq: 5 });

		vi.mocked(data.getProject).mockResolvedValue(project);
		vi.mocked(data.getTask).mockResolvedValue(sourceTask);
		mockTransformSource(sourceTask);

		const result = await handlers.spawnVariants({
			taskId: "task-1",
			projectId: "proj-1",
			targetStatus: "todo",
			variants: [{ agentId: "agent-1", configId: null }],
		});

		expect(result).toHaveLength(1);
		expect(result[0].id).toBe("task-1");
		expect(result[0].preparing).toBeFalsy();
		expect(data.addTask).not.toHaveBeenCalled();
		expect(data.deleteTask).not.toHaveBeenCalled();
		expect(git.createWorktree).not.toHaveBeenCalled();
	});

	it("spawns variants into active status with worktree + PTY", async () => {
		const project = makeProject();
		const sourceTask = makeTask({ status: "todo", seq: 5 });
		const variantTask = makeTask({ id: "variant-2", status: "todo" });

		vi.mocked(data.getProject).mockResolvedValue(project);
		vi.mocked(data.getTask).mockResolvedValue(sourceTask);
		mockTransformSource(sourceTask);
		vi.mocked(data.addTask).mockResolvedValue(variantTask);
		vi.mocked(git.createWorktree).mockResolvedValue({ worktreePath: "/tmp/vwt", branchName: "dev3/v1" });
		mockTaskWrites(sourceTask, variantTask);

		const result = await handlers.spawnVariants({
			taskId: "task-1",
			projectId: "proj-1",
			targetStatus: "in-progress",
			variants: [
				{ agentId: "agent-1", configId: null },
				{ agentId: "agent-2", configId: "conf-1" },
			],
		});

		// Phase 1: returns tasks immediately with preparing flag — the source
		// transformed in place as variant #1, plus one new task for variant #2.
		expect(result).toHaveLength(2);
		expect(result[0].id).toBe("task-1");
		expect(data.addTask).toHaveBeenCalledTimes(1);
		expect(result[0].preparing).toBe(true);
		expect(result[0].preparingStage).toBe("resolving-config");
		expect(result[0].preparingProgress).toBe(getPreparingStageProgress("resolving-config"));

		// Phase 2: background worktree creation runs asynchronously
		await vi.waitFor(() => {
			expect(git.createWorktree).toHaveBeenCalledTimes(2);
		});
	});

	it("uses resolved project config for automatic AI review when launching active variants", async () => {
		const project = makeProject({ autoReviewEnabled: false });
		const resolvedProject = makeProject({ autoReviewEnabled: true });
		const sourceTask = makeTask({ status: "todo", seq: 5 });
		const updatedVariant = makeTask({ status: "in-progress", worktreePath: "/tmp/vwt" });

		vi.mocked(data.getProject).mockResolvedValue(project);
		vi.mocked(data.getTask).mockResolvedValue(sourceTask);
		mockTransformSource(sourceTask);
		vi.mocked(git.createWorktree).mockResolvedValue({ worktreePath: "/tmp/vwt", branchName: "dev3/v1" });
		vi.mocked(data.updateTask).mockResolvedValue(updatedVariant);
		vi.mocked(repoConfig.resolveProjectConfig).mockResolvedValueOnce(resolvedProject);

		await handlers.spawnVariants({
			taskId: "task-1",
			projectId: "proj-1",
			targetStatus: "in-progress",
			variants: [{ agentId: "agent-1", configId: null }],
		});

		await vi.waitFor(() => {
			expect(setupAgentHooks).toHaveBeenCalledWith("/tmp/vwt", expect.any(String), { stopTarget: "review-by-ai" });
		});
	});

	it("inherits existingBranch from source task into single variant", async () => {
		const project = makeProject();
		const sourceTask = makeTask({ status: "todo", seq: 5, existingBranch: "feature/login" });
		const updatedVariant = makeTask({ status: "in-progress", worktreePath: "/tmp/vwt", branchName: "feature/login" });

		vi.mocked(data.getProject).mockResolvedValue(project);
		vi.mocked(data.getTask).mockResolvedValue(sourceTask);
		mockTransformSource(sourceTask);
		vi.mocked(git.createWorktree).mockResolvedValue({ worktreePath: "/tmp/vwt", branchName: "feature/login" });
		vi.mocked(data.updateTask).mockResolvedValue(updatedVariant);

		const result = await handlers.spawnVariants({
			taskId: "task-1",
			projectId: "proj-1",
			targetStatus: "in-progress",
			variants: [{ agentId: null, configId: null }],
		});

		expect(result[0]).toEqual(expect.objectContaining({
			id: "task-1",
			existingBranch: "feature/login",
			preparing: true,
			preparingStage: "resolving-config",
			preparingProgress: getPreparingStageProgress("resolving-config"),
		}));
		// Background: single variant uses existing branch directly, no variantBranchName
		await vi.waitFor(() => {
			expect(git.createWorktree).toHaveBeenCalledWith(
				project,
				expect.objectContaining({
					id: "task-1",
					existingBranch: "feature/login",
					preparingStage: "resolving-config",
					preparingProgress: getPreparingStageProgress("resolving-config"),
				}),
				"feature/login",
				undefined,
			);
		});
	});

	it("creates per-variant branches when spawning multiple variants with existingBranch", async () => {
		const project = makeProject();
		const sourceTask = makeTask({ status: "todo", seq: 5, existingBranch: "feature/login" });
		const variantTask = makeTask({ id: "variant-2", status: "todo", existingBranch: "feature/login" });

		vi.mocked(data.getProject).mockResolvedValue(project);
		vi.mocked(data.getTask).mockResolvedValue(sourceTask);
		mockTransformSource(sourceTask);
		vi.mocked(data.addTask).mockResolvedValue(variantTask);
		vi.mocked(git.createWorktree).mockResolvedValue({ worktreePath: "/tmp/vwt", branchName: "feature/login-v1" });
		mockTaskWrites(sourceTask, variantTask);

		const result = await handlers.spawnVariants({
			taskId: "task-1",
			projectId: "proj-1",
			targetStatus: "in-progress",
			variants: [
				{ agentId: "agent-1", configId: null },
				{ agentId: "agent-2", configId: null },
			],
		});

		// Both variants store existingBranch for reference: the transformed
		// source (variant #1) and the newly created variant #2.
		expect(result[0]).toEqual(expect.objectContaining({
			id: "task-1",
			existingBranch: "feature/login",
			preparing: true,
			preparingStage: "resolving-config",
			preparingProgress: getPreparingStageProgress("resolving-config"),
		}));
		const addTaskCalls = vi.mocked(data.addTask).mock.calls;
		expect(addTaskCalls).toHaveLength(1);
		expect(addTaskCalls[0][3]).toEqual(expect.objectContaining({
			existingBranch: "feature/login",
		}));
		expect(addTaskCalls[0][3]).not.toHaveProperty("preparing");

		// Wait for background worktree creation
		await vi.waitFor(() => {
			expect(vi.mocked(git.createWorktree).mock.calls).toHaveLength(2);
		});

		// Each variant gets its own branch name derived from the existing branch
		const createWtCalls = vi.mocked(git.createWorktree).mock.calls;
		expect(createWtCalls[0][2]).toBe("feature/login");
		expect(createWtCalls[0][3]).toBe("feature/login-v1");
		expect(createWtCalls[1][2]).toBe("feature/login");
		expect(createWtCalls[1][3]).toBe("feature/login-v2");
	});

	it("resolves project config from worktree path for setup script", async () => {
		const project = makeProject({ setupScript: "" });
		const sourceTask = makeTask({ status: "todo", seq: 5 });
		const updatedVariant = makeTask({ status: "in-progress", worktreePath: "/tmp/vwt" });

		vi.mocked(data.getProject).mockResolvedValue(project);
		vi.mocked(data.getTask).mockResolvedValue(sourceTask);
		mockTransformSource(sourceTask);
		vi.mocked(git.createWorktree).mockResolvedValue({ worktreePath: "/tmp/vwt", branchName: "dev3/v1" });
		vi.mocked(data.updateTask).mockResolvedValue(updatedVariant);

		const repoConfig = await import("../repo-config");
		vi.mocked(repoConfig.resolveProjectConfig).mockResolvedValueOnce({
			...project,
			setupScript: "./scripts/dev3-setup.sh",
		});

		await handlers.spawnVariants({
			taskId: "task-1",
			projectId: "proj-1",
			targetStatus: "in-progress",
			variants: [{ agentId: "agent-1", configId: null }],
		});

		await vi.waitFor(() => {
			expect(git.createWorktree).toHaveBeenCalledOnce();
		});

		// Must resolve config from the worktree path using the resolved project config
		await vi.waitFor(() => {
			expect(repoConfig.resolveProjectConfig).toHaveBeenCalledWith(
				expect.objectContaining({
					id: "proj-1",
					setupScript: "./scripts/dev3-setup.sh",
				}),
				"/tmp/vwt",
			);
		});
	});

	it("reverts variant to todo and notifies when project config resolution fails before setup starts", async () => {
		const project = makeProject();
		const sourceTask = makeTask({ status: "todo", seq: 5 });

		vi.mocked(data.getProject).mockResolvedValue(project);
		vi.mocked(data.getTask).mockResolvedValue(sourceTask);
		mockTransformSource(sourceTask);
		mockTaskWrites(sourceTask);
		vi.mocked(repoConfig.resolveProjectConfig).mockImplementation(async (candidate) => {
			// Background preparation from an earlier test may still be draining. Tie
			// this failure to this test's project object so it cannot consume a shared
			// one-shot rejection before the attempt under test reaches the resolver.
			if (candidate === project) throw new Error("bad repo config");
			return candidate;
		});

		const push = vi.fn();
		setPushMessage(push);

		await handlers.spawnVariants({
			taskId: "task-1",
			projectId: "proj-1",
			targetStatus: "in-progress",
			variants: [{ agentId: "agent-1", configId: null }],
		});

		// The transformed source (same id) is reverted back to todo — a failed
		// launch never strands the original task.
		await vi.waitFor(() => {
			expect(data.updateTask).toHaveBeenCalledWith(
				project,
				"task-1",
				expect.objectContaining({ status: "todo", preparing: false, worktreePath: null, branchName: null }),
			);
		});

		const failedEvent = push.mock.calls.find((c) => c[0] === "taskPreparationFailed");
		expect(failedEvent?.[1]).toMatchObject({ taskId: "task-1", projectId: project.id });
		expect(String(failedEvent?.[1].error)).toContain("bad repo config");

		expect(git.createWorktree).not.toHaveBeenCalled();
	});

	it("reverts variant to todo and cleans up the worktree when PTY launch fails after the worktree is created", async () => {
		const project = makeProject();
		const sourceTask = makeTask({ status: "todo", seq: 5 });

		vi.mocked(data.getProject).mockResolvedValue(project);
		vi.mocked(data.getTask).mockResolvedValue(sourceTask);
		mockTransformSource(sourceTask);
		vi.mocked(git.createWorktree).mockResolvedValue({ worktreePath: "/tmp/vwt", branchName: "dev3/v1" });
		mockTaskWrites(sourceTask);
		vi.mocked(pty.createSession).mockImplementationOnce(() => {
			throw new Error("pty boom");
		});
		const push = vi.fn();
		setPushMessage(push);

		await handlers.spawnVariants({
			taskId: "task-1",
			projectId: "proj-1",
			targetStatus: "in-progress",
			variants: [{ agentId: "agent-1", configId: null }],
		});

		await vi.waitFor(() => {
			expect(data.updateTask).toHaveBeenCalledWith(
				project,
				"task-1",
				expect.objectContaining({
					status: "todo",
					preparing: false,
					worktreePath: null,
					branchName: null,
					preparationError: "pty boom",
				}),
			);
		});
		// The half-created worktree must be cleaned up, not left dangling.
		expect(git.removeWorktree).toHaveBeenCalled();
		expect(push).toHaveBeenCalledWith("taskPreparationFailed", expect.objectContaining({
			taskId: "task-1",
			error: "pty boom",
		}));
	});

	it("uses worktree-resolved sparse checkout and clone paths while preparing variants", async () => {
		const project = makeProject({ clonePaths: ["project-cache"] } as any);
		const resolvedProject = { ...project, clonePaths: ["project-cache"] } as Project;
		const worktreeResolved = {
			...project,
			sparseCheckoutEnabled: true,
			sparseCheckoutPaths: ["src", "tests"],
			clonePaths: ["branch-cache"],
		} as Project;
		const sourceTask = makeTask({ status: "todo", seq: 5 });
		const updatedVariant = makeTask({ status: "in-progress", worktreePath: "/tmp/vwt" });

		vi.mocked(data.getProject).mockResolvedValue(project);
		vi.mocked(data.getTask).mockResolvedValue(sourceTask);
		mockTransformSource(sourceTask);
		vi.mocked(git.createWorktree).mockResolvedValue({ worktreePath: "/tmp/vwt", branchName: "dev3/v1" });
		vi.mocked(data.updateTask).mockResolvedValue(updatedVariant);
		vi.mocked(repoConfig.resolveProjectConfig)
			.mockResolvedValueOnce(resolvedProject)
			.mockResolvedValueOnce(resolvedProject)
			.mockResolvedValueOnce(worktreeResolved);

		await handlers.spawnVariants({
			taskId: "task-1",
			projectId: "proj-1",
			targetStatus: "in-progress",
			variants: [{ agentId: "agent-1", configId: null }],
		});

		await vi.waitFor(() => {
			expect(git.applySparseCheckout).toHaveBeenCalledWith("/tmp/vwt", ["src", "tests"]);
		});
		expect(cowClone.clonePaths).toHaveBeenCalledWith(project.path, "/tmp/vwt", ["branch-cache"]);
	});

	it("blanks the placeholder prompt when launching a scratch variant", async () => {
		const project = makeProject();
		const sourceTask = makeTask({ status: "todo", seq: 5, scratch: true, description: "Scratch — 14:52" });

		vi.mocked(data.getProject).mockResolvedValue(project);
		mockTransformSource(sourceTask);
		vi.mocked(git.createWorktree).mockResolvedValue({ worktreePath: "/tmp/vwt", branchName: "dev3/v1" });
		mockTaskWrites(sourceTask);

		await handlers.spawnVariants({
			taskId: "task-1",
			projectId: "proj-1",
			targetStatus: "in-progress",
			variants: [{ agentId: "agent-1", configId: null }],
		});

		await vi.waitFor(() => {
			expect(agents.resolveCommandForAgent).toHaveBeenCalled();
		});
		const ctxArg = vi.mocked(agents.resolveCommandForAgent).mock.calls[0][2];
		expect(ctxArg.taskDescription).toBe("");
	});

	it("preserves a meaningful prompt when launching variants from an edited scratch task", async () => {
		const project = makeProject();
		const description = "Design an embedded HTML artifact viewer";
		const sourceTask = makeTask({ status: "todo", seq: 5, scratch: true, description });
		const secondVariant = makeTask({ id: "variant-2", status: "in-progress", preparing: true, scratch: true, description });

		vi.mocked(data.getProject).mockResolvedValue(project);
		vi.mocked(data.getTask).mockResolvedValue(sourceTask);
		mockTransformSource(sourceTask);
		vi.mocked(data.addTask).mockResolvedValueOnce(secondVariant);
		vi.mocked(git.createWorktree)
			.mockResolvedValueOnce({ worktreePath: "/tmp/vwt-1", branchName: "dev3/v1" })
			.mockResolvedValueOnce({ worktreePath: "/tmp/vwt-2", branchName: "dev3/v2" });
		vi.mocked(data.updateTask).mockImplementation(async (_project, taskId) => (
			makeTask({
				id: taskId,
				status: "in-progress",
				worktreePath: taskId === "task-1" ? "/tmp/vwt-1" : "/tmp/vwt-2",
				scratch: true,
				description,
			})
		));

		await handlers.spawnVariants({
			taskId: "task-1",
			projectId: "proj-1",
			targetStatus: "in-progress",
			variants: [
				{ agentId: "agent-1", configId: null },
				{ agentId: "agent-1", configId: null },
			],
		});

		await vi.waitFor(() => {
			expect(agents.resolveCommandForAgent).toHaveBeenCalledTimes(2);
		});
		expect(vi.mocked(agents.resolveCommandForAgent).mock.calls.map((call) => call[2].taskDescription))
			.toEqual([description, description]);
	});

	// Issue #583 — spawnVariants used to drop the user-edited customTitle from
	// the source task. Variant #1 keeps it by transforming in place; the sibling
	// variants must inherit it so the title the user typed in the Create-Task
	// modal survives "Save and Run" on every card of the group.
	it("preserves customTitle and titleEditedByUser from the source task on sibling variants", async () => {
		const project = makeProject();
		const sourceTask = makeTask({ status: "todo", seq: 5, customTitle: "User-set title", titleEditedByUser: true });
		const secondVariant = makeTask({ id: "variant-2", status: "todo", customTitle: "User-set title", titleEditedByUser: true });

		vi.mocked(data.getProject).mockResolvedValue(project);
		vi.mocked(data.getTask).mockResolvedValue(sourceTask);
		mockTransformSource(sourceTask);
		vi.mocked(data.addTask).mockResolvedValue(secondVariant);

		const result = await handlers.spawnVariants({
			taskId: "task-1",
			projectId: "proj-1",
			targetStatus: "todo",
			variants: [
				{ agentId: "agent-1", configId: null },
				{ agentId: "agent-2", configId: null },
			],
		});

		expect(result[0]).toEqual(expect.objectContaining({ id: "task-1", customTitle: "User-set title", titleEditedByUser: true }));
		expect(data.addTask).toHaveBeenCalledWith(
			project,
			sourceTask.description,
			"todo",
			expect.objectContaining({ customTitle: "User-set title", titleEditedByUser: true }),
		);
	});

	// Labels chosen in the Create-Task modal are stored on the source task, which
	// becomes variant #1 in place — sibling variants must inherit labelIds too
	// (labels belong to the whole group), otherwise "Create and Run" with several
	// agents silently drops the labels from every card but the first.
	it("preserves labelIds from the source task on sibling variants", async () => {
		const project = makeProject();
		const sourceTask = makeTask({ status: "todo", seq: 5, labelIds: ["lbl-1", "lbl-2"] });
		const secondVariant = makeTask({ id: "variant-2", status: "todo", labelIds: ["lbl-1", "lbl-2"] });

		vi.mocked(data.getProject).mockResolvedValue(project);
		vi.mocked(data.getTask).mockResolvedValue(sourceTask);
		mockTransformSource(sourceTask);
		vi.mocked(data.addTask).mockResolvedValue(secondVariant);

		const result = await handlers.spawnVariants({
			taskId: "task-1",
			projectId: "proj-1",
			targetStatus: "todo",
			variants: [
				{ agentId: "agent-1", configId: null },
				{ agentId: "agent-2", configId: null },
			],
		});

		expect(result[0].labelIds).toEqual(["lbl-1", "lbl-2"]);
		expect(data.addTask).toHaveBeenCalledWith(
			project,
			sourceTask.description,
			"todo",
			expect.objectContaining({ labelIds: ["lbl-1", "lbl-2"] }),
		);
	});

	// The priority the user picks in the Create-Task modal is stored on the
	// source task, which becomes variant #1 in place — sibling variants must
	// inherit it (priority is group-wide), otherwise a P0 launch would spawn
	// P3 siblings and split the group across sort bands.
	it("preserves priority from the source task on sibling variants", async () => {
		const project = makeProject();
		const sourceTask = makeTask({ status: "todo", seq: 5, priority: "P0" });
		const secondVariant = makeTask({ id: "variant-2", status: "todo", priority: "P0" });

		vi.mocked(data.getProject).mockResolvedValue(project);
		vi.mocked(data.getTask).mockResolvedValue(sourceTask);
		mockTransformSource(sourceTask);
		vi.mocked(data.addTask).mockResolvedValue(secondVariant);

		const result = await handlers.spawnVariants({
			taskId: "task-1",
			projectId: "proj-1",
			targetStatus: "todo",
			variants: [
				{ agentId: "agent-1", configId: null },
				{ agentId: "agent-2", configId: null },
			],
		});

		expect(result[0].priority).toBe("P0");
		expect(data.addTask).toHaveBeenCalledWith(
			project,
			sourceTask.description,
			"todo",
			expect.objectContaining({ priority: "P0" }),
		);
	});

	// A task can sit in To Do and accumulate notes + an overview before being
	// launched with variants. Variant #1 keeps them by transforming in place;
	// sibling variants get copies because each variant's agent reads its OWN
	// task — without the copy variants 2..N would launch blind to that context.
	it("preserves notes and overview from the source task on sibling variants", async () => {
		const project = makeProject();
		const notes = [
			{ id: "n1", content: "important context", source: "user" as const, createdAt: "2026-04-15T00:00:00Z", updatedAt: "2026-04-15T00:00:00Z" },
		];
		const sourceTask = makeTask({
			status: "todo",
			seq: 5,
			notes,
			overview: "agent overview",
			userOverview: "user overview",
		});
		const secondVariant = makeTask({ id: "variant-2", status: "todo", notes });

		vi.mocked(data.getProject).mockResolvedValue(project);
		vi.mocked(data.getTask).mockResolvedValue(sourceTask);
		mockTransformSource(sourceTask);
		vi.mocked(data.addTask).mockResolvedValue(secondVariant);

		const result = await handlers.spawnVariants({
			taskId: "task-1",
			projectId: "proj-1",
			targetStatus: "todo",
			variants: [
				{ agentId: "agent-1", configId: null },
				{ agentId: "agent-2", configId: null },
			],
		});

		expect(result[0].notes).toEqual(notes);
		expect(data.addTask).toHaveBeenCalledWith(
			project,
			sourceTask.description,
			"todo",
			expect.objectContaining({ notes, overview: "agent overview", userOverview: "user overview" }),
		);
	});

	// Virtual ("Operations") projects: Run / Create-and-Run funnels through
	// spawnVariants with an active target. The background preparation must NOT
	// touch git — it launches the agent + shell in a managed/chosen folder.
	describe("virtual project", () => {
		beforeEach(() => {
			vi.clearAllMocks();
			// A leaked createWorktree implementation from a prior test would make a
			// regression silently pass — force it to reject so any accidental git
			// call in the virtual path fails loudly.
			vi.mocked(git.createWorktree).mockReset();
			vi.mocked(loadSettings).mockResolvedValue({ updateChannel: "stable", taskDropPosition: "top" } as any);
			// has-session probe → 0 (exists) so launchTaskPty skips the split-shell loop.
			mockSpawn.mockReturnValue({ exited: Promise.resolve(0) });
		});

		it("launches into active status WITHOUT git: managed work dir + PTY", async () => {
			const project = makeProject({ id: "vp1", kind: "virtual", path: "/tmp/test-dev3/ops/operations" });
			const sourceTask = makeTask({ id: "src", projectId: "vp1", status: "todo", seq: 5 });
			vi.mocked(data.getProject).mockResolvedValue(project);
			mockTransformSource(sourceTask);
			mockTaskWrites(sourceTask);

			await handlers.spawnVariants({
				taskId: "src",
				projectId: "vp1",
				targetStatus: "in-progress",
				variants: [{ agentId: "agent-1", configId: null }],
			});

			// Wait for the background preparation to persist the worktreePath —
			// on the transformed source task itself (id "src" survives the launch).
			let updateArgs: Record<string, unknown> | undefined;
			await vi.waitFor(() => {
				updateArgs = vi.mocked(data.updateTask).mock.calls.find(
					(c) => c[1] === "src" && typeof (c[2] as Record<string, unknown>).worktreePath === "string",
				)?.[2] as Record<string, unknown>;
				expect(updateArgs).toBeDefined();
			});
			expect(git.createWorktree).not.toHaveBeenCalled();
			expect(mkdir).toHaveBeenCalledWith("/tmp/test-dev3/ops/operations/src/work", { recursive: true });
			expect(pty.createSession).toHaveBeenCalledWith(
				"src", "vp1", "/tmp/test-dev3/ops/operations/src/work",
				expect.anything(), expect.anything(), expect.anything(),
			);
			expect(updateArgs!.worktreePath).toBe("/tmp/test-dev3/ops/operations/src/work");
			expect(updateArgs!.branchName).toBeNull();
		});

		it("persists and pushes the same launch error when an Operations PTY fails", async () => {
			const project = makeProject({ id: "vp-fail", kind: "virtual", path: "/tmp/test-dev3/ops/operations" });
			const sourceTask = makeTask({ id: "src-fail", projectId: project.id, status: "todo" });
			vi.mocked(data.getProject).mockResolvedValue(project);
			mockTransformSource(sourceTask);
			mockTaskWrites(sourceTask);
			vi.mocked(pty.createSession).mockImplementation((taskId) => {
				if (taskId === sourceTask.id) throw new Error("operations tmux boom");
			});
			const push = vi.fn();
			setPushMessage(push);

			await handlers.spawnVariants({
				taskId: sourceTask.id,
				projectId: project.id,
				targetStatus: "in-progress",
				variants: [{ agentId: "agent-1", configId: null }],
			});

			await vi.waitFor(() => {
				expect(data.updateTask).toHaveBeenCalledWith(
					project,
					sourceTask.id,
					expect.objectContaining({ status: "todo", preparationError: "operations tmux boom" }),
				);
			});
			expect(push).toHaveBeenCalledWith("taskPreparationFailed", expect.objectContaining({
				taskId: sourceTask.id,
				error: "operations tmux boom",
			}));
		});

		it("carries the chosen opsWorkDir from the source task onto each variant", async () => {
			const project = makeProject({ id: "vp1", kind: "virtual", path: "/tmp/test-dev3/ops/operations" });
			const sourceTask = makeTask({ id: "src", projectId: "vp1", status: "todo", seq: 5, opsWorkDir: "/Users/me/Downloads" });
			const secondVariant = makeTask({ id: "variant-2", projectId: "vp1", status: "todo", opsWorkDir: "/Users/me/Downloads" });
			vi.mocked(data.getProject).mockResolvedValue(project);
			vi.mocked(data.getTask).mockResolvedValue(sourceTask);
			mockTransformSource(sourceTask);
			vi.mocked(data.addTask).mockResolvedValue(secondVariant);
			mockTaskWrites(sourceTask, secondVariant);

			await handlers.spawnVariants({
				taskId: "src",
				projectId: "vp1",
				targetStatus: "in-progress",
				variants: [
					{ agentId: "agent-1", configId: null },
					{ agentId: "agent-2", configId: null },
				],
			});

			// The transformed source keeps its own opsWorkDir; the sibling variant
			// gets a copy so its worktree-less launch targets the same folder.
			expect(vi.mocked(data.addTask).mock.calls[0][3]).toEqual(
				expect.objectContaining({ opsWorkDir: "/Users/me/Downloads" }),
			);
			await vi.waitFor(() => {
				expect(pty.createSession).toHaveBeenCalledWith(
					"src", "vp1", "/Users/me/Downloads",
					expect.anything(), expect.anything(), expect.anything(),
				);
			});
			await vi.waitFor(() => {
				expect(pty.createSession).toHaveBeenCalledWith(
					"variant-2", "vp1", "/Users/me/Downloads",
					expect.anything(), expect.anything(), expect.anything(),
				);
			});
			expect(git.createWorktree).not.toHaveBeenCalled();
		});
	});
});

describe("handlers.addAttempts", () => {
	beforeEach(() => vi.clearAllMocks());

	it("inherits existingBranch from the source task into added attempts", async () => {
		const project = makeProject();
		const sourceTask = makeTask({
			status: "in-progress",
			seq: 5,
			groupId: "group-1",
			variantIndex: 1,
			existingBranch: "feature/login",
		});
		const attemptTask = makeTask({
			id: "attempt-2",
			status: "in-progress",
			groupId: "group-1",
			variantIndex: 2,
			existingBranch: "feature/login",
			preparing: true,
		});
		const updatedAttempt = makeTask({
			...attemptTask,
			worktreePath: "/tmp/attempt-2",
			branchName: "feature/login",
		});

		vi.mocked(data.getProject).mockResolvedValue(project);
		vi.mocked(data.getTask)
			.mockResolvedValueOnce(sourceTask)
			.mockResolvedValueOnce(sourceTask);
		vi.mocked(data.loadTasks).mockResolvedValue([sourceTask]);
		vi.mocked(data.addTask).mockResolvedValue(attemptTask);
		vi.mocked(git.createWorktree).mockResolvedValue({ worktreePath: "/tmp/attempt-2", branchName: "feature/login" });
		vi.mocked(data.updateTask).mockResolvedValue(updatedAttempt);

		await handlers.addAttempts({
			taskId: "task-1",
			projectId: "proj-1",
			variants: [{ agentId: "agent-1", configId: null }],
		});

		expect(data.addTask).toHaveBeenCalledWith(
			project,
			sourceTask.description,
			"todo",
			expect.objectContaining({
				existingBranch: "feature/login",
			}),
		);

		await vi.waitFor(() => {
			expect(git.createWorktree).toHaveBeenCalledWith(
				project,
				expect.objectContaining({
					id: attemptTask.id,
					status: "in-progress",
					existingBranch: "feature/login",
					preparingStage: "resolving-config",
					preparingProgress: getPreparingStageProgress("resolving-config"),
				}),
				"feature/login",
				undefined,
			);
		});
	});

	// Added attempts belong to the same group as the source task, so they
	// must carry the same labelIds — otherwise re-running a labeled task
	// produces unlabeled attempts.
	it("inherits labelIds from the source task into added attempts", async () => {
		const project = makeProject();
		const sourceTask = makeTask({
			status: "in-progress",
			seq: 5,
			groupId: "group-1",
			variantIndex: 1,
			labelIds: ["lbl-1", "lbl-2"],
		});
		const attemptTask = makeTask({
			id: "attempt-2",
			status: "in-progress",
			groupId: "group-1",
			variantIndex: 2,
			labelIds: ["lbl-1", "lbl-2"],
			preparing: true,
		});
		const updatedAttempt = makeTask({
			...attemptTask,
			worktreePath: "/tmp/attempt-2",
		});

		vi.mocked(data.getProject).mockResolvedValue(project);
		vi.mocked(data.getTask)
			.mockResolvedValueOnce(sourceTask)
			.mockResolvedValueOnce(sourceTask);
		vi.mocked(data.loadTasks).mockResolvedValue([sourceTask]);
		vi.mocked(data.addTask).mockResolvedValue(attemptTask);
		vi.mocked(git.createWorktree).mockResolvedValue({ worktreePath: "/tmp/attempt-2", branchName: "dev3/v2" });
		vi.mocked(data.updateTask).mockResolvedValue(updatedAttempt);

		await handlers.addAttempts({
			taskId: "task-1",
			projectId: "proj-1",
			variants: [{ agentId: "agent-1", configId: null }],
		});

		expect(data.addTask).toHaveBeenCalledWith(
			project,
			sourceTask.description,
			"todo",
			expect.objectContaining({ labelIds: ["lbl-1", "lbl-2"] }),
		);
	});

	// Added attempts belong to the same group as the source task, so they must
	// carry the same priority — priority belongs to the whole variant group, so
	// re-running a P0 task must not spawn a P3 sibling.
	it("inherits priority from the source task into added attempts", async () => {
		const project = makeProject();
		const sourceTask = makeTask({
			status: "in-progress",
			seq: 5,
			groupId: "group-1",
			variantIndex: 1,
			priority: "P0",
		});
		const attemptTask = makeTask({
			id: "attempt-2",
			status: "in-progress",
			groupId: "group-1",
			variantIndex: 2,
			priority: "P0",
			preparing: true,
		});
		const updatedAttempt = makeTask({
			...attemptTask,
			worktreePath: "/tmp/attempt-2",
		});

		vi.mocked(data.getProject).mockResolvedValue(project);
		vi.mocked(data.getTask)
			.mockResolvedValueOnce(sourceTask)
			.mockResolvedValueOnce(sourceTask);
		vi.mocked(data.loadTasks).mockResolvedValue([sourceTask]);
		vi.mocked(data.addTask).mockResolvedValue(attemptTask);
		vi.mocked(git.createWorktree).mockResolvedValue({ worktreePath: "/tmp/attempt-2", branchName: "dev3/v2" });
		vi.mocked(data.updateTask).mockResolvedValue(updatedAttempt);

		await handlers.addAttempts({
			taskId: "task-1",
			projectId: "proj-1",
			variants: [{ agentId: "agent-1", configId: null }],
		});

		expect(data.addTask).toHaveBeenCalledWith(
			project,
			sourceTask.description,
			"todo",
			expect.objectContaining({ priority: "P0" }),
		);
	});

	it("propagates the scratch flag and blanks the placeholder prompt for added attempts", async () => {
		const project = makeProject();
		const sourceTask = makeTask({
			status: "in-progress",
			seq: 5,
			groupId: "group-1",
			variantIndex: 1,
			scratch: true,
			description: "Scratch — 14:52",
		});
		const attemptTask = makeTask({
			id: "attempt-2",
			status: "in-progress",
			groupId: "group-1",
			variantIndex: 2,
			scratch: true,
			description: "Scratch — 14:52",
			preparing: true,
		});
		const updatedAttempt = makeTask({ ...attemptTask, worktreePath: "/tmp/attempt-2" });

		vi.mocked(data.getProject).mockResolvedValue(project);
		vi.mocked(data.getTask).mockResolvedValue(sourceTask);
		vi.mocked(data.loadTasks).mockResolvedValue([sourceTask]);
		vi.mocked(data.addTask).mockResolvedValue(attemptTask);
		vi.mocked(git.createWorktree).mockResolvedValue({ worktreePath: "/tmp/attempt-2", branchName: "dev3/a2" });
		vi.mocked(data.updateTask).mockResolvedValue(updatedAttempt);

		await handlers.addAttempts({
			taskId: "task-1",
			projectId: "proj-1",
			variants: [{ agentId: "agent-1", configId: null }],
		});

		// The new attempt must be persisted with the scratch flag …
		expect(data.addTask).toHaveBeenCalledWith(
			project,
			sourceTask.description,
			"todo",
			expect.objectContaining({ scratch: true }),
		);

		// … and the agent must be launched with an empty prompt, not the placeholder.
		await vi.waitFor(() => {
			expect(agents.resolveCommandForAgent).toHaveBeenCalled();
		});
		const ctxArg = vi.mocked(agents.resolveCommandForAgent).mock.calls[0][2];
		expect(ctxArg.taskDescription).toBe("");
	});

	it("falls back to source task baseBranch when existingBranch is missing", async () => {
		const project = makeProject();
		const sourceTask = makeTask({
			status: "in-progress",
			seq: 5,
			groupId: "group-1",
			variantIndex: 1,
			baseBranch: "feature/login",
		});
		const attemptTask = makeTask({
			id: "attempt-2",
			status: "in-progress",
			groupId: "group-1",
			variantIndex: 2,
			existingBranch: "feature/login",
			baseBranch: "feature/login",
			preparing: true,
		});
		const updatedAttempt = makeTask({
			...attemptTask,
			worktreePath: "/tmp/attempt-2",
			branchName: "feature/login",
		});

		vi.mocked(data.getProject).mockResolvedValue(project);
		vi.mocked(data.getTask)
			.mockResolvedValueOnce(sourceTask)
			.mockResolvedValueOnce(sourceTask);
		vi.mocked(data.loadTasks).mockResolvedValue([sourceTask]);
		vi.mocked(data.addTask).mockResolvedValue(attemptTask);
		vi.mocked(git.createWorktree).mockResolvedValue({ worktreePath: "/tmp/attempt-2", branchName: "feature/login" });
		vi.mocked(data.updateTask).mockResolvedValue(updatedAttempt);

		await handlers.addAttempts({
			taskId: "task-1",
			projectId: "proj-1",
			variants: [{ agentId: "agent-1", configId: null }],
		});

		expect(data.addTask).toHaveBeenCalledWith(
			project,
			sourceTask.description,
			"todo",
			expect.objectContaining({
				existingBranch: "feature/login",
			}),
		);

		await vi.waitFor(() => {
			expect(git.createWorktree).toHaveBeenCalledWith(
				project,
				expect.objectContaining({
					id: attemptTask.id,
					status: "in-progress",
					existingBranch: "feature/login",
					preparingStage: "resolving-config",
					preparingProgress: getPreparingStageProgress("resolving-config"),
				}),
				"feature/login",
				undefined,
			);
		});
	});

	// Issue #583 — same root cause as the spawnVariants case: addAttempts must
	// carry the user-edited customTitle from the source task onto every new
	// attempt, otherwise re-running a task throws away the title the user typed.
	it("preserves customTitle and titleEditedByUser from the source task on added attempts", async () => {
		const project = makeProject();
		const sourceTask = makeTask({
			status: "in-progress",
			seq: 5,
			groupId: "group-1",
			variantIndex: 1,
			customTitle: "User-set title",
			titleEditedByUser: true,
		});
		const attemptTask = makeTask({
			id: "attempt-2",
			status: "in-progress",
			groupId: "group-1",
			variantIndex: 2,
			customTitle: "User-set title",
			titleEditedByUser: true,
			preparing: true,
		});

		vi.mocked(data.getProject).mockResolvedValue(project);
		vi.mocked(data.getTask)
			.mockResolvedValueOnce(sourceTask)
			.mockResolvedValueOnce(sourceTask);
		vi.mocked(data.loadTasks).mockResolvedValue([sourceTask]);
		vi.mocked(data.addTask).mockResolvedValue(attemptTask);
		vi.mocked(git.createWorktree).mockResolvedValue({ worktreePath: "/tmp/attempt-2", branchName: "dev3/x" });
		vi.mocked(data.updateTask).mockResolvedValue(attemptTask);

		await handlers.addAttempts({
			taskId: "task-1",
			projectId: "proj-1",
			variants: [{ agentId: "agent-1", configId: null }],
		});

		expect(data.addTask).toHaveBeenCalledWith(
			project,
			sourceTask.description,
			"todo",
			expect.objectContaining({ customTitle: "User-set title", titleEditedByUser: true }),
		);
	});

	it("reverts attempt to todo and notifies when project config resolution fails before setup starts", async () => {
		const project = makeProject();
		const sourceTask = makeTask({ status: "in-progress", seq: 5, groupId: "group-1", variantIndex: 1 });
		const attemptTask = makeTask({
			id: "attempt-2",
			status: "todo",
			groupId: "group-1",
			variantIndex: 2,
		});
		vi.mocked(data.getProject).mockResolvedValue(project);
		vi.mocked(data.getTask)
			.mockResolvedValueOnce(sourceTask)
			.mockResolvedValueOnce(sourceTask);
		vi.mocked(data.loadTasks).mockResolvedValue([sourceTask]);
		vi.mocked(data.addTask).mockResolvedValue(attemptTask);
		mockTaskWrites(sourceTask, attemptTask);
		vi.mocked(repoConfig.resolveProjectConfig).mockImplementation(async (candidate) => {
			if (candidate === project) throw new Error("bad repo config");
			return candidate;
		});

		const push = vi.fn();
		setPushMessage(push);

		await handlers.addAttempts({
			taskId: "task-1",
			projectId: "proj-1",
			variants: [{ agentId: "agent-1", configId: null }],
		});

		// A failed preparation must not strand the task in-progress: it is moved
		// back to todo (status: "todo", worktree/branch cleared).
		await vi.waitFor(() => {
			expect(data.updateTask).toHaveBeenCalledWith(
				project,
				"attempt-2",
				expect.objectContaining({
					status: "todo",
					preparing: false,
					worktreePath: null,
					branchName: null,
					preparationError: "bad repo config",
				}),
			);
		});

		// The real error is surfaced to the renderer as a toast.
		const failedEvent = push.mock.calls.find((c) => c[0] === "taskPreparationFailed");
		expect(failedEvent).toBeDefined();
		expect(failedEvent?.[1]).toMatchObject({ taskId: "attempt-2", projectId: project.id });
		expect(String(failedEvent?.[1].error)).toContain("bad repo config");

		expect(git.createWorktree).not.toHaveBeenCalled();
	});

	it("reverts only the failed attempt to todo while a sibling attempt succeeds", async () => {
		const project = makeProject();
		const sourceTask = makeTask({ status: "in-progress", seq: 5, groupId: "group-1", variantIndex: 1 });
		const firstAttempt = makeTask({
			id: "attempt-2",
			status: "todo",
			groupId: "group-1",
			variantIndex: 2,
		});
		const secondAttempt = makeTask({
			id: "attempt-3",
			status: "todo",
			groupId: "group-1",
			variantIndex: 3,
		});

		vi.mocked(data.getProject).mockResolvedValue(project);
		vi.mocked(data.getTask)
			.mockResolvedValueOnce(sourceTask)
			.mockResolvedValueOnce(sourceTask);
		vi.mocked(data.loadTasks).mockResolvedValue([sourceTask]);
		vi.mocked(data.addTask)
			.mockResolvedValueOnce(firstAttempt)
			.mockResolvedValueOnce(secondAttempt);
		vi.mocked(git.createWorktree)
			.mockRejectedValueOnce(new Error("wt boom"))
			.mockResolvedValueOnce({ worktreePath: "/tmp/attempt-3", branchName: "dev3/a3" });
		mockTaskWrites(sourceTask, firstAttempt, secondAttempt);

		await handlers.addAttempts({
			taskId: "task-1",
			projectId: "proj-1",
			variants: [
				{ agentId: "agent-1", configId: null },
				{ agentId: "agent-2", configId: null },
			],
		});

		await vi.waitFor(() => {
			expect(git.createWorktree).toHaveBeenCalledTimes(2);
		});
		// Failed attempt → reverted to todo.
		expect(data.updateTask).toHaveBeenCalledWith(
			project,
			"attempt-2",
			expect.objectContaining({ status: "todo", preparing: false, worktreePath: null, branchName: null }),
		);
		// Succeeded attempt → stays in-progress with its worktree.
		expect(data.updateTask).toHaveBeenCalledWith(
			project,
			"attempt-3",
			expect.objectContaining({
				status: "in-progress",
				worktreePath: "/tmp/attempt-3",
				branchName: "dev3/a3",
			}),
			{ dropPosition: "top" },
		);
	});
});

describe("handlers.cancelTaskPreparation", () => {
	beforeEach(() => vi.clearAllMocks());

	it("kills tracked preparation processes and moves the task back to todo", async () => {
		const project = makeProject();
		const task = makeTask({
			id: "variant-1",
			status: "in-progress",
			preparing: true,
			baseBranch: "main",
			worktreePath: null,
			branchName: null,
		});
		const revertedTask = makeTask({
			...task,
			status: "todo",
			preparing: false,
			worktreePath: null,
			branchName: null,
			customColumnId: null,
		});

		createTaskPreparation(task.id, "test");
		registerPreparationSpawn(task.id, 111, ["git", "fetch", "origin"]);
		registerPreparationSpawn(task.id, 222, ["cp", "-R", "src", "dst"]);

		mockSpawn.mockReturnValue({
			pid: 999,
			stdout: new Response(""),
			stderr: new Response(""),
			exited: Promise.resolve(0),
		});
		vi.mocked(data.getProject).mockResolvedValue(project);
		vi.mocked(data.getTask).mockResolvedValue(task);
		mockTaskWrites(task);
		vi.mocked(git.removeWorktree).mockResolvedValue(undefined);
		vi.mocked(git.taskDir).mockReturnValue("/tmp/test-dev3/worktrees/tmp-test-project/variant-1");

		const result = await handlers.cancelTaskPreparation({
			taskId: task.id,
			projectId: project.id,
		});

		expect(result).toEqual(expect.objectContaining({
			id: revertedTask.id,
			status: "todo",
			worktreePath: null,
			branchName: null,
			customColumnId: null,
			preparing: false,
			preparationError: null,
			preparingStage: null,
			preparingProgress: null,
			preparingStartedAt: null,
			runtimeState: expect.objectContaining({ runtime: "idle" }),
		}));
		expect(mockSpawn).toHaveBeenCalledWith(["kill", "-9", "111"], expect.anything());
		expect(mockSpawn).toHaveBeenCalledWith(["kill", "-9", "222"], expect.anything());
		expect(data.updateTask).toHaveBeenCalledWith(project, task.id, expect.objectContaining({
			status: "todo",
			preparing: false,
			preparingStage: null,
			preparingProgress: null,
			preparingStartedAt: null,
			worktreePath: null,
			branchName: null,
			customColumnId: null,
			preparationError: null,
			runtimeState: expect.objectContaining({ runtime: "idle" }),
		}));
		expect(git.removeWorktree).toHaveBeenCalledWith(project, expect.objectContaining({
			id: task.id,
			worktreePath: "/tmp/test-dev3/worktrees/tmp-test-project/variant-1/worktree",
		}));
	});
});

// ================================================================
// handlers.getBranchStatus
// ================================================================

describe("resolveTaskCompareBaseBranch", () => {
	it("returns the stored base branch for a normal task", () => {
		expect(
			resolveTaskCompareBaseBranch(
				{ baseBranch: "main", branchName: "dev3/feature" },
				{ defaultBaseBranch: "main" },
			),
		).toBe("main");
	});

	it("keeps a custom base branch that differs from the task branch", () => {
		expect(
			resolveTaskCompareBaseBranch(
				{ baseBranch: "develop", branchName: "feat/x" },
				{ defaultBaseBranch: "main" },
			),
		).toBe("develop");
	});

	it("falls back to the project base when base collapses onto the task branch", () => {
		// PR-review / existing-branch task: baseBranch === branchName.
		expect(
			resolveTaskCompareBaseBranch(
				{ baseBranch: "codex/pr-head", branchName: "codex/pr-head" },
				{ defaultBaseBranch: "main" },
			),
		).toBe("main");
	});

	it("defaults the project base to main when unset", () => {
		expect(
			resolveTaskCompareBaseBranch(
				{ baseBranch: "feat/x", branchName: "feat/x" },
				{ defaultBaseBranch: "" },
			),
		).toBe("main");
	});
});

describe("handlers.getTaskDiff base branch resolution", () => {
	beforeEach(() => vi.clearAllMocks());

	const branchDiffResponse: TaskDiffResponse = {
		mode: "branch",
		compareRef: "origin/main",
		compareLabel: "origin/main",
		fallbackReason: null,
		recentCount: null,
		summary: { files: 0, insertions: 0, deletions: 0 },
		files: [],
		skippedFiles: [],
	};

	it("resolves a PR-review task's diff base to the project base, not the branch itself", async () => {
		const project = makeProject({ defaultBaseBranch: "main" });
		const task = makeTask({
			worktreePath: "/tmp/wt",
			branchName: "codex/pr-head",
			baseBranch: "codex/pr-head",
			prNumber: 16484,
		});
		vi.mocked(data.getProject).mockResolvedValue(project);
		vi.mocked(data.getTask).mockResolvedValue(task);
		vi.mocked(git.fetchOrigin).mockResolvedValue(true);
		vi.mocked(git.getTaskDiff).mockResolvedValue(branchDiffResponse);

		await handlers.getTaskDiff({ taskId: task.id, projectId: project.id, mode: "branch" });

		// Fetch and diff against the real base — never the branch compared to itself.
		expect(git.fetchOrigin).toHaveBeenCalledWith(project.path, "main");
		expect(git.getTaskDiff).toHaveBeenCalledWith(
			"/tmp/wt",
			"branch",
			expect.objectContaining({ baseBranch: "main" }),
		);
	});

	it("leaves a normal task's diff base untouched", async () => {
		const project = makeProject({ defaultBaseBranch: "main" });
		const task = makeTask({ worktreePath: "/tmp/wt", branchName: "dev3/feature", baseBranch: "main" });
		vi.mocked(data.getProject).mockResolvedValue(project);
		vi.mocked(data.getTask).mockResolvedValue(task);
		vi.mocked(git.fetchOrigin).mockResolvedValue(true);
		vi.mocked(git.getTaskDiff).mockResolvedValue(branchDiffResponse);

		await handlers.getTaskDiff({ taskId: task.id, projectId: project.id, mode: "branch" });

		expect(git.getTaskDiff).toHaveBeenCalledWith(
			"/tmp/wt",
			"branch",
			expect.objectContaining({ baseBranch: "main" }),
		);
	});
});

describe("handlers.getBranchStatus", () => {
	beforeEach(() => vi.clearAllMocks());

	it("returns zeros when task has no worktree", async () => {
		const project = makeProject();
		const task = makeTask({ worktreePath: null });
		vi.mocked(data.getProject).mockResolvedValue(project);
		vi.mocked(data.getTask).mockResolvedValue(task);

		const result = await handlers.getBranchStatus({ taskId: "task-1", projectId: "proj-1" });
		expect(result).toEqual({ ahead: 0, behind: 0, canRebase: false, insertions: 0, deletions: 0, unpushed: 0, mergedByContent: false, diffFiles: 0, diffInsertions: 0, diffDeletions: 0, diffFileStats: [], prNumber: null, prUrl: null, mergeCompletionFingerprint: null });
	});

	it("returns branch status with canRebase=true when behind", async () => {
		const project = makeProject();
		const task = makeTask({ worktreePath: "/tmp/wt", branchName: "dev3/t" });
		vi.mocked(data.getProject).mockResolvedValue(project);
		vi.mocked(data.getTask).mockResolvedValue(task);
		vi.mocked(git.getCurrentBranch).mockResolvedValue("dev3/t");
		vi.mocked(git.fetchOrigin).mockResolvedValue(true);
		vi.mocked(git.getBranchStatus).mockResolvedValue({ ahead: 3, behind: 2 });
		vi.mocked(git.getUncommittedChanges).mockResolvedValue({ insertions: 10, deletions: 5 });
		vi.mocked(git.getUnpushedCount).mockResolvedValue(1);
		vi.mocked(git.getBranchDiffStats).mockResolvedValue({ files: 4, insertions: 50, deletions: 20, fileStats: [{path:"a.ts",insertions:50,deletions:20},{path:"b.ts",insertions:0,deletions:0},{path:"c.ts",insertions:0,deletions:0},{path:"d.ts",insertions:0,deletions:0}] });
		vi.mocked(git.canRebaseCleanly).mockResolvedValue(true);

		const result = await handlers.getBranchStatus({ taskId: "task-1", projectId: "proj-1" });
		expect(result).toMatchObject({
			ahead: 3,
			behind: 2,
			canRebase: true,
			insertions: 10,
			deletions: 5,
			unpushed: 1,
			diffFiles: 4,
			diffInsertions: 50,
			diffDeletions: 20,
		});
	});

	it("sets canRebase=false when not behind", async () => {
		const project = makeProject();
		const task = makeTask({ worktreePath: "/tmp/wt", branchName: "dev3/t" });
		vi.mocked(data.getProject).mockResolvedValue(project);
		vi.mocked(data.getTask).mockResolvedValue(task);
		vi.mocked(git.getCurrentBranch).mockResolvedValue("dev3/t");
		vi.mocked(git.fetchOrigin).mockResolvedValue(true);
		vi.mocked(git.getBranchStatus).mockResolvedValue({ ahead: 1, behind: 0 });
		vi.mocked(git.getUncommittedChanges).mockResolvedValue({ insertions: 0, deletions: 0 });
		vi.mocked(git.getUnpushedCount).mockResolvedValue(0);
		vi.mocked(git.getBranchDiffStats).mockResolvedValue({ files: 0, insertions: 0, deletions: 0, fileStats: [] });

		const result = await handlers.getBranchStatus({ taskId: "task-1", projectId: "proj-1" });
		expect(result.canRebase).toBe(false);
		expect(git.canRebaseCleanly).not.toHaveBeenCalled();
	});

	it("compares a PR-review task (baseBranch === branchName) against the project base, not itself", async () => {
		// PR-review / existing-branch tasks check out the PR head branch and
		// deriveTaskBaseBranch stores that same branch as baseBranch. Comparing
		// origin/<branch> against HEAD is trivially empty (the "No changes to show"
		// diff bug + a false "Branch Merged" prompt) — it must fall back to the base.
		const project = makeProject({ defaultBaseBranch: "main" });
		const task = makeTask({
			worktreePath: "/tmp/wt",
			branchName: "codex/pr-head",
			baseBranch: "codex/pr-head",
			existingBranch: "origin/codex/pr-head",
			prNumber: 16484,
		});
		vi.mocked(data.getProject).mockResolvedValue(project);
		vi.mocked(data.getTask).mockResolvedValue(task);
		vi.mocked(git.getCurrentBranch).mockResolvedValue("codex/pr-head");
		vi.mocked(git.fetchOrigin).mockResolvedValue(true);
		vi.mocked(git.getBranchStatus).mockResolvedValue({ ahead: 5, behind: 0 });
		vi.mocked(git.getUncommittedChanges).mockResolvedValue({ insertions: 0, deletions: 0 });
		vi.mocked(git.getUnpushedCount).mockResolvedValue(0);
		vi.mocked(git.getBranchDiffStats).mockResolvedValue({ files: 3, insertions: 30, deletions: 10, fileStats: [] });
		vi.mocked(github.runGitHub).mockResolvedValue({ ok: true, stdout: "[]", stderr: "", code: 0 });

		await handlers.getBranchStatus({ taskId: task.id, projectId: project.id });

		// The comparison ref must be the project base, never the branch against itself.
		expect(git.getBranchStatus).toHaveBeenCalledWith("/tmp/wt", "origin/main");
		expect(git.getBranchDiffStats).toHaveBeenCalledWith("/tmp/wt", "origin/main");
	});

	it("auto-syncs stored branchName when live branch differs", async () => {
		const project = makeProject();
		const task = makeTask({ worktreePath: "/tmp/wt", branchName: "dev3/task-aaaa" });
		vi.mocked(data.getProject).mockResolvedValue(project);
		vi.mocked(data.getTask).mockResolvedValue(task);
		vi.mocked(data.updateTask).mockResolvedValue({ ...task, branchName: "dev3/fix-login" });
		vi.mocked(git.getCurrentBranch).mockResolvedValue("dev3/fix-login");
		vi.mocked(git.fetchOrigin).mockResolvedValue(true);
		vi.mocked(git.getBranchStatus).mockResolvedValue({ ahead: 0, behind: 0 });
		vi.mocked(git.getUncommittedChanges).mockResolvedValue({ insertions: 0, deletions: 0 });
		vi.mocked(git.getUnpushedCount).mockResolvedValue(0);
		vi.mocked(git.getBranchDiffStats).mockResolvedValue({ files: 0, insertions: 0, deletions: 0, fileStats: [] });

		const push = vi.fn();
		setPushMessage(push);

		await handlers.getBranchStatus({ taskId: "task-1", projectId: "proj-1" });

		// Should have synced the stored branchName
		expect(data.updateTask).toHaveBeenCalledWith(project, "task-1", { branchName: "dev3/fix-login" });
		// Should pass live branch name to getUnpushedCount
		expect(git.getUnpushedCount).toHaveBeenCalledWith("/tmp/wt", "dev3/fix-login");
		// Must notify the renderer so the header/cards re-render with the new
		// branch instead of showing the stale name until a reload.
		expect(push).toHaveBeenCalledWith("taskUpdated", {
			projectId: "proj-1",
			task: expect.objectContaining({ branchName: "dev3/fix-login" }),
		});
	});

	it("does not update branchName when live matches stored", async () => {
		const project = makeProject();
		const task = makeTask({ worktreePath: "/tmp/wt", branchName: "dev3/task-aaaa" });
		vi.mocked(data.getProject).mockResolvedValue(project);
		vi.mocked(data.getTask).mockResolvedValue(task);
		vi.mocked(git.getCurrentBranch).mockResolvedValue("dev3/task-aaaa");
		vi.mocked(git.fetchOrigin).mockResolvedValue(true);
		vi.mocked(git.getBranchStatus).mockResolvedValue({ ahead: 0, behind: 0 });
		vi.mocked(git.getUncommittedChanges).mockResolvedValue({ insertions: 0, deletions: 0 });
		vi.mocked(git.getUnpushedCount).mockResolvedValue(0);
		vi.mocked(git.getBranchDiffStats).mockResolvedValue({ files: 0, insertions: 0, deletions: 0, fileStats: [] });

		const push = vi.fn();
		setPushMessage(push);

		await handlers.getBranchStatus({ taskId: "task-1", projectId: "proj-1" });

		expect(data.updateTask).not.toHaveBeenCalled();
		expect(push).not.toHaveBeenCalledWith("taskUpdated", expect.anything());
	});

	it("returns prNumber when gh pr list finds an open non-draft PR", async () => {
		const project = makeProject();
		const task = makeTask({ worktreePath: "/tmp/wt", branchName: "feat/login" });
		vi.mocked(data.getProject).mockResolvedValue(project);
		vi.mocked(data.getTask).mockResolvedValue(task);
		vi.mocked(git.getCurrentBranch).mockResolvedValue("feat/login");
		vi.mocked(git.fetchOrigin).mockResolvedValue(true);
		vi.mocked(git.getBranchStatus).mockResolvedValue({ ahead: 1, behind: 0 });
		vi.mocked(git.getUncommittedChanges).mockResolvedValue({ insertions: 0, deletions: 0 });
		vi.mocked(git.getUnpushedCount).mockResolvedValue(0);
		vi.mocked(git.getBranchDiffStats).mockResolvedValue({ files: 0, insertions: 0, deletions: 0, fileStats: [] });
		vi.mocked(github.runGitHub).mockResolvedValue({ ok: true, stdout: JSON.stringify([{ number: 42 }]), stderr: "", code: 0 });

		const result = await handlers.getBranchStatus({ taskId: "task-1", projectId: "proj-1" });
		expect(result.prNumber).toBe(42);
	});

	it("persists a PR identity discovered by task branch status", async () => {
		const project = makeProject();
		const task = makeTask({ worktreePath: "/tmp/wt", branchName: "feat/login" });
		const prUrl = "https://github.com/test/repo/pull/42";
		const persisted = { ...task, prNumber: 42, prUrl };
		vi.mocked(data.getProject).mockResolvedValue(project);
		vi.mocked(data.getTask).mockResolvedValue(task);
		vi.mocked(data.updateTask).mockResolvedValue(persisted);
		vi.mocked(git.getCurrentBranch).mockResolvedValue("feat/login");
		vi.mocked(git.fetchOrigin).mockResolvedValue(true);
		vi.mocked(git.getBranchStatus).mockResolvedValue({ ahead: 1, behind: 0 });
		vi.mocked(git.getUncommittedChanges).mockResolvedValue({ insertions: 0, deletions: 0 });
		vi.mocked(git.getUnpushedCount).mockResolvedValue(0);
		vi.mocked(git.getBranchDiffStats).mockResolvedValue({ files: 0, insertions: 0, deletions: 0, fileStats: [] });
		vi.mocked(github.runGitHub).mockResolvedValue({ ok: true, stdout: JSON.stringify([{ number: 42, url: prUrl }]), stderr: "", code: 0 });
		const push = vi.fn();
		setPushMessage(push);

		await handlers.getBranchStatus({ taskId: task.id, projectId: project.id });

		expect(data.updateTask).toHaveBeenCalledWith(project, task.id, { prNumber: 42, prUrl });
		expect(push).toHaveBeenCalledWith("taskUpdated", { projectId: project.id, task: persisted });
	});

	it("returns prNumber=null when gh pr list returns empty array", async () => {
		const project = makeProject();
		const task = makeTask({ worktreePath: "/tmp/wt", branchName: "feat/login" });
		vi.mocked(data.getProject).mockResolvedValue(project);
		vi.mocked(data.getTask).mockResolvedValue(task);
		vi.mocked(git.getCurrentBranch).mockResolvedValue("feat/login");
		vi.mocked(git.fetchOrigin).mockResolvedValue(true);
		vi.mocked(git.getBranchStatus).mockResolvedValue({ ahead: 1, behind: 0 });
		vi.mocked(git.getUncommittedChanges).mockResolvedValue({ insertions: 0, deletions: 0 });
		vi.mocked(git.getUnpushedCount).mockResolvedValue(0);
		vi.mocked(git.getBranchDiffStats).mockResolvedValue({ files: 0, insertions: 0, deletions: 0, fileStats: [] });
		vi.mocked(github.runGitHub).mockResolvedValue({ ok: true, stdout: "[]", stderr: "", code: 0 });

		const result = await handlers.getBranchStatus({ taskId: "task-1", projectId: "proj-1" });
		expect(result.prNumber).toBeNull();
	});

	it("keeps a previously detected PR identity when gh pr list returns empty", async () => {
		const project = makeProject();
		const task = makeTask({
			worktreePath: "/tmp/wt",
			branchName: "feat/login",
			prNumber: 42,
			prUrl: "https://github.com/test/repo/pull/42",
		});
		vi.mocked(data.getProject).mockResolvedValue(project);
		vi.mocked(data.getTask).mockResolvedValue(task);
		vi.mocked(git.getCurrentBranch).mockResolvedValue("feat/login");
		vi.mocked(git.fetchOrigin).mockResolvedValue(true);
		vi.mocked(git.getBranchStatus).mockResolvedValue({ ahead: 0, behind: 0 });
		vi.mocked(git.getUncommittedChanges).mockResolvedValue({ insertions: 0, deletions: 0 });
		vi.mocked(git.getUnpushedCount).mockResolvedValue(0);
		vi.mocked(git.getBranchDiffStats).mockResolvedValue({ files: 0, insertions: 0, deletions: 0, fileStats: [] });
		vi.mocked(github.runGitHub).mockResolvedValue({ ok: true, stdout: "[]", stderr: "", code: 0 });

		const result = await handlers.getBranchStatus({ taskId: task.id, projectId: project.id });

		expect(result.prNumber).toBe(42);
		expect(result.prUrl).toBe(task.prUrl);
	});

	it("returns prNumber=null when gh pr list fails", async () => {
		const project = makeProject();
		const task = makeTask({ worktreePath: "/tmp/wt", branchName: "feat/login" });
		vi.mocked(data.getProject).mockResolvedValue(project);
		vi.mocked(data.getTask).mockResolvedValue(task);
		vi.mocked(git.getCurrentBranch).mockResolvedValue("feat/login");
		vi.mocked(git.fetchOrigin).mockResolvedValue(true);
		vi.mocked(git.getBranchStatus).mockResolvedValue({ ahead: 1, behind: 0 });
		vi.mocked(git.getUncommittedChanges).mockResolvedValue({ insertions: 0, deletions: 0 });
		vi.mocked(git.getUnpushedCount).mockResolvedValue(0);
		vi.mocked(git.getBranchDiffStats).mockResolvedValue({ files: 0, insertions: 0, deletions: 0, fileStats: [] });
		vi.mocked(github.runGitHub).mockResolvedValue({ ok: false, stdout: "", stderr: "gh not found", code: 1 });

		const result = await handlers.getBranchStatus({ taskId: "task-1", projectId: "proj-1" });
		expect(result.prNumber).toBeNull();
	});

	it("returns prNumber=null when gh returns invalid JSON", async () => {
		const project = makeProject();
		const task = makeTask({ worktreePath: "/tmp/wt", branchName: "feat/login" });
		vi.mocked(data.getProject).mockResolvedValue(project);
		vi.mocked(data.getTask).mockResolvedValue(task);
		vi.mocked(git.getCurrentBranch).mockResolvedValue("feat/login");
		vi.mocked(git.fetchOrigin).mockResolvedValue(true);
		vi.mocked(git.getBranchStatus).mockResolvedValue({ ahead: 1, behind: 0 });
		vi.mocked(git.getUncommittedChanges).mockResolvedValue({ insertions: 0, deletions: 0 });
		vi.mocked(git.getUnpushedCount).mockResolvedValue(0);
		vi.mocked(git.getBranchDiffStats).mockResolvedValue({ files: 0, insertions: 0, deletions: 0, fileStats: [] });
		vi.mocked(github.runGitHub).mockResolvedValue({ ok: true, stdout: "not json", stderr: "", code: 0 });

		const result = await handlers.getBranchStatus({ taskId: "task-1", projectId: "proj-1" });
		expect(result.prNumber).toBeNull();
	});

	it("returns prNumber for draft PRs (drafts are included)", async () => {
		const project = makeProject();
		const task = makeTask({ worktreePath: "/tmp/wt", branchName: "feat/login" });
		vi.mocked(data.getProject).mockResolvedValue(project);
		vi.mocked(data.getTask).mockResolvedValue(task);
		vi.mocked(git.getCurrentBranch).mockResolvedValue("feat/login");
		vi.mocked(git.fetchOrigin).mockResolvedValue(true);
		vi.mocked(git.getBranchStatus).mockResolvedValue({ ahead: 1, behind: 0 });
		vi.mocked(git.getUncommittedChanges).mockResolvedValue({ insertions: 0, deletions: 0 });
		vi.mocked(git.getUnpushedCount).mockResolvedValue(0);
		vi.mocked(git.getBranchDiffStats).mockResolvedValue({ files: 0, insertions: 0, deletions: 0, fileStats: [] });
		vi.mocked(github.runGitHub).mockResolvedValue({ ok: true, stdout: JSON.stringify([{ number: 10 }]), stderr: "", code: 0 });

		const result = await handlers.getBranchStatus({ taskId: "task-1", projectId: "proj-1" });
		expect(result.prNumber).toBe(10);
	});
});

describe("handlers.getProjectPRs", () => {
	beforeEach(() => vi.clearAllMocks());

	it("persists PR identities matched to task branches, including terminal records", async () => {
		const project = makeProject();
		const task = makeTask({ status: "completed", branchName: "feat/login" });
		const prUrl = "https://github.com/test/repo/pull/42";
		const persisted = { ...task, prNumber: 42, prUrl };
		vi.mocked(data.getProject).mockResolvedValue(project);
		vi.mocked(data.loadTasks).mockResolvedValue([task]);
		vi.mocked(data.updateTask).mockResolvedValue(persisted);
		vi.mocked(github.runGitHub).mockResolvedValue({
			ok: true,
			stdout: JSON.stringify([{ number: 42, headRefName: task.branchName, url: prUrl }]),
			stderr: "",
			code: 0,
		});
		const push = vi.fn();
		setPushMessage(push);

		const result = await handlers.getProjectPRs({ projectId: project.id });

		expect(result).toEqual([{ number: 42, headRefName: task.branchName, url: prUrl }]);
		expect(data.updateTask).toHaveBeenCalledWith(project, task.id, { prNumber: 42, prUrl });
		expect(push).toHaveBeenCalledWith("taskUpdated", { projectId: project.id, task: persisted });
	});
});

// ================================================================
// handlers.resolvePrUrl
// ================================================================

describe("handlers.resolvePrUrl", () => {
	beforeEach(() => vi.clearAllMocks());

	const PR_URL = "https://github.com/test/repo/pull/42";

	it("resolves a same-repo PR to origin/<head> and fetches origin", async () => {
		const project = makeProject();
		vi.mocked(data.getProject).mockResolvedValue(project);
		vi.mocked(git.fetchOrigin).mockResolvedValue(true);
		vi.mocked(github.runGitHub).mockResolvedValue({
			ok: true,
			stdout: JSON.stringify({ number: 42, title: "My PR", headRefName: "feat/login", isCrossRepository: false, headRepositoryOwner: { login: "test" } }),
			stderr: "",
			code: 0,
		});

		const result = await handlers.resolvePrUrl({ projectId: "proj-1", url: PR_URL });

		expect(result).toEqual({ ok: true, branch: "origin/feat/login", number: 42, title: "My PR", isFork: false, error: null });
		expect(git.fetchOrigin).toHaveBeenCalledWith(project.path, "feat/login");
		expect(git.fetchFork).not.toHaveBeenCalled();
		// The full URL is passed straight to gh pr view.
		expect(vi.mocked(github.runGitHub).mock.calls[0][2]).toContain(PR_URL);
	});

	it("resolves a fork PR to <forkOwner>/<head> and fetches the fork", async () => {
		const project = makeProject();
		vi.mocked(data.getProject).mockResolvedValue(project);
		vi.mocked(git.fetchFork).mockResolvedValue(true);
		vi.mocked(github.runGitHub).mockResolvedValue({
			ok: true,
			stdout: JSON.stringify({ number: 7, title: "Fork PR", headRefName: "fix/bug", isCrossRepository: true, headRepositoryOwner: { login: "contributor" } }),
			stderr: "",
			code: 0,
		});

		const result = await handlers.resolvePrUrl({ projectId: "proj-1", url: "https://github.com/test/repo/pull/7" });

		expect(result).toEqual({ ok: true, branch: "contributor/fix/bug", number: 7, title: "Fork PR", isFork: true, error: null });
		expect(git.fetchFork).toHaveBeenCalledWith(project.path, "contributor", "fix/bug");
		expect(git.fetchOrigin).not.toHaveBeenCalled();
	});

	it("returns an error when gh pr view fails", async () => {
		const project = makeProject();
		vi.mocked(data.getProject).mockResolvedValue(project);
		vi.mocked(github.runGitHub).mockResolvedValue({ ok: false, stdout: "", stderr: "could not resolve to a PullRequest", code: 1 });

		const result = await handlers.resolvePrUrl({ projectId: "proj-1", url: PR_URL });

		expect(result.ok).toBe(false);
		expect(result.branch).toBeNull();
		expect(result.error).toBe("could not resolve to a PullRequest");
	});

	it("returns an error when the fork fetch fails", async () => {
		const project = makeProject();
		vi.mocked(data.getProject).mockResolvedValue(project);
		vi.mocked(git.fetchFork).mockResolvedValue(false);
		vi.mocked(github.runGitHub).mockResolvedValue({
			ok: true,
			stdout: JSON.stringify({ number: 7, title: "Fork PR", headRefName: "fix/bug", isCrossRepository: true, headRepositoryOwner: { login: "contributor" } }),
			stderr: "",
			code: 0,
		});

		const result = await handlers.resolvePrUrl({ projectId: "proj-1", url: PR_URL });

		expect(result.ok).toBe(false);
		expect(result.isFork).toBe(true);
		expect(result.error).toContain("fix/bug");
	});

	it("returns an error on invalid JSON from gh", async () => {
		const project = makeProject();
		vi.mocked(data.getProject).mockResolvedValue(project);
		vi.mocked(github.runGitHub).mockResolvedValue({ ok: true, stdout: "not json", stderr: "", code: 0 });

		const result = await handlers.resolvePrUrl({ projectId: "proj-1", url: PR_URL });

		expect(result.ok).toBe(false);
		expect(result.error).toBeTruthy();
	});
});

// ================================================================
// handlers.getTaskDiff
// ================================================================

describe("handlers.getTaskDiff", () => {
	beforeEach(() => vi.clearAllMocks());

	it("throws when task has no worktree", async () => {
		const project = makeProject();
		const task = makeTask({ worktreePath: null });
		vi.mocked(data.getProject).mockResolvedValue(project);
		vi.mocked(data.getTask).mockResolvedValue(task);

		await expect(
			handlers.getTaskDiff({ taskId: "task-1", projectId: "proj-1", mode: "branch" }),
		).rejects.toThrow("Task has no worktree");
	});

	it("fetches origin for branch diffs and returns git payload", async () => {
		const project = makeProject();
		const task = makeTask({ worktreePath: "/tmp/wt", baseBranch: "main" });
		const diffPayload = {
			mode: "branch" as const,
			compareRef: "origin/main",
			compareLabel: "origin/main",
			fallbackReason: null,
			recentCount: null,
			summary: { files: 1, insertions: 3, deletions: 1 },
			files: [],
			skippedFiles: [],
		};
		vi.mocked(data.getProject).mockResolvedValue(project);
		vi.mocked(data.getTask).mockResolvedValue(task);
		vi.mocked(git.fetchOrigin).mockResolvedValue(true);
		vi.mocked(git.getTaskDiff).mockResolvedValue(diffPayload);

		const result = await handlers.getTaskDiff({
			taskId: "task-1",
			projectId: "proj-1",
			mode: "branch",
			compareRef: "origin/main",
			compareLabel: "origin/main",
		});

		expect(git.fetchOrigin).toHaveBeenCalledWith(project.path, "main");
		expect(git.getTaskDiff).toHaveBeenCalledWith("/tmp/wt", "branch", {
			baseBranch: "main",
			compareRef: "origin/main",
			compareLabel: "origin/main",
		});
		expect(result).toBe(diffPayload);
	});

	it("skips origin fetch for uncommitted diffs", async () => {
		const project = makeProject();
		const task = makeTask({ worktreePath: "/tmp/wt", baseBranch: "main" });
		vi.mocked(data.getProject).mockResolvedValue(project);
		vi.mocked(data.getTask).mockResolvedValue(task);
		vi.mocked(git.getTaskDiff).mockResolvedValue({
			mode: "uncommitted",
			compareRef: null,
			compareLabel: "Working tree",
			fallbackReason: null,
			recentCount: null,
			summary: { files: 0, insertions: 0, deletions: 0 },
			files: [],
			skippedFiles: [],
		});

		await handlers.getTaskDiff({ taskId: "task-1", projectId: "proj-1", mode: "uncommitted" });

		expect(git.fetchOrigin).not.toHaveBeenCalled();
		expect(git.getTaskDiff).toHaveBeenCalledWith("/tmp/wt", "uncommitted", {
			baseBranch: "main",
			compareRef: undefined,
			compareLabel: undefined,
		});
	});

	it("skips origin fetch for recent diffs and forwards the commit count", async () => {
		const project = makeProject();
		const task = makeTask({ worktreePath: "/tmp/wt", baseBranch: "main" });
		vi.mocked(data.getProject).mockResolvedValue(project);
		vi.mocked(data.getTask).mockResolvedValue(task);
		vi.mocked(git.getTaskDiff).mockResolvedValue({
			mode: "recent",
			compareRef: "HEAD~3",
			compareLabel: "HEAD~3",
			fallbackReason: null,
			recentCount: 3,
			summary: { files: 1, insertions: 1, deletions: 0 },
			files: [],
			skippedFiles: [],
		});

		await handlers.getTaskDiff({ taskId: "task-1", projectId: "proj-1", mode: "recent", count: 3 });

		// `recent` is purely local — no network fetch — and `count` reaches git.getTaskDiff.
		expect(git.fetchOrigin).not.toHaveBeenCalled();
		expect(git.getTaskDiff).toHaveBeenCalledWith("/tmp/wt", "recent", {
			baseBranch: "main",
			compareRef: undefined,
			compareLabel: undefined,
			count: 3,
		});
	});
});

// ================================================================
// handlers.getPtyUrl
// ================================================================

describe("handlers.getPtyUrl", () => {
	beforeEach(() => vi.clearAllMocks());

	it("returns URL directly when session exists", async () => {
		vi.mocked(pty.hasSession).mockReturnValue(true);
		vi.mocked(pty.tmuxSessionExists).mockResolvedValue(true);
		vi.mocked(pty.getPtyPort).mockReturnValue(9999);

		const result = await handlers.getPtyUrl({ taskId: "task-1" });
		expect(result).toEqual({ url: "ws://localhost:9999?session=task-1" });
	});

	it("destroys stale session when tmux is gone and offers recovery", async () => {
		const project = makeProject();
		const sessionState = { panes: [{ agentCmd: "claude", sessionId: "sid-1", agentId: "a", configId: "c" }] };
		const task = makeTask({ status: "in-progress", worktreePath: "/tmp/wt", sessionState });

		// hasSession: true (log), true (stale check), false (after destroy)
		vi.mocked(pty.hasSession).mockReturnValueOnce(true).mockReturnValueOnce(true).mockReturnValueOnce(false);
		vi.mocked(pty.tmuxSessionExists).mockResolvedValue(false);
		vi.mocked(pty.getPtyPort).mockReturnValue(9999);
		vi.mocked(data.loadProjects).mockResolvedValue([project]);
		vi.mocked(data.getTask).mockResolvedValue(task);

		const result = await handlers.getPtyUrl({ taskId: "task-1" });
		expect(pty.destroySession).toHaveBeenCalledWith("task-1");
		expect(result).toEqual({ recoverable: true, sessionState });
	});

	it("tries to restore PTY when session is missing and tmux alive", async () => {
		const project = makeProject();
		const task = makeTask({ status: "in-progress", worktreePath: "/tmp/wt" });

		vi.mocked(pty.hasSession).mockReturnValue(false);
		vi.mocked(pty.tmuxSessionExists).mockResolvedValue(true);
		vi.mocked(pty.getPtyPort).mockReturnValue(9999);
		vi.mocked(data.loadProjects).mockResolvedValue([project]);
		vi.mocked(data.getTask).mockResolvedValue(task);

		const result = await handlers.getPtyUrl({ taskId: "task-1" });
		expect(result).toEqual({ url: expect.stringContaining("session=task-1") });
	});

	it("launches fresh when no tmux session and no sessionState", async () => {
		const project = makeProject();
		const task = makeTask({ status: "in-progress", worktreePath: "/tmp/wt" });

		vi.mocked(pty.hasSession).mockReturnValue(false);
		vi.mocked(pty.tmuxSessionExists).mockResolvedValue(false);
		vi.mocked(pty.getPtyPort).mockReturnValue(9999);
		vi.mocked(data.loadProjects).mockResolvedValue([project]);
		vi.mocked(data.getTask).mockResolvedValue(task);

		const result = await handlers.getPtyUrl({ taskId: "task-1" });
		expect(result).toEqual({ url: expect.stringContaining("session=task-1") });
		expect(pty.createSession).toHaveBeenCalled();
	});

	it("restores a VIRTUAL (Operations) task's dead session — scans virtual boards, skips git config", async () => {
		// Regression: findTaskAcrossProjects scanned only git projects, so an active
		// operation whose tmux session died could never be restored ("[session ended]").
		const vproject = makeProject({ id: "vp1", kind: "virtual", path: "/tmp/test-dev3/ops/operations" });
		const task = makeTask({ status: "in-progress", worktreePath: "/tmp/test-dev3/ops/operations/task-1/work" });

		vi.mocked(pty.hasSession).mockReturnValue(false);
		vi.mocked(pty.tmuxSessionExists).mockResolvedValue(false);
		vi.mocked(pty.getPtyPort).mockReturnValue(9999);
		mockSpawn.mockReturnValue({ exited: Promise.resolve(0) });
		vi.mocked(data.loadProjects).mockResolvedValue([]);
		vi.mocked(data.loadVirtualProjects).mockResolvedValue([vproject]);
		vi.mocked(data.getTask).mockResolvedValue(task);

		const result = await handlers.getPtyUrl({ taskId: "task-1" });

		expect(result).toEqual({ url: expect.stringContaining("session=task-1") });
		expect(pty.createSession).toHaveBeenCalledWith(
			"task-1", "vp1", "/tmp/test-dev3/ops/operations/task-1/work",
			expect.anything(), expect.anything(), expect.anything(),
		);
		// Virtual boards have no git repo config — it must be skipped.
		expect(repoConfig.resolveProjectConfig).not.toHaveBeenCalled();
	});

	it("returns recoverable when tmux is dead but sessionState exists", async () => {
		const project = makeProject();
		const sessionState = { panes: [{ agentCmd: "claude", sessionId: "sid-123", agentId: "builtin-claude", configId: "config-1" }] };
		const task = makeTask({ status: "in-progress", worktreePath: "/tmp/wt", sessionState });

		vi.mocked(pty.hasSession).mockReturnValue(false);
		vi.mocked(pty.tmuxSessionExists).mockResolvedValue(false);
		vi.mocked(pty.getPtyPort).mockReturnValue(9999);
		vi.mocked(data.loadProjects).mockResolvedValue([project]);
		vi.mocked(data.getTask).mockResolvedValue(task);

		const result = await handlers.getPtyUrl({ taskId: "task-1" });
		expect(result).toEqual({ recoverable: true, sessionState });
	});

	it("resolves project config before restoring a PTY session", async () => {
		const project = makeProject({ autoReviewEnabled: false });
		const resolvedProject = makeProject({ autoReviewEnabled: true });
		const task = makeTask({ status: "in-progress", worktreePath: "/tmp/wt" });

		vi.mocked(pty.hasSession).mockReturnValue(false);
		vi.mocked(pty.tmuxSessionExists).mockResolvedValue(true);
		vi.mocked(pty.getPtyPort).mockReturnValue(9999);
		vi.mocked(data.loadProjects).mockResolvedValue([project]);
		vi.mocked(data.getTask).mockResolvedValue(task);
		vi.mocked(repoConfig.resolveProjectConfig).mockResolvedValueOnce(resolvedProject);

		await handlers.getPtyUrl({ taskId: "task-1" });

		expect(repoConfig.resolveProjectConfig).toHaveBeenCalledWith(project, "/tmp/wt");
	});

	it("does not crash when worktree is missing during restore", async () => {
		const project = makeProject();
		const task = makeTask({ status: "in-progress", worktreePath: "/tmp/deleted" });

		vi.mocked(pty.hasSession).mockReturnValue(false);
		vi.mocked(pty.tmuxSessionExists).mockResolvedValue(false);
		vi.mocked(data.loadProjects).mockResolvedValue([project]);
		vi.mocked(data.getTask).mockResolvedValue(task);
		vi.mocked(existsSync).mockReturnValue(false);

		const result = await handlers.getPtyUrl({ taskId: "task-1" });
		expect(result).toEqual({ url: expect.stringContaining("session=task-1") });
	});

	it("handles task not found across projects", async () => {
		vi.mocked(pty.hasSession).mockReturnValue(false);
		vi.mocked(data.loadProjects).mockResolvedValue([makeProject()]);
		vi.mocked(data.getTask).mockRejectedValue(new Error("not found"));

		const result = await handlers.getPtyUrl({ taskId: "task-unknown" });
		expect(result).toEqual({ url: expect.stringContaining("session=task-unknown") });
	});

	it("skips restore for completed task", async () => {
		const project = makeProject();
		const task = makeTask({ status: "completed", worktreePath: null });

		vi.mocked(pty.hasSession).mockReturnValue(false);
		vi.mocked(data.loadProjects).mockResolvedValue([project]);
		vi.mocked(data.getTask).mockResolvedValue(task);

		const result = await handlers.getPtyUrl({ taskId: "task-1" });
		expect(result).toEqual({ url: expect.stringContaining("session=task-1") });
		expect(pty.createSession).not.toHaveBeenCalled();
	});

	it("destroys dead session and relaunches with resume flag", async () => {
		const project = makeProject();
		const task = makeTask({ status: "in-progress", worktreePath: "/tmp/wt" });

		vi.mocked(pty.hasDeadSession).mockReturnValue(true);
		vi.mocked(pty.hasSession).mockReturnValue(false);
		vi.mocked(pty.tmuxSessionExists).mockResolvedValue(false);
		vi.mocked(pty.getPtyPort).mockReturnValue(9999);
		vi.mocked(data.loadProjects).mockResolvedValue([project]);
		vi.mocked(data.getTask).mockResolvedValue(task);

		const result = await handlers.getPtyUrl({ taskId: "task-1", resume: true });

		expect(pty.destroySession).toHaveBeenCalledWith("task-1");
		expect(result).toEqual({ url: expect.stringContaining("session=task-1") });
		expect(pty.createSession).toHaveBeenCalled();
	});

	it("does not destroy session when resume=true but session is alive", async () => {
		vi.mocked(pty.hasDeadSession).mockReturnValue(false);
		vi.mocked(pty.hasSession).mockReturnValue(true);
		vi.mocked(pty.tmuxSessionExists).mockResolvedValue(true);
		vi.mocked(pty.getPtyPort).mockReturnValue(9999);

		const result = await handlers.getPtyUrl({ taskId: "task-1", resume: true });

		expect(pty.destroySession).not.toHaveBeenCalled();
		expect(result).toEqual({ url: "ws://localhost:9999?session=task-1" });
	});

	it("destroys dead sessions when tmux is gone (stale check)", async () => {
		const project = makeProject();
		const task = makeTask({ status: "in-progress", worktreePath: "/tmp/wt" });

		// hasSession true (in map), hasDeadSession true (proc null), tmux gone
		vi.mocked(pty.hasDeadSession).mockReturnValue(true);
		// hasSession: true (log), true (stale check), false (after destroy)
		vi.mocked(pty.hasSession).mockReturnValueOnce(true).mockReturnValueOnce(true).mockReturnValueOnce(false);
		vi.mocked(pty.tmuxSessionExists).mockResolvedValue(false);
		vi.mocked(pty.getPtyPort).mockReturnValue(9999);
		vi.mocked(data.loadProjects).mockResolvedValue([project]);
		vi.mocked(data.getTask).mockResolvedValue(task);

		await handlers.getPtyUrl({ taskId: "task-1" });

		expect(pty.destroySession).toHaveBeenCalledWith("task-1");
	});

	it("passes task agentId and configId when restoring session", async () => {
		const project = makeProject();
		const task = makeTask({
			status: "in-progress",
			worktreePath: "/tmp/wt",
			agentId: "agent-claude",
			configId: "config-opus",
		});

		vi.mocked(pty.hasSession).mockReturnValue(false);
		vi.mocked(pty.tmuxSessionExists).mockResolvedValue(true);
		vi.mocked(pty.getPtyPort).mockReturnValue(9999);
		vi.mocked(data.loadProjects).mockResolvedValue([project]);
		vi.mocked(data.getTask).mockResolvedValue(task);

		await handlers.getPtyUrl({ taskId: "task-1" });

		expect(agents.resolveCommandForAgent).toHaveBeenCalledWith(
			"agent-claude",
			"config-opus",
			expect.any(Object),
			expect.any(Object),
		);
	});

	it("passes resume option to agent command resolution", async () => {
		const project = makeProject();
		const task = makeTask({
			status: "in-progress",
			worktreePath: "/tmp/wt",
			agentId: "agent-claude",
			configId: "config-opus",
		});

		vi.mocked(pty.hasDeadSession).mockReturnValue(true);
		vi.mocked(pty.hasSession).mockReturnValue(false);
		vi.mocked(pty.tmuxSessionExists).mockResolvedValue(false);
		vi.mocked(pty.getPtyPort).mockReturnValue(9999);
		vi.mocked(data.loadProjects).mockResolvedValue([project]);
		vi.mocked(data.getTask).mockResolvedValue(task);

		await handlers.getPtyUrl({ taskId: "task-1", resume: true });

		// Should launch fresh (no sessionState, no tmux) — not resume
		expect(pty.createSession).toHaveBeenCalled();
	});

	it("uses resolveCommandForProject when task has no agentId", async () => {
		const project = makeProject();
		const task = makeTask({
			status: "in-progress",
			worktreePath: "/tmp/wt",
			agentId: null,
			configId: null,
		});

		vi.mocked(pty.hasSession).mockReturnValue(false);
		vi.mocked(pty.tmuxSessionExists).mockResolvedValue(true);
		vi.mocked(pty.getPtyPort).mockReturnValue(9999);
		vi.mocked(data.loadProjects).mockResolvedValue([project]);
		vi.mocked(data.getTask).mockResolvedValue(task);

		await handlers.getPtyUrl({ taskId: "task-1", resume: true });

		expect(agents.resolveCommandForProject).toHaveBeenCalled();
		expect(agents.resolveCommandForAgent).not.toHaveBeenCalled();
	});

	it("does not crash when loadProjects throws", async () => {
		vi.mocked(pty.hasSession).mockReturnValue(false);
		vi.mocked(pty.getPtyPort).mockReturnValue(9999);
		vi.mocked(data.loadProjects).mockRejectedValue(new Error("disk error"));

		const result = await handlers.getPtyUrl({ taskId: "task-1" });
		expect(result).toEqual({ url: expect.stringContaining("session=task-1") });
	});

	it("does not crash when launchTaskPty throws during restore", async () => {
		const project = makeProject();
		const task = makeTask({ status: "in-progress", worktreePath: "/tmp/wt" });

		vi.mocked(pty.hasSession).mockReturnValue(false);
		vi.mocked(pty.tmuxSessionExists).mockResolvedValue(false);
		vi.mocked(pty.getPtyPort).mockReturnValue(9999);
		vi.mocked(data.loadProjects).mockResolvedValue([project]);
		vi.mocked(data.getTask).mockResolvedValue(task);
		vi.mocked(agents.resolveCommandForProject).mockRejectedValueOnce(new Error("agent resolution failed"));

		const result = await handlers.getPtyUrl({ taskId: "task-1" });
		expect(result).toEqual({ url: expect.stringContaining("session=task-1") });
	});

	it("skips restore when task has active status but null worktreePath", async () => {
		const project = makeProject();
		const task = makeTask({ status: "in-progress", worktreePath: null });

		vi.mocked(pty.hasSession).mockReturnValue(false);
		vi.mocked(pty.getPtyPort).mockReturnValue(9999);
		vi.mocked(data.loadProjects).mockResolvedValue([project]);
		vi.mocked(data.getTask).mockResolvedValue(task);

		const result = await handlers.getPtyUrl({ taskId: "task-1" });
		expect(result).toEqual({ url: expect.stringContaining("session=task-1") });
		expect(pty.createSession).not.toHaveBeenCalled();
	});

	it("finds task in second project when first has no match", async () => {
		const project1 = makeProject({ id: "proj-1" });
		const project2 = makeProject({ id: "proj-2" });
		const task = makeTask({ status: "in-progress", worktreePath: "/tmp/wt" });

		vi.mocked(pty.hasSession).mockReturnValue(false);
		vi.mocked(pty.tmuxSessionExists).mockResolvedValue(true);
		vi.mocked(pty.getPtyPort).mockReturnValue(9999);
		vi.mocked(data.loadProjects).mockResolvedValue([project1, project2]);
		vi.mocked(data.getTask)
			.mockRejectedValueOnce(new Error("not found"))
			.mockResolvedValueOnce(task);

		const result = await handlers.getPtyUrl({ taskId: "task-1" });
		expect(result).toEqual({ url: expect.stringContaining("session=task-1") });
		expect(pty.createSession).toHaveBeenCalled();
	});

	it("resume=true with no dead session and no live session restores normally", async () => {
		const project = makeProject();
		const task = makeTask({ status: "in-progress", worktreePath: "/tmp/wt" });

		vi.mocked(pty.hasDeadSession).mockReturnValue(false);
		vi.mocked(pty.hasSession).mockReturnValue(false);
		vi.mocked(pty.tmuxSessionExists).mockResolvedValue(false);
		vi.mocked(pty.getPtyPort).mockReturnValue(9999);
		vi.mocked(data.loadProjects).mockResolvedValue([project]);
		vi.mocked(data.getTask).mockResolvedValue(task);

		const result = await handlers.getPtyUrl({ taskId: "task-1", resume: true });

		expect(pty.destroySession).not.toHaveBeenCalled();
		expect(result).toEqual({ url: expect.stringContaining("session=task-1") });
		expect(pty.createSession).toHaveBeenCalled();
	});
});

// ================================================================
// handlers.getTerminalPreview
// ================================================================

describe("handlers.getTerminalPreview", () => {
	beforeEach(() => vi.clearAllMocks());

	it("delegates to pty.capturePane", async () => {
		vi.mocked(pty.capturePane).mockResolvedValue("terminal output");
		const result = await handlers.getTerminalPreview({ taskId: "task-1" });
		expect(result).toBe("terminal output");
		expect(pty.capturePane).toHaveBeenCalledWith("task-1");
	});

	it("returns null when no session", async () => {
		vi.mocked(pty.capturePane).mockResolvedValue(null);
		const result = await handlers.getTerminalPreview({ taskId: "task-1" });
		expect(result).toBeNull();
	});
});

describe("handlers.copyTerminalSelection", () => {
	beforeEach(() => {
		vi.mocked(systemClipboard.writeSystemClipboard).mockReset();
		vi.mocked(systemClipboard.writeSystemClipboard).mockReturnValue("pbcopy");
		delete process.env.DEV3_HEADLESS;
	});

	it("writes terminal selections through the system clipboard helper", async () => {
		const result = await handlers.copyTerminalSelection({
			taskId: "home",
			text: "selected terminal text",
			mouseTracking: false,
		});

		expect(systemClipboard.writeSystemClipboard).toHaveBeenCalledWith("selected terminal text");
		expect(result).toEqual({ ok: true, tool: "pbcopy" });
	});

	it("does not write host clipboard from headless mode", async () => {
		process.env.DEV3_HEADLESS = "1";

		const result = await handlers.copyTerminalSelection({
			taskId: "home",
			text: "remote browser text",
			mouseTracking: false,
		});

		expect(systemClipboard.writeSystemClipboard).not.toHaveBeenCalled();
		expect(result).toEqual({ ok: false, tool: null });
		delete process.env.DEV3_HEADLESS;
	});
});

// ================================================================
// handlers.listDirectory
// ================================================================

describe("handlers.listDirectory", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.mocked(existsSync).mockReturnValue(true);
		vi.mocked(readdirSync).mockReturnValue([] as any);
		vi.mocked(statSync).mockReturnValue({ isDirectory: () => true, size: 0 } as any);
	});

	it("defaults to the home directory when no path is provided", async () => {
		const result = await handlers.listDirectory();
		expect(result.path.length).toBeGreaterThan(0);
		expect(result.home.length).toBeGreaterThan(0);
		expect(result.path).toBe(result.home);
	});

	it("filters out hidden entries by default and returns directories first", async () => {
		vi.mocked(readdirSync).mockReturnValue([".hidden", "zeta.txt", "alpha", "Beta"] as any);
		vi.mocked(statSync).mockImplementation((p: any) => {
			const name = String(p).split("/").pop();
			return { isDirectory: () => name === "alpha" || name === "Beta", size: 0 } as any;
		});
		const result = await handlers.listDirectory({ path: "/tmp/test" });
		expect(result.entries.map((e) => e.name)).toEqual(["alpha", "Beta"]);
		expect(result.entries.every((e) => e.isDir)).toBe(true);
	});

	it("includes hidden entries when showHidden is true", async () => {
		vi.mocked(readdirSync).mockReturnValue([".hidden", "visible"] as any);
		const result = await handlers.listDirectory({ path: "/tmp/test", showHidden: true });
		expect(result.entries.map((e) => e.name)).toContain(".hidden");
	});

	it("includes files when includeFiles is true", async () => {
		vi.mocked(readdirSync).mockReturnValue(["dir", "file.txt"] as any);
		vi.mocked(statSync).mockImplementation((p: any) => {
			const name = String(p).split("/").pop();
			return { isDirectory: () => name === "dir", size: 0 } as any;
		});
		const result = await handlers.listDirectory({ path: "/tmp/test", includeFiles: true });
		expect(result.entries.map((e) => ({ name: e.name, isDir: e.isDir }))).toEqual([
			{ name: "dir", isDir: true },
			{ name: "file.txt", isDir: false },
		]);
	});

	it("returns a null parent for the filesystem root", async () => {
		const result = await handlers.listDirectory({ path: "/" });
		expect(result.path).toBe("/");
		expect(result.parent).toBeNull();
	});

	it("returns an error (not a throw) when the requested path does not exist", async () => {
		vi.mocked(existsSync).mockReturnValue(false);
		const result = await handlers.listDirectory({ path: "/no/such/place" });
		expect(result.entries).toEqual([]);
		expect(result.error).toBeTruthy();
	});

	it("skips entries where statSync throws (permission denied / broken symlinks)", async () => {
		vi.mocked(readdirSync).mockReturnValue(["ok", "denied"] as any);
		vi.mocked(statSync).mockImplementation((p: any) => {
			if (String(p).endsWith("/denied")) throw new Error("EACCES");
			return { isDirectory: () => true, size: 0 } as any;
		});
		const result = await handlers.listDirectory({ path: "/tmp/test" });
		expect(result.entries.map((e) => e.name)).toEqual(["ok"]);
	});
});

// ================================================================
// handlers.quitApp
// ================================================================

describe("handlers.quitApp", () => {
	beforeEach(() => vi.clearAllMocks());

	it("calls Utils.quit", async () => {
		await handlers.quitApp();
		expect(Utils.quit).toHaveBeenCalledOnce();
	});

	it("does not persist skipQuitDialog when dontShowAgain is absent", async () => {
		await handlers.quitApp();
		expect(saveSettings).not.toHaveBeenCalled();
	});

	it("persists skipQuitDialog=true when dontShowAgain is set", async () => {
		await handlers.quitApp({ dontShowAgain: true });
		expect(saveSettings).toHaveBeenCalledWith(
			expect.objectContaining({ skipQuitDialog: true }),
		);
		expect(Utils.quit).toHaveBeenCalledOnce();
	});
});

// ================================================================
// handlers.requestQuit
// ================================================================

describe("handlers.requestQuit", () => {
	beforeEach(() => vi.clearAllMocks());

	it("triggers Utils.quit so the before-quit gate runs (renderer Cmd+Q path)", async () => {
		await handlers.requestQuit();
		expect(Utils.quit).toHaveBeenCalledOnce();
	});

	it("does not persist any setting or confirm the quit itself", async () => {
		await handlers.requestQuit();
		// requestQuit only starts the quit; confirmation/persistence happens in
		// quitApp after the dialog. So no settings write here.
		expect(saveSettings).not.toHaveBeenCalled();
	});
});

// ================================================================
// handlers.openNewWindow
// ================================================================

describe("handlers.openNewWindow", () => {
	beforeEach(() => vi.clearAllMocks());

	it("invokes the registered window-manager openNewWindow callback", async () => {
		const wm = await import("../window-manager");
		const spy = vi.fn();
		wm.setOpenNewWindow(spy);
		await handlers.openNewWindow();
		expect(spy).toHaveBeenCalledOnce();
		wm.setOpenNewWindow(() => {});
	});
});

// ================================================================
// handlers.consumePendingQuitDialog
// ================================================================

describe("handlers.consumePendingQuitDialog", () => {
	it("returns true once when a quit is pending, then false", async () => {
		const { markQuitDialogPending, __resetQuitConfirmedForTests } = await import("../quit-manager");
		__resetQuitConfirmedForTests();
		markQuitDialogPending();
		expect(await handlers.consumePendingQuitDialog()).toBe(true);
		expect(await handlers.consumePendingQuitDialog()).toBe(false);
	});

	it("returns false when nothing is pending", async () => {
		const { __resetQuitConfirmedForTests } = await import("../quit-manager");
		__resetQuitConfirmedForTests();
		expect(await handlers.consumePendingQuitDialog()).toBe(false);
	});
});

// ================================================================
// handlers.hideApp
// ================================================================

describe("handlers.hideApp", () => {
	beforeEach(() => vi.clearAllMocks());

	it("calls [NSApp hide:nil] via Objective-C FFI", async () => {
		await handlers.hideApp();

		// Step 1: get NSApplication class
		expect(mockObjcGetClass).toHaveBeenCalledOnce();

		// Step 2: register selectors
		expect(mockSelRegisterName).toHaveBeenCalledTimes(2);

		// Step 3: objc_msgSend called twice
		expect(mockObjcMsgSend).toHaveBeenCalledTimes(2);
		const calls = mockObjcMsgSend.mock.calls as unknown[][];
		// First call: [NSApplication sharedApplication]
		expect(calls[0][0]).toBe("NSApplication_ptr");
		expect(calls[0][1]).toBe("sel_sharedApplication");
		// Second call: [app hide:nil] — app is return value of first call
		expect(calls[1][0]).toBe("NSApp_instance");
		expect(calls[1][1]).toBe("sel_hide:");
	});
});

// ================================================================
// handlers.checkSystemRequirements
// ================================================================

describe("handlers.checkSystemRequirements", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.mocked(existsSync).mockReturnValue(true);
		vi.mocked(statSync).mockReturnValue({ isFile: () => true, mode: 0o755 } as any);
		vi.mocked(accessSync).mockImplementation(() => undefined);
		vi.mocked(loadSettings).mockResolvedValue({ updateChannel: "stable" } as any);
	});

	it("returns installed status for each requirement", async () => {
		mockSpawnSync.mockReturnValue({ exitCode: 0, stdout: new TextEncoder().encode("/usr/bin/git") });

		const results = await handlers.checkSystemRequirements();
		expect(results).toHaveLength(2);
		expect(results[0].id).toBe("git");
		expect(results[0].installed).toBe(true);
		expect(results[1].id).toBe("tmux");
		expect(results[1].installed).toBe(true);
	});

	it("marks missing requirements when which fails and no fallback paths exist", async () => {
		mockSpawnSync
			.mockReturnValueOnce({ exitCode: 0, stdout: new TextEncoder().encode("/usr/bin/git") })  // git found
			.mockReturnValueOnce({ exitCode: 1 });  // tmux not found via which
		vi.mocked(existsSync).mockImplementation((p) => String(p) === "/usr/bin/git"); // git exists; no tmux candidates do

		const results = await handlers.checkSystemRequirements();
		expect(results[0].installed).toBe(true);
		expect(results[1].installed).toBe(false);
		expect(results[1].installHint).toBe("requirements.installTmux");
	});

	it("finds tmux via fallback homebrew path when which fails", async () => {
		mockSpawnSync
			.mockReturnValueOnce({ exitCode: 0, stdout: new TextEncoder().encode("/usr/bin/git") })
			.mockReturnValueOnce({ exitCode: 1 });  // tmux not found via which
		vi.mocked(existsSync).mockImplementation((p) => String(p) === "/opt/homebrew/bin/tmux");

		const results = await handlers.checkSystemRequirements();
		expect(results[1].installed).toBe(true);
		expect(results[1].resolvedPath).toBe("/opt/homebrew/bin/tmux");
	});

	it("uses custom binary path from settings", async () => {
		vi.mocked(loadSettings).mockResolvedValue({ customBinaryPaths: { tmux: "/custom/path/tmux" } } as any);
		mockSpawnSync.mockReturnValue({ exitCode: 0, stdout: new TextEncoder().encode("/usr/bin/git") });
		vi.mocked(existsSync).mockImplementation((p) => String(p) === "/custom/path/tmux");

		const results = await handlers.checkSystemRequirements();
		expect(results[1].installed).toBe(true);
		expect(results[1].resolvedPath).toBe("/custom/path/tmux");
	});

	it("prefers the vendored tmux@3.6 keg over the PATH tmux", async () => {
		mockSpawnSync.mockReturnValue({ exitCode: 0, stdout: new TextEncoder().encode("/opt/homebrew/bin/tmux") });
		vi.mocked(existsSync).mockImplementation((p) => String(p) === "/opt/homebrew/opt/tmux@3.6/bin/tmux");

		const results = await handlers.checkSystemRequirements();
		expect(results[1].installed).toBe(true);
		expect(results[1].resolvedPath).toBe("/opt/homebrew/opt/tmux@3.6/bin/tmux");
		expect(tmux.selectBinary).toHaveBeenCalledWith(
			"/opt/homebrew/opt/tmux@3.6/bin/tmux",
			expect.arrayContaining(["/opt/homebrew/bin/tmux"]),
		);
	});

	it("dereferences the PATH shim in fallback candidates (ELOOP regression)", async () => {
		// Without the tmux@3.6 keg, whichSync returns our own ~/.dev3.0/bin/tmux
		// shim (that dir is first in PATH) — it must never survive as a fallback
		// candidate, or the shim ends up symlinked onto itself.
		const SHIM = "/mock/dev3-home/bin/tmux";
		mockSpawnSync.mockReturnValue({ exitCode: 0, stdout: new TextEncoder().encode(SHIM) });
		vi.mocked(existsSync).mockImplementation((p) => String(p) === SHIM); // valid shim; vendored keg not installed

		await handlers.checkSystemRequirements();
		expect(tmux.dereferenceShim).toHaveBeenCalledWith(SHIM);
		const fallbacks = vi.mocked(tmux.selectBinary).mock.calls[0][1] as string[];
		expect(fallbacks).toContain("/opt/homebrew/bin/tmux");
		expect(fallbacks).not.toContain(SHIM);
	});

	it("rejects a PATH tmux shim that resolves to a directory", async () => {
		const SHIM = "/mock/dev3-home/bin/tmux";
		mockSpawnSync
			.mockReturnValueOnce({ exitCode: 0, stdout: new TextEncoder().encode("/usr/bin/git") })
			.mockReturnValueOnce({ exitCode: 0, stdout: new TextEncoder().encode(SHIM) });
		vi.mocked(existsSync).mockImplementation((p) => ["/usr/bin/git", SHIM].includes(String(p)));
		vi.mocked(statSync).mockImplementation(((p: string) => ({ isFile: () => String(p) !== SHIM })) as any);

		const results = await handlers.checkSystemRequirements();

		expect(results[1].installed).toBe(false);
		expect(results[1].customPathError).toBe(false);
		expect(tmux.selectBinary).not.toHaveBeenCalled();
	});
});

// ================================================================
// handlers.setCustomBinaryPath
// ================================================================

describe("handlers.setCustomBinaryPath", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.mocked(loadSettings).mockResolvedValue({
			updateChannel: "stable",
			customBinaryPaths: { git: "/known/good/git" },
		} as any);
		vi.mocked(existsSync).mockReturnValue(true);
		vi.mocked(statSync).mockReturnValue({ isFile: () => true, mode: 0o755 } as any);
		vi.mocked(accessSync).mockImplementation(() => undefined);
		vi.mocked(tmux.probeVersion).mockResolvedValue("tmux 3.6a");
	});

	it("rejects a directory without persisting it", async () => {
		vi.mocked(statSync).mockReturnValue({ isFile: () => false } as any);

		const result = await handlers.setCustomBinaryPath({ requirementId: "tmux", path: "/Users/tester" });

		expect(result).toEqual({ ok: false });
		expect(saveSettings).not.toHaveBeenCalled();
		expect(tmux.probeVersion).not.toHaveBeenCalled();
	});

	it("rejects an executable that is not tmux without persisting it", async () => {
		vi.mocked(tmux.probeVersion).mockResolvedValue(undefined);

		const result = await handlers.setCustomBinaryPath({ requirementId: "tmux", path: "/usr/bin/true" });

		expect(result).toEqual({ ok: false });
		expect(saveSettings).not.toHaveBeenCalled();
	});

	it("persists a validated tmux binary and preserves other custom paths", async () => {
		const result = await handlers.setCustomBinaryPath({ requirementId: "tmux", path: "  /opt/homebrew/bin/tmux  " });

		expect(result).toEqual({ ok: true });
		expect(tmux.probeVersion).toHaveBeenCalledWith("/opt/homebrew/bin/tmux");
		expect(saveSettings).toHaveBeenCalledWith(expect.objectContaining({
			customBinaryPaths: {
				git: "/known/good/git",
				tmux: "/opt/homebrew/bin/tmux",
			},
		}));
	});
});

// ================================================================
// resolveTmuxBinaryAtStartup
// ================================================================

describe("resolveTmuxBinaryAtStartup", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.mocked(existsSync).mockReturnValue(true);
		vi.mocked(statSync).mockReturnValue({ isFile: () => true, mode: 0o755 } as any);
		vi.mocked(accessSync).mockImplementation(() => undefined);
		vi.mocked(loadSettings).mockResolvedValue({ updateChannel: "stable" } as any);
	});

	it("resolves and commits the vendored keg at startup", async () => {
		mockSpawnSync.mockReturnValue({ exitCode: 1, stdout: null });
		vi.mocked(existsSync).mockImplementation((p) => String(p) === "/opt/homebrew/opt/tmux@3.6/bin/tmux");

		const { resolveTmuxBinaryAtStartup } = await import("../rpc-handlers/settings-config");
		const chosen = await resolveTmuxBinaryAtStartup();
		expect(chosen).toBe("/opt/homebrew/opt/tmux@3.6/bin/tmux");
		expect(tmux.selectBinary).toHaveBeenCalled();
	});

	it("ignores a saved home-directory path instead of recreating the shim to it", async () => {
		const homeDirectory = "/Users/tester";
		const keg = "/opt/homebrew/opt/tmux@3.6/bin/tmux";
		vi.mocked(loadSettings).mockResolvedValue({
			updateChannel: "stable",
			customBinaryPaths: { tmux: homeDirectory },
		} as any);
		mockSpawnSync.mockReturnValue({ exitCode: 1, stdout: null });
		vi.mocked(existsSync).mockImplementation((path) => [homeDirectory, keg].includes(String(path)));
		vi.mocked(statSync).mockImplementation(((path: string) => ({
			isFile: () => String(path) === keg,
		})) as any);

		const { resolveTmuxBinaryAtStartup } = await import("../rpc-handlers/settings-config");
		const chosen = await resolveTmuxBinaryAtStartup();

		expect(chosen).toBe(keg);
		expect(tmux.selectBinary).toHaveBeenCalledWith(keg, expect.not.arrayContaining([homeDirectory]));
	});

	it("returns undefined when tmux is not found anywhere", async () => {
		mockSpawnSync.mockReturnValue({ exitCode: 1, stdout: null });
		vi.mocked(existsSync).mockReturnValue(false);

		const { resolveTmuxBinaryAtStartup } = await import("../rpc-handlers/settings-config");
		const chosen = await resolveTmuxBinaryAtStartup();
		expect(chosen).toBeUndefined();
		expect(tmux.selectBinary).not.toHaveBeenCalled();
	});
});

// ================================================================
// handlers.checkForUpdate / downloadUpdate / applyUpdate / getAppVersion
// ================================================================

describe("handlers.checkForUpdate", () => {
	beforeEach(() => vi.clearAllMocks());

	it("returns update check result", async () => {
		vi.mocked(loadSettings).mockResolvedValue({ updateChannel: "beta" } as any);
		vi.mocked(updater.checkForUpdateWithChannel).mockResolvedValue({
			updateAvailable: true,
			version: "1.2.3",
		});

		const result = await handlers.checkForUpdate();
		expect(result).toEqual({ updateAvailable: true, version: "1.2.3" });
		expect(updater.checkForUpdateWithChannel).toHaveBeenCalledWith("beta");
	});
});

describe("handlers.downloadUpdate", () => {
	beforeEach(() => vi.clearAllMocks());

	it("downloads update for configured channel", async () => {
		vi.mocked(loadSettings).mockResolvedValue({ updateChannel: "stable" } as any);
		vi.mocked(updater.downloadUpdateForChannel).mockResolvedValue({ ok: true });

		const result = await handlers.downloadUpdate();
		expect(result).toEqual({ ok: true });
		expect(updater.downloadUpdateForChannel).toHaveBeenCalledWith("stable", expect.any(Function));
	});
});

describe("handlers.applyUpdate", () => {
	beforeEach(() => vi.clearAllMocks());

	it("delegates to updater.applyUpdate", async () => {
		await handlers.applyUpdate();
		expect(updater.applyUpdate).toHaveBeenCalledOnce();
	});
});

describe("handlers.getAppVersion", () => {
	beforeEach(() => vi.clearAllMocks());

	it("returns version info", async () => {
		vi.mocked(updater.getLocalVersion).mockResolvedValue({
			version: "0.3.0",
			hash: "abc123",
			channel: "dev",
		});
		vi.mocked(loadSettings).mockResolvedValue({ updateChannel: "beta" } as any);

		const result = await handlers.getAppVersion();
		expect(result).toEqual({
			version: "0.3.0",
			channel: "beta",
			buildChannel: "dev",
		});
	});
});

// ================================================================
// handlers.createLabel
// ================================================================

describe("handlers.createLabel", () => {
	beforeEach(() => vi.clearAllMocks());

	it("creates a label with auto-picked color", async () => {
		const project = makeProject({ labels: [] });
		vi.mocked(data.updateProjectWith).mockImplementation(async (_projectId, mutator) => {
			const { updates, result } = await mutator(project);
			return { project: { ...project, ...updates }, result };
		});

		const label = await handlers.createLabel({ projectId: "proj-1", name: " My Label " });
		expect(label.name).toBe("My Label");
		expect(label.id).toBeTruthy();
		expect(label.color).toBeTruthy();
		expect(data.updateProjectWith).toHaveBeenCalledTimes(1);
	});

	it("uses provided color when specified", async () => {
		const project = makeProject({ labels: [] });
		vi.mocked(data.updateProjectWith).mockImplementation(async (_projectId, mutator) => {
			const { updates, result } = await mutator(project);
			return { project: { ...project, ...updates }, result };
		});

		const label = await handlers.createLabel({ projectId: "proj-1", name: "Bug", color: "#ff0000" });
		expect(label.color).toBe("#ff0000");
	});

	it("skips already-used colors when auto-picking", async () => {
		const project = makeProject({
			labels: [{ id: "l1", name: "L1", color: "#ef4444" }],
		});
		vi.mocked(data.updateProjectWith).mockImplementation(async (_projectId, mutator) => {
			const { updates, result } = await mutator(project);
			return { project: { ...project, ...updates }, result };
		});

		const label = await handlers.createLabel({ projectId: "proj-1", name: "L2" });
		expect(label.color).not.toBe("#ef4444");
	});
});

// ================================================================
// handlers.updateLabel
// ================================================================

describe("handlers.updateLabel", () => {
	beforeEach(() => vi.clearAllMocks());

	it("updates label name", async () => {
		const project = makeProject({
			labels: [{ id: "l1", name: "Old", color: "#ef4444" }],
		});
		vi.mocked(data.updateProjectWith).mockImplementation(async (_projectId, mutator) => {
			const { updates, result } = await mutator(project);
			return { project: { ...project, ...updates }, result };
		});

		const result = await handlers.updateLabel({ projectId: "proj-1", labelId: "l1", name: " New " });
		expect(result.name).toBe("New");
		expect(result.color).toBe("#ef4444");
	});

	it("updates label color", async () => {
		const project = makeProject({
			labels: [{ id: "l1", name: "Bug", color: "#ef4444" }],
		});
		vi.mocked(data.updateProjectWith).mockImplementation(async (_projectId, mutator) => {
			const { updates, result } = await mutator(project);
			return { project: { ...project, ...updates }, result };
		});

		const result = await handlers.updateLabel({ projectId: "proj-1", labelId: "l1", color: "#00ff00" });
		expect(result.color).toBe("#00ff00");
	});

	it("throws when label not found", async () => {
		const project = makeProject({ labels: [] });
		vi.mocked(data.updateProjectWith).mockImplementation(async (_projectId, mutator) => mutator(project) as any);

		await expect(
			handlers.updateLabel({ projectId: "proj-1", labelId: "nonexistent" }),
		).rejects.toThrow("Label not found");
	});
});

// ================================================================
// handlers.deleteLabel
// ================================================================

describe("handlers.deleteLabel", () => {
	beforeEach(() => vi.clearAllMocks());

	it("removes label from project and strips from tasks", async () => {
		const project = makeProject({
			labels: [
				{ id: "l1", name: "Bug", color: "#ef4444" },
				{ id: "l2", name: "Feature", color: "#3b82f6" },
			],
		});
		const tasks = [
			makeTask({ id: "t1", labelIds: ["l1", "l2"] }),
			makeTask({ id: "t2", labelIds: ["l2"] }),
			makeTask({ id: "t3", labelIds: undefined }),
		];

		vi.mocked(data.getProject).mockResolvedValue(project);
		vi.mocked(data.updateProjectWith).mockImplementation(async (_projectId, mutator) => {
			const { updates, result } = await mutator(project);
			return { project: { ...project, ...updates }, result };
		});
		vi.mocked(data.loadTasks).mockResolvedValue(tasks);
		vi.mocked(data.updateTaskWith).mockImplementation(async (_project, taskId, mutator) => {
			const task = tasks.find((candidate) => candidate.id === taskId)!;
			const { updates, result } = await mutator(task);
			Object.assign(task, updates);
			return { task, result };
		});

		await handlers.deleteLabel({ projectId: "proj-1", labelId: "l1" });

		expect(data.updateProjectWith).toHaveBeenCalledTimes(1);
		expect(data.updateTaskWith).toHaveBeenCalledTimes(1);
		expect(tasks[0].labelIds).toEqual(["l2"]);
	});
});

// ================================================================
// handlers.setTaskLabels
// ================================================================

describe("handlers.setTaskLabels", () => {
	beforeEach(() => vi.clearAllMocks());

	it("sets label IDs on a task", async () => {
		const project = makeProject();
		const updated = makeTask({ labelIds: ["l1", "l2"] });
		vi.mocked(data.getProject).mockResolvedValue(project);
		vi.mocked(data.updateTask).mockResolvedValue(updated);

		const result = await handlers.setTaskLabels({ taskId: "task-1", projectId: "proj-1", labelIds: ["l1", "l2"] });
		expect(result.labelIds).toEqual(["l1", "l2"]);
		expect(data.updateTask).toHaveBeenCalledWith(project, "task-1", { labelIds: ["l1", "l2"] });
	});
});

// ================================================================
// handlers.addTaskNote / updateTaskNote / deleteTaskNote
// ================================================================

describe("handlers.addTaskNote", () => {
	beforeEach(() => vi.clearAllMocks());

	it("adds a note with default source 'user'", async () => {
		const project = makeProject();
		const task = makeTask({ notes: [] });
		vi.mocked(data.getProject).mockResolvedValue(project);
		vi.mocked(data.updateTaskWith).mockImplementation(async (_project, _taskId, mutator) => {
			const { updates, result } = await mutator(task);
			return { task: { ...task, ...updates }, result };
		});

		const result = await handlers.addTaskNote({ taskId: "task-1", projectId: "proj-1", content: "Hello" });
		expect(result.notes).toHaveLength(1);
		expect(result.notes?.[0].content).toBe("Hello");
		expect(result.notes?.[0].source).toBe("user");
	});

	it("adds a note with explicit source 'ai'", async () => {
		const project = makeProject();
		const task = makeTask({ notes: [] });
		vi.mocked(data.getProject).mockResolvedValue(project);
		vi.mocked(data.updateTaskWith).mockImplementation(async (_project, _taskId, mutator) => {
			const { updates, result } = await mutator(task);
			return { task: { ...task, ...updates }, result };
		});

		const result = await handlers.addTaskNote({ taskId: "task-1", projectId: "proj-1", content: "AI note", source: "ai" });
		expect(result.notes?.[0].source).toBe("ai");
	});

	it("appends to existing notes", async () => {
		const existingNote = { id: "n0", content: "Old", source: "user" as const, createdAt: "", updatedAt: "" };
		const project = makeProject();
		const task = makeTask({ notes: [existingNote] });
		vi.mocked(data.getProject).mockResolvedValue(project);
		vi.mocked(data.updateTaskWith).mockImplementation(async (_project, _taskId, mutator) => {
			const { updates, result } = await mutator(task);
			return { task: { ...task, ...updates }, result };
		});

		const result = await handlers.addTaskNote({ taskId: "task-1", projectId: "proj-1", content: "New" });
		expect(result.notes).toHaveLength(2);
		expect(result.notes?.[0].content).toBe("Old");
		expect(result.notes?.[1].content).toBe("New");
	});
});

describe("handlers.updateTaskNote", () => {
	beforeEach(() => vi.clearAllMocks());

	it("updates the content of a specific note", async () => {
		const note = { id: "n1", content: "Old", source: "user" as const, createdAt: "2024-01-01", updatedAt: "2024-01-01" };
		const project = makeProject();
		const task = makeTask({ notes: [note] });
		vi.mocked(data.getProject).mockResolvedValue(project);
		vi.mocked(data.updateTaskWith).mockImplementation(async (_project, _taskId, mutator) => {
			const { updates, result } = await mutator(task);
			return { task: { ...task, ...updates }, result };
		});

		const result = await handlers.updateTaskNote({ taskId: "task-1", projectId: "proj-1", noteId: "n1", content: "Updated" });
		expect(result.notes?.[0].content).toBe("Updated");
		expect(result.notes?.[0].id).toBe("n1");
	});

	it("does not modify other notes", async () => {
		const note1 = { id: "n1", content: "Note 1", source: "user" as const, createdAt: "", updatedAt: "" };
		const note2 = { id: "n2", content: "Note 2", source: "ai" as const, createdAt: "", updatedAt: "" };
		const project = makeProject();
		const task = makeTask({ notes: [note1, note2] });
		vi.mocked(data.getProject).mockResolvedValue(project);
		vi.mocked(data.updateTaskWith).mockImplementation(async (_project, _taskId, mutator) => {
			const { updates, result } = await mutator(task);
			return { task: { ...task, ...updates }, result };
		});

		const result = await handlers.updateTaskNote({ taskId: "task-1", projectId: "proj-1", noteId: "n1", content: "Changed" });
		expect(result.notes?.[0].content).toBe("Changed");
		expect(result.notes?.[1].content).toBe("Note 2");
	});
});

describe("handlers.deleteTaskNote", () => {
	beforeEach(() => vi.clearAllMocks());

	it("removes the specified note", async () => {
		const note1 = { id: "n1", content: "Keep", source: "user" as const, createdAt: "", updatedAt: "" };
		const note2 = { id: "n2", content: "Delete", source: "ai" as const, createdAt: "", updatedAt: "" };
		const project = makeProject();
		const task = makeTask({ notes: [note1, note2] });
		vi.mocked(data.getProject).mockResolvedValue(project);
		vi.mocked(data.updateTaskWith).mockImplementation(async (_project, _taskId, mutator) => {
			const { updates, result } = await mutator(task);
			return { task: { ...task, ...updates }, result };
		});

		const result = await handlers.deleteTaskNote({ taskId: "task-1", projectId: "proj-1", noteId: "n2" });
		expect(result.notes).toHaveLength(1);
		expect(result.notes?.[0].id).toBe("n1");
	});
});

// ================================================================
// handlers.killTmuxSession
// ================================================================

describe("handlers.killTmuxSession", () => {
	beforeEach(() => vi.clearAllMocks());

	it("throws when session name doesn't start with dev3-", async () => {
		await expect(
			handlers.killTmuxSession({ sessionName: "other-session" }),
		).rejects.toThrow("Can only kill dev3-* sessions");
	});

	it("kills dev3- session successfully", async () => {
		mockSpawn.mockReturnValue({
			stderr: new Response(""),
			exited: Promise.resolve(0),
		});

		await handlers.killTmuxSession({ sessionName: "dev3-abc12345" });
		expect(mockSpawn).toHaveBeenCalledWith(
			["tmux", "-L", "dev3", "kill-session", "-t", "dev3-abc12345"],
			expect.any(Object),
		);
	});

	it("also kills associated dev server session after killing task session", async () => {
		mockSpawn.mockReturnValue({
			stderr: new Response(""),
			exited: Promise.resolve(0),
		});

		await handlers.killTmuxSession({ sessionName: "dev3-abc12345" });

		const calls = mockSpawn.mock.calls.map((c) => c[0]);
		expect(calls.some((a) => a.includes("kill-session") && a.includes("dev3-abc12345"))).toBe(true);
		expect(calls.some((a) => a.includes("kill-session") && a.includes("dev3-dev-abc12345"))).toBe(true);
	});

	it("does not attempt to kill a nested dev session when killing a dev3-dev- session", async () => {
		mockSpawn.mockReturnValue({
			stderr: new Response(""),
			exited: Promise.resolve(0),
		});

		// dev3-dev- sessions pass the dev3- prefix check but should not recurse
		await handlers.killTmuxSession({ sessionName: "dev3-dev-abc12345" });

		const killCalls = mockSpawn.mock.calls
			.map((c) => c[0] as string[])
			.filter((args) => args.includes("kill-session"));
		// Only the one explicit kill, no secondary kill for a "dev3-dev-dev3-dev-..." session
		expect(killCalls).toHaveLength(1);
		expect(killCalls[0]).toContain("dev3-dev-abc12345");
	});

	it("throws when tmux kill fails", async () => {
		mockSpawn.mockReturnValue({
			stderr: new Response("session not found"),
			exited: Promise.resolve(1),
		});

		await expect(
			handlers.killTmuxSession({ sessionName: "dev3-dead1234" }),
		).rejects.toThrow("Failed to kill session");
	});
});

// ================================================================
// handlers.mergeTask
// ================================================================

describe("handlers.mergeTask", () => {
	beforeEach(() => vi.clearAllMocks());

	it("throws when task has no worktree", async () => {
		const project = makeProject();
		const task = makeTask({ branchName: "dev3/t", worktreePath: null });
		vi.mocked(data.getProject).mockResolvedValue(project);
		vi.mocked(data.getTask).mockResolvedValue(task);

		await expect(
			handlers.mergeTask({ taskId: "task-1", projectId: "proj-1" }),
		).rejects.toThrow("Task has no worktree");
	});

	it("throws when task has no branch (both live and stored are null)", async () => {
		const project = makeProject();
		const task = makeTask({ branchName: null, worktreePath: "/tmp/wt" });
		vi.mocked(data.getProject).mockResolvedValue(project);
		vi.mocked(data.getTask).mockResolvedValue(task);
		vi.mocked(git.getCurrentBranch).mockResolvedValue(null);

		await expect(
			handlers.mergeTask({ taskId: "task-1", projectId: "proj-1" }),
		).rejects.toThrow("Task has no branch");
	});

	it("throws when branch is not rebased", async () => {
		const project = makeProject();
		const task = makeTask({ branchName: "dev3/t", worktreePath: "/tmp/wt" });
		vi.mocked(data.getProject).mockResolvedValue(project);
		vi.mocked(data.getTask).mockResolvedValue(task);
		vi.mocked(git.getCurrentBranch).mockResolvedValue("dev3/t");
		vi.mocked(git.getBranchStatus).mockResolvedValue({ ahead: 1, behind: 2 });

		await expect(
			handlers.mergeTask({ taskId: "task-1", projectId: "proj-1" }),
		).rejects.toThrow("Branch is not rebased");
	});

	it("uses local branch ref for rebase check on task-specific base branches", async () => {
		const project = makeProject();
		const task = makeTask({ branchName: "dev3/t", worktreePath: "/tmp/wt", baseBranch: "feature/abc" });
		vi.mocked(data.getProject).mockResolvedValue(project);
		vi.mocked(data.getTask).mockResolvedValue(task);
		vi.mocked(git.getCurrentBranch).mockResolvedValue("dev3/t");
		vi.mocked(git.getBranchStatus).mockResolvedValue({ ahead: 1, behind: 2 });

		await expect(
			handlers.mergeTask({ taskId: "task-1", projectId: "proj-1" }),
		).rejects.toThrow("Branch is not rebased");

		expect(git.getBranchStatus).toHaveBeenCalledWith(task.worktreePath, "feature/abc");
	});

	it("writes a merge script that targets the task base branch", async () => {
		const project = makeProject({ path: "/tmp/project-root" });
		const task = makeTask({
			id: "task-1",
			title: "Merge task",
			baseBranch: "feature/abc",
			branchName: "dev3/t",
			worktreePath: "/tmp/wt",
		});
		const writeSpy = vi.spyOn(Bun, "write").mockResolvedValue(undefined as never);
		const intervalSpy = vi.spyOn(globalThis, "setInterval").mockReturnValue(0 as any);
		const timeoutSpy = vi.spyOn(globalThis, "setTimeout").mockReturnValue(0 as any);

		vi.mocked(data.getProject).mockResolvedValue(project);
		vi.mocked(data.getTask).mockResolvedValue(task);
		vi.mocked(git.getCurrentBranch).mockResolvedValue("dev3/t");
		vi.mocked(git.fetchOrigin).mockResolvedValue(true);
		vi.mocked(git.getBranchStatus).mockResolvedValue({ ahead: 1, behind: 0 } as any);
		mockSpawn.mockReturnValue({
			stdout: new Response("%42\n"),
			stderr: new Response(""),
			exited: Promise.resolve(0),
		});

		try {
			await handlers.mergeTask({ taskId: "task-1", projectId: "proj-1" });

			const mergeScriptCall = writeSpy.mock.calls.find(([path]) => String(path).endsWith("-git-merge.sh"));
			const script = String(mergeScriptCall?.[1] ?? "");
			const checkoutIndex = script.indexOf('git checkout "$TARGET_BRANCH"');
			const mergeIndex = script.indexOf("git merge --squash dev3/t");

			expect(script).toContain(`TARGET_BRANCH='feature/abc'`);
			expect(script).toContain(`TARGET_REMOTE='origin/feature/abc'`);
			expect(checkoutIndex).toBeGreaterThanOrEqual(0);
			expect(mergeIndex).toBeGreaterThanOrEqual(0);
			expect(checkoutIndex).toBeLessThan(mergeIndex);
		} finally {
			timeoutSpy.mockRestore();
			intervalSpy.mockRestore();
			writeSpy.mockRestore();
		}
	});
});

// ================================================================
// handlers.rebaseTask
// ================================================================

describe("handlers.rebaseTask", () => {
	beforeEach(() => vi.clearAllMocks());

	it("throws when task has no worktree", async () => {
		const project = makeProject();
		const task = makeTask({ worktreePath: null });
		vi.mocked(data.getProject).mockResolvedValue(project);
		vi.mocked(data.getTask).mockResolvedValue(task);

		await expect(
			handlers.rebaseTask({ taskId: "task-1", projectId: "proj-1" }),
		).rejects.toThrow("Task has no worktree");
	});
});

// ================================================================
// handlers.rebaseTaskViaAgent — conflict handoff to the terminal agent
// ================================================================

describe("handlers.rebaseTaskViaAgent", () => {
	function sendKeysCalls() {
		return mockSpawn.mock.calls
			.map((c) => c[0] as string[])
			.filter((args) => args.includes("send-keys"));
	}

	beforeEach(() => vi.clearAllMocks());

	it("sends a rebase prompt to the active pane and reports handedOff", async () => {
		vi.useFakeTimers();
		const project = makeProject();
		const task = makeTask({ id: "task-1", worktreePath: "/tmp/test-worktree" });
		vi.mocked(data.getProject).mockResolvedValue(project);
		vi.mocked(data.getTask).mockResolvedValue(task);
		mockSpawn.mockImplementation((args: string[]) => ({
			stdout: args.includes("display-message") ? "%3\n" : "",
			stderr: "",
			exited: Promise.resolve(0),
		}));

		const result = await handlers.rebaseTaskViaAgent({ taskId: "task-1", projectId: project.id });
		expect(result).toEqual({ handedOff: true });

		const paste = sendKeysCalls();
		expect(paste).toHaveLength(1);
		expect(paste[0]).toEqual(expect.arrayContaining(["send-keys", "-t", "%3"]));
		expect(paste[0]?.some((a) => a.includes("git rebase"))).toBe(true);

		// Enter is sent as a discrete keypress after the shared delay.
		vi.advanceTimersByTime(800);
		const all = sendKeysCalls();
		expect(all).toHaveLength(2);
		expect(all[1]).toEqual(["tmux", "-L", "dev3", "send-keys", "-t", "%3", "Enter"]);
		vi.useRealTimers();
	});

	it("reports handedOff:false when there is no active pane", async () => {
		const project = makeProject();
		const task = makeTask({ id: "task-1", worktreePath: "/tmp/test-worktree" });
		vi.mocked(data.getProject).mockResolvedValue(project);
		vi.mocked(data.getTask).mockResolvedValue(task);
		mockSpawn.mockImplementation(() => ({
			stdout: "",
			stderr: "",
			exited: Promise.resolve(0),
		}));

		const result = await handlers.rebaseTaskViaAgent({ taskId: "task-1", projectId: project.id });
		expect(result).toEqual({ handedOff: false });
		expect(sendKeysCalls()).toHaveLength(0);
	});

	it("throws when the task has no worktree", async () => {
		const project = makeProject();
		const task = makeTask({ id: "task-1", worktreePath: null });
		vi.mocked(data.getProject).mockResolvedValue(project);
		vi.mocked(data.getTask).mockResolvedValue(task);

		await expect(
			handlers.rebaseTaskViaAgent({ taskId: "task-1", projectId: project.id }),
		).rejects.toThrow("Task has no worktree");
	});
});

// ================================================================
// handlers.pushTask
// ================================================================

describe("handlers.pushTask", () => {
	beforeEach(() => vi.clearAllMocks());

	it("throws when task has no worktree", async () => {
		const project = makeProject();
		const task = makeTask({ worktreePath: null });
		vi.mocked(data.getProject).mockResolvedValue(project);
		vi.mocked(data.getTask).mockResolvedValue(task);

		await expect(
			handlers.pushTask({ taskId: "task-1", projectId: "proj-1" }),
		).rejects.toThrow("Task has no worktree");
	});
});

// ================================================================
// handlers.runDevServer
// ================================================================

describe("handlers.tmuxKillPane", () => {
	beforeEach(() => vi.clearAllMocks());

	function killPaneCall() {
		return mockSpawn.mock.calls.map((c) => c[0] as string[]).find((a) => a.includes("kill-pane"));
	}

	it("kills the targeted pane by id when more than one pane exists", async () => {
		mockSpawn
			.mockReturnValueOnce({ stdout: "%1\n%2\n", stderr: new Response(""), exited: Promise.resolve(0) }) // count
			.mockReturnValue({ stdout: "", stderr: new Response(""), exited: Promise.resolve(0) }); // kill-pane

		const res = await handlers.tmuxKillPane({ taskId: "task-1", paneId: "%2" });

		expect(res).toEqual({ killed: true });
		const kill = killPaneCall();
		expect(kill).toBeDefined();
		expect(kill!).toContain("%2");
	});

	it("refuses to kill the last pane without force", async () => {
		mockSpawn.mockReturnValueOnce({ stdout: "%1\n", stderr: new Response(""), exited: Promise.resolve(0) }); // count → 1

		const res = await handlers.tmuxKillPane({ taskId: "task-1", paneId: "%1" });

		expect(res).toEqual({ killed: false });
		expect(killPaneCall()).toBeUndefined();
	});

	it("force-kills the last pane (bypasses the count guard)", async () => {
		mockSpawn.mockReturnValue({ stdout: "", stderr: new Response(""), exited: Promise.resolve(0) });

		const res = await handlers.tmuxKillPane({ taskId: "task-1", paneId: "%1", force: true });

		expect(res).toEqual({ killed: true });
		expect(killPaneCall()).toBeDefined();
		// No list-panes count call when forced.
		expect(mockSpawn.mock.calls.some((c) => (c[0] as string[]).includes("list-panes"))).toBe(false);
	});

	it("rejects a malformed pane id without spawning tmux", async () => {
		const res = await handlers.tmuxKillPane({ taskId: "task-1", paneId: "; rm -rf /" });

		expect(res).toEqual({ killed: false });
		expect(mockSpawn).not.toHaveBeenCalled();
	});
});

describe("handlers.runDevServer", () => {
	beforeEach(() => vi.clearAllMocks());

	it("throws when no dev script configured", async () => {
		const project = makeProject({ devScript: "" });
		const task = makeTask({ worktreePath: "/tmp/wt" });
		vi.mocked(data.getProject).mockResolvedValue(project);
		vi.mocked(data.getTask).mockResolvedValue(task);

		await expect(
			handlers.runDevServer({ taskId: "task-1", projectId: "proj-1" }),
		).rejects.toThrow("No dev script configured");
	});

	it("throws when task has no worktree", async () => {
		const project = makeProject({ devScript: "bun run dev" });
		const task = makeTask({ worktreePath: null });
		vi.mocked(data.getProject).mockResolvedValue(project);
		vi.mocked(data.getTask).mockResolvedValue(task);

		await expect(
			handlers.runDevServer({ taskId: "task-1", projectId: "proj-1" }),
		).rejects.toThrow("Task has no worktree");
	});

	it("resolves devScript from worktree config", async () => {
		const project = makeProject({ devScript: "" });
		const task = makeTask({ worktreePath: "/tmp/wt" });
		vi.mocked(data.getProject).mockResolvedValue(project);
		vi.mocked(data.getTask).mockResolvedValue(task);

		const repoConfig = await import("../repo-config");
		vi.mocked(repoConfig.resolveProjectConfig).mockResolvedValueOnce({
			...project,
			devScript: "bun run dev",
		});

		mockSpawn.mockReturnValue({ stdout: "", stderr: new Response(""), exited: Promise.resolve(0) });

		// Should NOT throw — devScript comes from worktree config
		await handlers.runDevServer({ taskId: task.id, projectId: "proj-1" });

		expect(repoConfig.resolveProjectConfig).toHaveBeenCalledWith(project, "/tmp/wt");
	});

	it("starts new-session -d when no dev server running", async () => {
		const project = makeProject({ devScript: "bun run dev" });
		const task = makeTask({ worktreePath: "/tmp/wt", id: "abcd1234-0000-0000-0000-000000000000" });
		vi.mocked(data.getProject).mockResolvedValue(project);
		vi.mocked(data.getTask).mockResolvedValue(task);

		// Use plain strings — new Response(new Response(...)) loses body in Bun test env
		// and would leave a stale entry in devViewerPaneIds affecting subsequent tests
		mockSpawn.mockReturnValue({ stdout: "", stderr: new Response(""), exited: Promise.resolve(0) });

		await handlers.runDevServer({ taskId: task.id, projectId: "proj-1" });

		const calls = mockSpawn.mock.calls.map((c) => c[0] as string[]);
		// has-session check
		expect(calls.some((a) => a.includes("has-session") && a.includes("dev3-dev-abcd1234"))).toBe(true);
		// new-session -d for dev server
		expect(calls.some((a) => a.includes("new-session") && a.includes("-d") && a.includes("dev3-dev-abcd1234"))).toBe(true);
		// viewer pane split-window
		expect(calls.some((a) => a.includes("split-window") && a.some((s) => s.includes("attach-session")))).toBe(true);
	});

	it("passes DEV3_TASK_ID and DEV3_WORKTREE_ROOT via -e to both new-session and viewer split-window", async () => {
		const project = makeProject({ devScript: "bun run dev" });
		const taskId = "abcd1234-0000-0000-0000-000000000000";
		const task = makeTask({ worktreePath: "/tmp/wt", id: taskId });
		vi.mocked(data.getProject).mockResolvedValue(project);
		vi.mocked(data.getTask).mockResolvedValue(task);

		mockSpawn.mockReturnValue({ stdout: "", stderr: new Response(""), exited: Promise.resolve(0) });

		await handlers.runDevServer({ taskId, projectId: "proj-1" });

		const calls = mockSpawn.mock.calls.map((c) => c[0] as string[]);
		const newSessionCall = calls.find((a) => a.includes("new-session") && a.includes("-d"));
		expect(newSessionCall).toBeDefined();
		expect(newSessionCall!).toContain(`DEV3_TASK_ID=${taskId}`);
		expect(newSessionCall!).toContain(`DEV3_WORKTREE_ROOT=/tmp/wt`);

		const viewerSplitCall = calls.find((a) => a.includes("split-window") && a.some((s) => s.includes("attach-session")));
		expect(viewerSplitCall).toBeDefined();
		expect(viewerSplitCall!).toContain(`DEV3_TASK_ID=${taskId}`);
		expect(viewerSplitCall!).toContain(`DEV3_WORKTREE_ROOT=/tmp/wt`);
	});

	it("returns session and process details after start", async () => {
		const project = makeProject({ devScript: "bun run dev" });
		const task = makeTask({ worktreePath: "/tmp/wt", id: "abcd1234-0000-0000-0000-000000000000" });
		vi.mocked(data.getProject).mockResolvedValue(project);
		vi.mocked(data.getTask).mockResolvedValue(task);
		const portPool = await import("../port-pool");
		vi.spyOn(portPool, "getPortAssignments").mockReturnValue([50001, 55930, 55937]);
		const portScanner = await import("../port-scanner");
		portScanner.clearProcessInfoCache();
		// Route by argv — the spawn sequence now includes async port/process
		// scans and is not stable enough for positional mockReturnValueOnce.
		let hasSessionCalls = 0;
		mockSpawn.mockImplementation((args: string[]) => {
			const proc = (stdout: string, code = 0) => ({ stdout, stderr: new Response(""), exited: Promise.resolve(code) });
			// First has-session (isDevServerRunning) → not running; later ones
			// (buildDevServerStatus after start) → running.
			if (args.includes("has-session")) return proc("", hasSessionCalls++ === 0 ? 1 : 0);
			if (args.includes("split-window")) return proc("%17\n");
			if (args.includes("list-panes") && args.includes("dev3-dev-abcd1234")) return proc("81231\n");
			if (args.includes("list-panes") && args.includes("dev3-abcd1234")) return proc("81230\n");
			if (args[0] === "lsof") return proc("p81231\ncbun\nn*:5173\n");
			if (args[0] === "ps") return proc("81231 1 0 0.0\n");
			return proc("");
		});

		const result = await handlers.runDevServer({ taskId: task.id, projectId: "proj-1" });

		expect(result.running).toBe(true);
		expect(result.devSessionName).toBe("dev3-dev-abcd1234");
		expect(result.viewerPaneId).toBe("%17");
		expect(result.panePids).toEqual([81231]);
		expect(result.assignedPorts).toEqual([50001, 55930, 55937]);
		expect(result.ports).toEqual([{ port: 5173, pid: 81231, processName: "bun" }]);
	});

	it("reports assigned task ports separately from detected listeners", async () => {
		const project = makeProject({ devScript: "bun run dev" });
		const task = makeTask({ worktreePath: "/tmp/wt", id: "abcd1234-0000-0000-0000-000000000000" });
		vi.mocked(data.getProject).mockResolvedValue(project);
		vi.mocked(data.getTask).mockResolvedValue(task);
		const portPool = await import("../port-pool");
		vi.spyOn(portPool, "getPortAssignments").mockReturnValue([50001, 55930, 55937]);
		mockSpawn
			.mockReturnValueOnce({ stdout: "", stderr: new Response(""), exited: Promise.resolve(1) }) // has-session -> not running
			.mockReturnValueOnce({ stdout: "", stderr: new Response(""), exited: Promise.resolve(0) }) // new-session
			.mockReturnValueOnce({ stdout: "%17\n", stderr: new Response(""), exited: Promise.resolve(0) }) // split-window
			.mockReturnValueOnce({ stdout: "", stderr: new Response(""), exited: Promise.resolve(0) }) // has-session in buildDevServerStatus
			.mockReturnValue({ stdout: "", stderr: new Response(""), exited: Promise.resolve(0) });
		mockSpawnSync.mockImplementation((args: string[]) => {
			if (args.includes("list-panes") && args.includes("dev3-dev-abcd1234")) {
				return { exitCode: 0, stdout: Buffer.from("81231\n"), stderr: Buffer.from("") };
			}
			if (args.includes("list-panes") && args.includes("dev3-abcd1234")) {
				return { exitCode: 0, stdout: Buffer.from("71230\n"), stderr: Buffer.from("") };
			}
			return { exitCode: 1, stdout: Buffer.from(""), stderr: Buffer.from("") };
		});
		const portScanner = await import("../port-scanner");
		vi.spyOn(portScanner, "getPortsForTask").mockReturnValue([
			{ port: 50001, pid: 81232, processName: "bun" },
			{ port: 55930, pid: 81232, processName: "bun" },
			{ port: 55937, pid: 81232, processName: "bun" },
			{ port: 56206, pid: 62042, processName: "bun" },
		]);

		const result = await handlers.runDevServer({ taskId: task.id, projectId: "proj-1" });

		expect(result.assignedPorts).toEqual([50001, 55930, 55937]);
		expect(result.ports).toEqual([
			{ port: 50001, pid: 81232, processName: "bun" },
			{ port: 55930, pid: 81232, processName: "bun" },
			{ port: 55937, pid: 81232, processName: "bun" },
			{ port: 56206, pid: 62042, processName: "bun" },
		]);
	});

	it("kills existing dev session before starting a new one", async () => {
		const project = makeProject({ devScript: "bun run dev" });
		const task = makeTask({ worktreePath: "/tmp/wt", id: "abcd1234-0000-0000-0000-000000000000" });
		vi.mocked(data.getProject).mockResolvedValue(project);
		vi.mocked(data.getTask).mockResolvedValue(task);

		mockSpawn
			.mockReturnValueOnce({ stdout: "", stderr: new Response(""), exited: Promise.resolve(0) }) // has-session → running
			.mockReturnValue({ stdout: "", stderr: new Response(""), exited: Promise.resolve(0) }); // rest succeed

		await handlers.runDevServer({ taskId: task.id, projectId: "proj-1" });

		const calls = mockSpawn.mock.calls.map((c) => c[0] as string[]);
		expect(calls.some((a) => a.includes("kill-session") && a.includes("dev3-dev-abcd1234"))).toBe(true);
		expect(calls.some((a) => a.includes("new-session") && a.includes("-d"))).toBe(true);
	});

	it("kills viewer pane (from map) before dev session on restart to prevent trap race", async () => {
		// First runDevServer: records viewer pane ID "%42" in the map
		const project = makeProject({ devScript: "bun run dev" });
		const task = makeTask({ worktreePath: "/tmp/wt", id: "abcd1234-0000-0000-0000-000000000000" });
		vi.mocked(data.getProject).mockResolvedValue(project);
		vi.mocked(data.getTask).mockResolvedValue(task);

		// Use plain string for split-window stdout — new Response(new Response(...)) loses body in Bun test env.
		// Routed by argv: positional sequencing breaks now that async port/process
		// scans interleave extra spawn calls.
		mockSpawn.mockImplementation((args: string[]) => {
			const proc = (stdout: string, code = 0) => ({ stdout, stderr: new Response(""), exited: Promise.resolve(code) });
			if (args.includes("has-session")) return proc("", 1); // not running
			if (args.includes("split-window")) return proc("%42\n"); // viewer pane ID
			return proc("");
		});

		await handlers.runDevServer({ taskId: task.id, projectId: "proj-1" });

		vi.clearAllMocks();

		// Second call (restart): has-session=running → kill-pane %42, then kill-session, then new-session
		const portScanner = await import("../port-scanner");
		portScanner.clearProcessInfoCache();
		// Every command succeeds (has-session exit 0 → running); async process
		// scans in killDevServerSession get empty output and find nothing.
		mockSpawn.mockReturnValue({ stdout: "", stderr: new Response(""), exited: Promise.resolve(0) });

		await handlers.runDevServer({ taskId: task.id, projectId: "proj-1" });

		const calls = mockSpawn.mock.calls.map((c) => c[0] as string[]);
		const killPaneIdx = calls.findIndex((a) => a.includes("kill-pane") && a.includes("%42"));
		const killSessionIdx = calls.findIndex((a) => a.includes("kill-session") && a.includes("dev3-dev-abcd1234"));
		expect(killPaneIdx).toBeGreaterThanOrEqual(0);
		expect(killSessionIdx).toBeGreaterThanOrEqual(0);
		expect(killPaneIdx).toBeLessThan(killSessionIdx);
	});

	it("kills viewer pane via list-panes fallback when map is empty (after app restart)", async () => {
		// Simulate app restart: map is empty, but the task session has a pane running attach-session
		const project = makeProject({ devScript: "bun run dev" });
		const task = makeTask({ worktreePath: "/tmp/wt", id: "abcd1234-0000-0000-0000-000000000000" });
		vi.mocked(data.getProject).mockResolvedValue(project);
		vi.mocked(data.getTask).mockResolvedValue(task);

		// has-session → running; the TASK session's list-panes returns a pane
		// running attach-session for dev3-dev-abcd1234 (the viewer). The dev
		// session's own list-panes (tree-pid snapshot) returns nothing.
		// Routed by argv — positional sequencing breaks with async scans.
		const portScanner = await import("../port-scanner");
		portScanner.clearProcessInfoCache();
		mockSpawn.mockImplementation((args: string[]) => {
			const proc = (stdout: string, code = 0) => ({ stdout, stderr: new Response(""), exited: Promise.resolve(code) });
			if (args.includes("has-session")) return proc(""); // running
			if (args.includes("list-panes") && args.includes("dev3-abcd1234")) {
				return proc("%99\tTMUX= tmux attach-session -t dev3-dev-abcd1234\n");
			}
			return proc("");
		});

		await handlers.runDevServer({ taskId: task.id, projectId: "proj-1" });

		const calls = mockSpawn.mock.calls.map((c) => c[0] as string[]);
		const killPaneIdx = calls.findIndex((a) => a.includes("kill-pane") && a.includes("%99"));
		const killSessionIdx = calls.findIndex((a) => a.includes("kill-session") && a.includes("dev3-dev-abcd1234"));
		expect(killPaneIdx).toBeGreaterThanOrEqual(0);
		expect(killSessionIdx).toBeGreaterThanOrEqual(0);
		expect(killPaneIdx).toBeLessThan(killSessionIdx);
	});


	it("throws when tmux new-session fails", async () => {
		const project = makeProject({ devScript: "bun run dev" });
		const task = makeTask({ worktreePath: "/tmp/wt" });
		vi.mocked(data.getProject).mockResolvedValue(project);
		vi.mocked(data.getTask).mockResolvedValue(task);

		mockSpawn
			.mockReturnValueOnce({ stdout: new Response(""), stderr: new Response(""), exited: Promise.resolve(1) }) // has-session → not running
			.mockReturnValue({ stdout: new Response(""), stderr: new Response("port in use"), exited: Promise.resolve(1) });

		await expect(
			handlers.runDevServer({ taskId: task.id, projectId: "proj-1" }),
		).rejects.toThrow("tmux new-session failed");
	});
});

// ================================================================
// handlers.getDevServerStatus
// ================================================================

describe("handlers.getDevServerStatus", () => {
	beforeEach(() => vi.clearAllMocks());

	it("degrades gracefully when tmux fails to launch (no crash, carries diagnostic)", async () => {
		const project = makeProject({ devScript: "bun run dev" });
		const task = makeTask({ worktreePath: "/tmp/wt", id: "abcd1234-0000-0000-0000-000000000000" });
		vi.mocked(data.getProject).mockResolvedValue(project);
		vi.mocked(data.getTask).mockResolvedValue(task);

		// isDevServerRunning's tmux spawn throws synchronously (Bun.spawn ENOENT)
		// — e.g. macOS Full Disk Access lost mid-session. The client wraps the
		// raw throw into a typed TmuxSpawnError.
		mockSpawn.mockImplementationOnce(() => {
			throw new Error("ENOENT: posix_spawn '/opt/homebrew/bin/tmux'");
		});

		const status = await handlers.getDevServerStatus({ taskId: task.id, projectId: "proj-1" });

		expect(status.tmuxError).toBeDefined();
		expect(status.tmuxError).toContain("tmux failed to spawn");
		// Live state is unknown, not authoritatively "running", and tmux-derived
		// fields are empty rather than throwing.
		expect(status.running).toBe(false);
		expect(status.taskId).toBe(task.id);
		expect(status.devSessionName).toBe("dev3-dev-abcd1234");
		expect(status.panePids).toEqual([]);
		expect(status.ports).toEqual([]);
	});

	it("rethrows non-tmux errors (a data-layer failure is not masked)", async () => {
		vi.mocked(data.getProject).mockRejectedValue(new Error("db error"));

		await expect(
			handlers.getDevServerStatus({ taskId: "task-1", projectId: "proj-1" }),
		).rejects.toThrow("db error");
	});

	it("reports a clean stopped status (no tmuxError) when tmux launches fine", async () => {
		const project = makeProject({ devScript: "bun run dev" });
		const task = makeTask({ worktreePath: "/tmp/wt", id: "abcd1234-0000-0000-0000-000000000000" });
		vi.mocked(data.getProject).mockResolvedValue(project);
		vi.mocked(data.getTask).mockResolvedValue(task);

		// has-session exits non-zero → not running; every other spawn is empty.
		mockSpawn.mockReturnValue({ stdout: "", stderr: new Response(""), exited: Promise.resolve(1) });

		const status = await handlers.getDevServerStatus({ taskId: task.id, projectId: "proj-1" });

		expect(status.tmuxError).toBeUndefined();
		expect(status.running).toBe(false);
	});
});

// ================================================================
// handlers.checkDevServer
// ================================================================

describe("handlers.checkDevServer", () => {
	beforeEach(() => vi.clearAllMocks());

	it("returns { running: true } when has-session exits 0", async () => {
		const project = makeProject();
		const task = makeTask({ id: "abcd1234-0000-0000-0000-000000000000" });
		vi.mocked(data.getProject).mockResolvedValue(project);
		vi.mocked(data.getTask).mockResolvedValue(task);

		mockSpawn.mockReturnValue({ stdout: new Response(""), stderr: new Response(""), exited: Promise.resolve(0) });

		const result = await handlers.checkDevServer({ taskId: task.id, projectId: "proj-1" });
		expect(result).toEqual({ running: true });
		expect(mockSpawn).toHaveBeenCalledWith(
			expect.arrayContaining(["has-session", "-t", "dev3-dev-abcd1234"]),
			expect.any(Object),
		);
	});

	it("returns { running: false } when has-session exits non-zero", async () => {
		const project = makeProject();
		const task = makeTask({ id: "abcd1234-0000-0000-0000-000000000000" });
		vi.mocked(data.getProject).mockResolvedValue(project);
		vi.mocked(data.getTask).mockResolvedValue(task);

		mockSpawn.mockReturnValue({ stdout: new Response(""), stderr: new Response(""), exited: Promise.resolve(1) });

		const result = await handlers.checkDevServer({ taskId: task.id, projectId: "proj-1" });
		expect(result).toEqual({ running: false });
	});

	it("returns { running: false } on exception", async () => {
		vi.mocked(data.getProject).mockRejectedValue(new Error("db error"));

		const result = await handlers.checkDevServer({ taskId: "task-1", projectId: "proj-1" });
		expect(result).toEqual({ running: false });
	});
});

// ================================================================
// handlers.stopDevServer
// ================================================================

describe("handlers.stopDevServer", () => {
	beforeEach(() => vi.clearAllMocks());

	it("kills dev server session and disables pane-border-status", async () => {
		const project = makeProject();
		const task = makeTask({ id: "abcd1234-0000-0000-0000-000000000000" });
		vi.mocked(data.getProject).mockResolvedValue(project);
		vi.mocked(data.getTask).mockResolvedValue(task);

		mockSpawn
			.mockReturnValueOnce({ stdout: "", stderr: new Response(""), exited: Promise.resolve(0) }) // list-panes fallback
			.mockReturnValueOnce({ stdout: "", stderr: new Response(""), exited: Promise.resolve(0) }) // kill-session
			.mockReturnValueOnce({ stdout: "", stderr: new Response(""), exited: Promise.resolve(0) }) // set-option
			.mockReturnValueOnce({ stdout: "", stderr: new Response(""), exited: Promise.resolve(1) }); // has-session after stop

		const result = await handlers.stopDevServer({ taskId: task.id, projectId: "proj-1" });

		const calls = mockSpawn.mock.calls.map((c) => c[0] as string[]);
		expect(calls.some((a) => a.includes("kill-session") && a.includes("dev3-dev-abcd1234"))).toBe(true);
		expect(calls.some((a) => a.includes("set-option") && a.includes("pane-border-status") && a.includes("off"))).toBe(true);
		expect(result.running).toBe(false);
	});

	it("reaps the dev server's orphaned child process tree, not just the tmux session", async () => {
		// Regression: the Stop button used to only `tmux kill-session`, which SIGHUPs
		// the pane's foreground shell but leaves deep children (vite / electrobun +
		// the launched .app) running. We must SIGTERM/SIGKILL the whole descendant
		// tree captured from the dev session before teardown.
		const project = makeProject();
		const task = makeTask({ id: "abcd1234-0000-0000-0000-000000000000" });
		vi.mocked(data.getProject).mockResolvedValue(project);
		vi.mocked(data.getTask).mockResolvedValue(task);

		// dev session pane pid = 1111, with children 2222 and 3333 (no grandchildren).
		// Descendants are collected from a single `ps` snapshot, not `pgrep -P`
		// (which returns nothing from the packaged .app — decision 095).
		// has-session reports "not running" so buildDevServerStatus short-circuits.
		const portScanner = await import("../port-scanner");
		portScanner.clearProcessInfoCache();
		mockSpawn.mockImplementation((args: string[]) => {
			const proc = (stdout: string, code = 0) => ({ stdout, stderr: new Response(""), exited: Promise.resolve(code) });
			if (args.includes("has-session")) return proc("", 1);
			if (args.includes("list-panes") && args.includes("dev3-dev-abcd1234")) return proc("1111\n");
			if (args[0] === "ps") return proc("1111 1 0 0.0\n2222 1111 0 0.0\n3333 1111 0 0.0\n");
			return proc("");
		});

		const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
		vi.useFakeTimers();
		// Capture calls before mockRestore() — restoring a spy also clears its
		// recorded calls, so snapshot them while the spy is still live.
		let killCalls: [number | NodeJS.Signals, ...unknown[]][] = [];
		try {
			const pending = handlers.stopDevServer({ taskId: task.id, projectId: "proj-1" });
			// The kill spy never throws, so liveness probes (signal 0) report every
			// pid as alive forever — teardown must exhaust the full verified path:
			// SIGTERM grace poll (1.5s) + SIGKILL wait poll (2s). Drive past both.
			await vi.advanceTimersByTimeAsync(4000);
			await pending;
			killCalls = [...killSpy.mock.calls] as typeof killCalls;
		} finally {
			vi.useRealTimers();
			killSpy.mockRestore();
		}

		const killedPids = killCalls.map((c) => c[0]);
		// Both children (and the pane shell) must have been signalled.
		expect(killedPids).toContain(1111);
		expect(killedPids).toContain(2222);
		expect(killedPids).toContain(3333);
		// And escalated to SIGKILL for survivors.
		expect(killCalls.some((c) => c[0] === 2222 && c[1] === "SIGKILL")).toBe(true);
	});

	it("throws when kill-session fails", async () => {
		const project = makeProject();
		const task = makeTask();
		vi.mocked(data.getProject).mockResolvedValue(project);
		vi.mocked(data.getTask).mockResolvedValue(task);

		mockSpawn.mockReturnValue({ stdout: new Response(""), stderr: new Response("not found"), exited: Promise.resolve(1) });

		// kill-session exit code is ignored (best-effort), so it should not throw
		await expect(
			handlers.stopDevServer({ taskId: task.id, projectId: "proj-1" }),
		).resolves.toMatchObject({ running: false, taskId: task.id });
	});

	it("throws when data lookup fails", async () => {
		vi.mocked(data.getProject).mockRejectedValue(new Error("not found"));

		await expect(
			handlers.stopDevServer({ taskId: "task-1", projectId: "proj-1" }),
		).rejects.toThrow("not found");
	});
});

// ================================================================
// handlers.listTmuxSessions (dev server filtering)
// ================================================================

describe("handlers.listTmuxSessions", () => {
	beforeEach(() => vi.clearAllMocks());

	it("does not load projects or tasks when tmux server is unavailable", async () => {
		mockSpawn.mockReturnValue({
			stdout: "",
			stderr: new Response("failed to connect to server"),
			exited: Promise.resolve(1),
		});

		const result = await handlers.listTmuxSessions();

		expect(result).toEqual([]);
		expect(data.loadProjects).not.toHaveBeenCalled();
		expect(data.loadTasks).not.toHaveBeenCalled();
	});

	it("skips task loading when only project terminal sessions exist", async () => {
		const project = makeProject({ id: "a1c9fe4e-full-uuid", name: "dev-3.0" });
		vi.mocked(data.loadProjects).mockResolvedValue([project]);
		mockSpawn.mockReturnValue({
			stdout: "dev3-pt-a1c9fe4e\t1\t1700000001\t/tmp/project",
			stderr: new Response(""),
			exited: Promise.resolve(0),
		});

		const result = await handlers.listTmuxSessions();

		expect(result).toHaveLength(1);
		expect(result[0]).toMatchObject({
			name: "dev3-pt-a1c9fe4e",
			projectId: "a1c9fe4e-full-uuid",
			projectName: "dev-3.0",
			isProjectTerminal: true,
		});
		expect(data.loadProjects).toHaveBeenCalledOnce();
		expect(data.loadTasks).not.toHaveBeenCalled();
	});

	it("filters out dev3-dev-* sessions", async () => {
		vi.mocked(data.loadProjects).mockResolvedValue([]);
		// stdout must be a plain string — new Response(Response) does not propagate the body
		mockSpawn.mockReturnValue({
			stdout: "dev3-abc12345\t1\t1700000001\t/tmp/wt\ndev3-dev-abc12345\t1\t1700000002\t/tmp/wt\ndev3-xyz99999\t1\t1700000000\t/tmp/wt",
			stderr: new Response(""),
			exited: Promise.resolve(0),
		});

		const result = await handlers.listTmuxSessions();
		const names = result.map((s) => s.name);
		expect(names).toContain("dev3-abc12345");
		expect(names).toContain("dev3-xyz99999");
		expect(names).not.toContain("dev3-dev-abc12345");
	});

	it("uses customTitle over auto-generated title when present", async () => {
		const project = makeProject();
		const task = makeTask({
			id: "abc12345-full-uuid-here",
			title: "Auto-generated title from description",
			customTitle: "Short custom title",
		});
		vi.mocked(data.loadProjects).mockResolvedValue([project]);
		vi.mocked(data.loadTasks).mockResolvedValue([task]);
		mockSpawn.mockReturnValue({
			stdout: "dev3-abc12345\t1\t1700000001\t/tmp/wt",
			stderr: new Response(""),
			exited: Promise.resolve(0),
		});

		const result = await handlers.listTmuxSessions();
		expect(result).toHaveLength(1);
		expect(result[0].taskTitle).toBe("Short custom title");
	});

	it("falls back to auto-generated title when customTitle is not set", async () => {
		const project = makeProject();
		const task = makeTask({
			id: "abc12345-full-uuid-here",
			title: "Auto-generated title",
			customTitle: null,
		});
		vi.mocked(data.loadProjects).mockResolvedValue([project]);
		vi.mocked(data.loadTasks).mockResolvedValue([task]);
		mockSpawn.mockReturnValue({
			stdout: "dev3-abc12345\t1\t1700000001\t/tmp/wt",
			stderr: new Response(""),
			exited: Promise.resolve(0),
		});

		const result = await handlers.listTmuxSessions();
		expect(result).toHaveLength(1);
		expect(result[0].taskTitle).toBe("Auto-generated title");
	});
});

// ================================================================
// handlers.tmuxAction
// ================================================================

describe("handlers.tmuxAction", () => {
	beforeEach(() => vi.clearAllMocks());

	it("sends split-window -v for splitH action", async () => {
		mockSpawn.mockReturnValue({
			stderr: new Response(""),
			stdout: new Response(""),
			exited: Promise.resolve(0),
		});

		await handlers.tmuxAction({ taskId: "abcd1234-full-id", action: "splitH" });
		// -c must carry a session_path fallback: tmux 3.7 on macOS sometimes
		// reports an empty pane_current_path (unreadable foreground cwd), and a
		// bare #{pane_current_path} then expands to "" — tmux falls back to the
		// split CLIENT's cwd, i.e. the app bundle dir, opening the pane there.
		expect(mockSpawn).toHaveBeenCalledWith(
			["tmux", "-L", "dev3", "split-window", "-v", "-t", "dev3-abcd1234", "-c", "#{?pane_current_path,#{pane_current_path},#{session_path}}"],
			expect.any(Object),
		);
	});

	it("sends split-window -h for splitV action", async () => {
		mockSpawn.mockReturnValue({
			stderr: new Response(""),
			stdout: new Response(""),
			exited: Promise.resolve(0),
		});

		await handlers.tmuxAction({ taskId: "abcd1234-full-id", action: "splitV" });
		expect(mockSpawn).toHaveBeenCalledWith(
			["tmux", "-L", "dev3", "split-window", "-h", "-t", "dev3-abcd1234", "-c", "#{?pane_current_path,#{pane_current_path},#{session_path}}"],
			expect.any(Object),
		);
	});

	it("sends even-vertical layout for layoutEvenH action", async () => {
		mockSpawn.mockReturnValue({
			stderr: new Response(""),
			stdout: new Response(""),
			exited: Promise.resolve(0),
		});

		await handlers.tmuxAction({ taskId: "abcd1234-full-id", action: "layoutEvenH" });
		expect(mockSpawn).toHaveBeenCalledWith(
			["tmux", "-L", "dev3", "select-layout", "-t", "dev3-abcd1234", "even-vertical"],
			expect.any(Object),
		);
	});

	it("sends even-horizontal layout for layoutEvenV action", async () => {
		mockSpawn.mockReturnValue({
			stderr: new Response(""),
			stdout: new Response(""),
			exited: Promise.resolve(0),
		});

		await handlers.tmuxAction({ taskId: "abcd1234-full-id", action: "layoutEvenV" });
		expect(mockSpawn).toHaveBeenCalledWith(
			["tmux", "-L", "dev3", "select-layout", "-t", "dev3-abcd1234", "even-horizontal"],
			expect.any(Object),
		);
	});

	it("sends resize-pane -Z for zoom action", async () => {
		mockSpawn.mockReturnValue({
			stderr: new Response(""),
			stdout: new Response(""),
			exited: Promise.resolve(0),
		});

		await handlers.tmuxAction({ taskId: "abcd1234-full-id", action: "zoom" });
		expect(mockSpawn).toHaveBeenCalledWith(
			["tmux", "-L", "dev3", "resize-pane", "-Z", "-t", "dev3-abcd1234"],
			expect.any(Object),
		);
	});

	it("throws when tmux command fails", async () => {
		mockSpawn.mockReturnValue({
			stderr: new Response("no session"),
			stdout: new Response(""),
			exited: Promise.resolve(1),
		});

		await expect(
			handlers.tmuxAction({ taskId: "abcd1234-full-id", action: "zoom" }),
		).rejects.toThrow("tmux zoom failed");
	});

	it("killPane refuses to kill the last remaining pane in the session", async () => {
		// list-panes returns a single pane → killPane must NOT call kill-pane
		mockSpawn.mockImplementation((args: string[]) => {
			if (args.includes("list-panes")) {
				return {
					stderr: new Response("").body,
					stdout: new Response("%1\n").body,
					exited: Promise.resolve(0),
				};
			}
			return {
				stderr: new Response("").body,
				stdout: new Response("").body,
				exited: Promise.resolve(0),
			};
		});

		await handlers.tmuxAction({ taskId: "abcd1234-full-id", action: "killPane" });

		const spawnCalls = mockSpawn.mock.calls.map((c) => c[0] as string[]);
		expect(spawnCalls.some((a) => a.includes("kill-pane"))).toBe(false);
	});

	it("killPane proceeds normally when more than one pane exists", async () => {
		mockSpawn.mockImplementation((args: string[]) => {
			if (args.includes("list-panes")) {
				return {
					stderr: new Response("").body,
					stdout: new Response("%1\n%2\n").body,
					exited: Promise.resolve(0),
				};
			}
			if (args.includes("display-message")) {
				return {
					stderr: new Response("").body,
					stdout: new Response("%2\n").body,
					exited: Promise.resolve(0),
				};
			}
			return {
				stderr: new Response("").body,
				stdout: new Response("").body,
				exited: Promise.resolve(0),
			};
		});

		await handlers.tmuxAction({ taskId: "abcd1234-full-id", action: "killPane" });

		expect(mockSpawn).toHaveBeenCalledWith(
			["tmux", "-L", "dev3", "kill-pane", "-t", "dev3-abcd1234"],
			expect.any(Object),
		);
	});

	it("killPane with force=true kills even the last remaining pane and skips the pane-count check", async () => {
		mockSpawn.mockImplementation((args: string[]) => {
			if (args.includes("display-message")) {
				return {
					stderr: new Response("").body,
					stdout: new Response("%1\n").body,
					exited: Promise.resolve(0),
				};
			}
			return {
				stderr: new Response("").body,
				stdout: new Response("").body,
				exited: Promise.resolve(0),
			};
		});

		await handlers.tmuxAction({ taskId: "abcd1234-full-id", action: "killPane", force: true });

		const spawnCalls = mockSpawn.mock.calls.map((c) => c[0] as string[]);
		expect(spawnCalls.some((a) => a.includes("list-panes"))).toBe(false);
		expect(spawnCalls.some((a) => a.includes("kill-pane"))).toBe(true);
	});
});

// ================================================================
// handlers.tmuxPaneCount
// ================================================================

describe("handlers.tmuxPaneCount", () => {
	beforeEach(() => vi.clearAllMocks());

	it("returns the number of panes reported by list-panes", async () => {
		mockSpawn.mockImplementation((args: string[]) => {
			if (args.includes("list-panes")) {
				return {
					stderr: new Response("").body,
					stdout: new Response("%1\n%2\n%3\n").body,
					exited: Promise.resolve(0),
				};
			}
			return {
				stderr: new Response("").body,
				stdout: new Response("").body,
				exited: Promise.resolve(1),
			};
		});

		const result = await handlers.tmuxPaneCount({ taskId: "abcd1234-full-id" });
		expect(result).toEqual({ count: 3 });
	});

	it("returns 1 when only one pane exists", async () => {
		mockSpawn.mockImplementation((args: string[]) => {
			if (args.includes("list-panes")) {
				return {
					stderr: new Response("").body,
					stdout: new Response("%1\n").body,
					exited: Promise.resolve(0),
				};
			}
			return {
				stderr: new Response("").body,
				stdout: new Response("").body,
				exited: Promise.resolve(1),
			};
		});

		const result = await handlers.tmuxPaneCount({ taskId: "abcd1234-full-id" });
		expect(result).toEqual({ count: 1 });
	});

	it("returns 0 when list-panes fails", async () => {
		mockSpawn.mockImplementation(() => ({
			stderr: new Response("session not found").body,
			stdout: new Response("").body,
			exited: Promise.resolve(1),
		}));

		const result = await handlers.tmuxPaneCount({ taskId: "abcd1234-full-id" });
		expect(result).toEqual({ count: 0 });
	});
});

// ================================================================
// handlers.exitCopyModeAllPanes
// ================================================================

describe("handlers.exitCopyModeAllPanes", () => {
	beforeEach(() => vi.clearAllMocks());

	// Spawn router: matches by tmux subcommand so individual tests can declare
	// what each tmux command should return without ordering fragility.
	function setupSpawnRouter(routes: {
		hasSession?: number; // exit code for has-session (dev-server check)
		listTaskPanes?: { exit: number; out: string };
		listDevPanes?: { exit: number; out: string };
	}) {
		mockSpawn.mockImplementation((args: string[]) => {
			const sub = args[3]; // ["tmux", "-L", "dev3", <subcommand>, ...]
			const sessionArg = args[args.indexOf("-t") + 1] ?? "";

			if (sub === "has-session") {
				return {
					stderr: new Response("").body,
					stdout: new Response("").body,
					exited: Promise.resolve(routes.hasSession ?? 1),
				};
			}
			if (sub === "list-panes") {
				const route = sessionArg.startsWith("dev3-dev-") ? routes.listDevPanes : routes.listTaskPanes;
				return {
					stderr: new Response("").body,
					stdout: new Response(route?.out ?? "").body,
					exited: Promise.resolve(route?.exit ?? 0),
				};
			}
			// send-keys etc. — always succeed
			return {
				stderr: new Response("").body,
				stdout: new Response("").body,
				exited: Promise.resolve(0),
			};
		});
	}

	it("sends -X cancel only to panes currently in copy-mode", async () => {
		vi.mocked(pty.tmuxSessionExists).mockResolvedValue(true);
		setupSpawnRouter({
			hasSession: 1, // dev-server not running
			listTaskPanes: { exit: 0, out: "%0\t1\n%1\t0\n%2\t1\n" },
		});

		const result = await handlers.exitCopyModeAllPanes({ taskId: "abcd1234-full-id" });

		expect(result).toEqual({ panesExited: 2 });
		expect(mockSpawn).toHaveBeenCalledWith(
			["tmux", "-L", "dev3", "list-panes", "-s", "-t", "dev3-abcd1234", "-F", "#{pane_id}\t#{pane_in_mode}"],
			expect.any(Object),
		);
		expect(mockSpawn).toHaveBeenCalledWith(
			["tmux", "-L", "dev3", "send-keys", "-t", "%0", "-X", "cancel"],
			expect.any(Object),
		);
		expect(mockSpawn).toHaveBeenCalledWith(
			["tmux", "-L", "dev3", "send-keys", "-t", "%2", "-X", "cancel"],
			expect.any(Object),
		);
		// %1 was not in copy-mode → no cancel sent for it
		expect(mockSpawn).not.toHaveBeenCalledWith(
			["tmux", "-L", "dev3", "send-keys", "-t", "%1", "-X", "cancel"],
			expect.any(Object),
		);
	});

	it("also cleans the dev-server session (dev3-dev-<id>)", async () => {
		vi.mocked(pty.tmuxSessionExists).mockResolvedValue(true);
		setupSpawnRouter({
			hasSession: 0, // dev-server IS running
			listTaskPanes: { exit: 0, out: "%10\t0\n" },
			listDevPanes: { exit: 0, out: "%99\t1\n" }, // dev-server pane in copy-mode
		});

		const result = await handlers.exitCopyModeAllPanes({ taskId: "abcd1234-full-id" });

		expect(result).toEqual({ panesExited: 1 });
		expect(mockSpawn).toHaveBeenCalledWith(
			["tmux", "-L", "dev3", "list-panes", "-s", "-t", "dev3-dev-abcd1234", "-F", "#{pane_id}\t#{pane_in_mode}"],
			expect.any(Object),
		);
		expect(mockSpawn).toHaveBeenCalledWith(
			["tmux", "-L", "dev3", "send-keys", "-t", "%99", "-X", "cancel"],
			expect.any(Object),
		);
	});

	it("no-op when neither task nor dev-server session exists", async () => {
		vi.mocked(pty.tmuxSessionExists).mockResolvedValue(false);
		setupSpawnRouter({ hasSession: 1 });

		const result = await handlers.exitCopyModeAllPanes({ taskId: "abcd1234-full-id" });

		expect(result).toEqual({ panesExited: 0 });
		// Only the has-session check (for dev-server) was spawned; no list-panes
		expect(mockSpawn).not.toHaveBeenCalledWith(
			expect.arrayContaining(["list-panes"]),
			expect.any(Object),
		);
	});

	it("returns zero when no pane is in copy-mode", async () => {
		vi.mocked(pty.tmuxSessionExists).mockResolvedValue(true);
		setupSpawnRouter({
			hasSession: 1,
			listTaskPanes: { exit: 0, out: "%0 0\n%1 0\n" },
		});

		const result = await handlers.exitCopyModeAllPanes({ taskId: "abcd1234-full-id" });

		expect(result).toEqual({ panesExited: 0 });
		expect(mockSpawn).not.toHaveBeenCalledWith(
			expect.arrayContaining(["send-keys"]),
			expect.any(Object),
		);
	});

	it("returns zero when list-panes fails", async () => {
		vi.mocked(pty.tmuxSessionExists).mockResolvedValue(true);
		setupSpawnRouter({
			hasSession: 1,
			listTaskPanes: { exit: 1, out: "" },
		});

		const result = await handlers.exitCopyModeAllPanes({ taskId: "abcd1234-full-id" });

		expect(result).toEqual({ panesExited: 0 });
	});
});

// ================================================================
// handlers.getProjectPtyUrl / destroyProjectTerminal
// ================================================================

describe("handlers.getProjectPtyUrl", () => {
	beforeEach(() => vi.clearAllMocks());

	it("creates a project PTY session and returns ws URL", async () => {
		const project = makeProject({ path: "/tmp/test-project" });
		(data.getProject as any).mockResolvedValue(project);
		vi.mocked(pty.hasSession).mockReturnValue(false);
		vi.mocked(pty.hasDeadSession).mockReturnValue(false);
		vi.mocked(existsSync).mockReturnValue(true);

		const url = await handlers.getProjectPtyUrl({ projectId: project.id });

		expect(pty.createSession).toHaveBeenCalledWith(
			`project-${project.id}`,
			project.id,
			"/tmp/test-project",
			process.env.SHELL || "/bin/zsh",
			{},
			"dev3",
			"project",
		);
		expect(url).toBe(`ws://localhost:9999?session=project-${project.id}`);
	});

	it("reuses existing session without creating a new one", async () => {
		const project = makeProject();
		vi.mocked(pty.hasSession).mockReturnValue(true);
		vi.mocked(pty.hasDeadSession).mockReturnValue(false);

		await handlers.getProjectPtyUrl({ projectId: project.id });

		expect(pty.createSession).not.toHaveBeenCalled();
	});

	it("destroys dead session before creating a new one", async () => {
		const project = makeProject({ path: "/tmp/proj" });
		(data.getProject as any).mockResolvedValue(project);
		vi.mocked(pty.hasDeadSession).mockReturnValue(true);
		// hasSession is called twice: once in the log, once for the guard
		vi.mocked(pty.hasSession).mockReturnValue(false);
		vi.mocked(existsSync).mockReturnValue(true);

		await handlers.getProjectPtyUrl({ projectId: project.id });

		expect(pty.destroySession).toHaveBeenCalledWith(`project-${project.id}`);
		expect(pty.createSession).toHaveBeenCalled();
	});
});

describe("handlers.destroyProjectTerminal", () => {
	beforeEach(() => vi.clearAllMocks());

	it("destroys the project terminal session", async () => {
		await handlers.destroyProjectTerminal({ projectId: "proj-123" });
		expect(pty.destroySession).toHaveBeenCalledWith("project-proj-123");
	});
});

// ================================================================
// handlers.openQuickShell (replaces the removed home terminal)
// ================================================================

describe("handlers.openQuickShell", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.mocked(data.getProject).mockReset();
		vi.mocked(data.getTask).mockReset();
		vi.mocked(data.updateTask).mockReset();
		vi.mocked(loadSettings).mockResolvedValue({ updateChannel: "stable", taskDropPosition: "top" } as any);
		mockSpawn.mockReturnValue({ exited: Promise.resolve(0) });
	});

	it("creates a fresh scratch op in the built-in board, launched in-progress", async () => {
		const project = makeProject({ id: "ops1", kind: "virtual", path: "/tmp/test-dev3/ops/operations", builtin: true });
		const created = makeTask({ id: "qs1", projectId: "ops1", status: "todo", worktreePath: null, scratch: true });
		vi.mocked(data.ensureBuiltinOperationsBoard).mockResolvedValue(project);
		vi.mocked(data.addTask).mockResolvedValue(created);
		vi.mocked(data.getProject).mockResolvedValue(project);
		mockTaskWrites(created);

		const result = await handlers.openQuickShell({});

		// Scratch op, no custom "Quick shell" identity, no home dir.
		expect(data.addTask).toHaveBeenCalledWith(
			project,
			expect.stringMatching(/^Scratch — /),
			"todo",
			{ scratch: true },
		);
		expect(result.status).toBe("in-progress");
		expect(result.projectId).toBe("ops1");
		expect(git.createWorktree).not.toHaveBeenCalled();
	});

	it("creates a NEW op every call — no singleton reuse of an existing one", async () => {
		const project = makeProject({ id: "ops1", kind: "virtual", path: "/tmp/test-dev3/ops/operations", builtin: true });
		const existing = makeTask({ id: "old", projectId: "ops1", status: "in-progress", scratch: true });
		const created = makeTask({ id: "fresh", projectId: "ops1", status: "todo", worktreePath: null, scratch: true });
		vi.mocked(data.ensureBuiltinOperationsBoard).mockResolvedValue(project);
		vi.mocked(data.loadTasks).mockResolvedValue([existing]);
		vi.mocked(data.addTask).mockResolvedValue(created);
		vi.mocked(data.getProject).mockResolvedValue(project);
		mockTaskWrites(created);

		const result = await handlers.openQuickShell({});

		expect(data.addTask).toHaveBeenCalled();
		expect(result.id).toBe("fresh");
	});
});

describe("addVirtualShellPane — focus lands on the agent pane", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockSpawn.mockImplementation((args: string[]) => {
			if (args.includes("has-session")) return { exited: Promise.resolve(0) };
			if (args.includes("split-window")) return { stdout: "%9", stderr: "", exited: Promise.resolve(0) };
			return { stdout: "", stderr: "", exited: Promise.resolve(0) };
		});
	});

	it("selects the agent pane (.0) LAST so the user lands on the agent, not the split shell", async () => {
		const task = makeTask({ id: "abcdef12-0000-0000-0000-000000000000", projectId: "ops1" });
		await addVirtualShellPane(task, "/tmp/work", "dev3", "/bin/zsh");

		const session = `dev3-${task.id.slice(0, 8)}`;
		const selectCalls = mockSpawn.mock.calls
			.map((c) => c[0] as string[])
			.filter((a) => a.includes("select-pane"));

		// Regression: previously the shell title was set last, so `select-pane -t`
		// left focus on the freshly-split shell. The agent pane must be selected last.
		const last = selectCalls[selectCalls.length - 1];
		expect(last).toBeDefined();
		expect(last[last.indexOf("-t") + 1]).toBe(`${session}.0`);
	});
});

describe("handlers.removeProject with project terminal", () => {
	beforeEach(() => vi.clearAllMocks());

	it("destroys project terminal when removing a project", async () => {
		vi.mocked(pty.hasSession).mockReturnValue(true);
		vi.mocked(data.removeProject).mockResolvedValue(undefined);
		await handlers.removeProject({ projectId: "proj-1" });
		expect(pty.destroySession).toHaveBeenCalledWith("project-proj-1");
		expect(data.removeProject).toHaveBeenCalledWith("proj-1");
	});
});

// ================================================================
// handlers.spawnAgentInTask
// ================================================================

describe("handlers.spawnAgentInTask", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		(globalThis as any).Bun.write = vi.fn().mockResolvedValue(undefined);
	});

	it("spawns agent with split-window -h in the tmux session", async () => {
		const project = makeProject();
		const task = makeTask({ id: "abcd1234-full-id", worktreePath: "/tmp/wt" });
		const updatedTask = { ...task, agentId: "builtin-claude", configId: "claude-default" };
		const push = vi.fn();
		setPushMessage(push);
		(data.getProject as any).mockResolvedValue(project);
		(data.getTask as any).mockResolvedValue(task);
		(data.updateTask as any).mockResolvedValue(updatedTask);
		(agents.resolveCommandForAgent as any).mockResolvedValue({ command: "claude --resume", extraEnv: { FOO: "bar" } });
		mockSpawn.mockReturnValue({ stderr: new Response(""), stdout: new Response(""), exited: Promise.resolve(0) });

		await handlers.spawnAgentInTask({ taskId: "abcd1234-full-id", projectId: "proj-1", agentId: "builtin-claude", configId: "claude-default" });

		expect(agents.resolveCommandForAgent).toHaveBeenCalledWith("builtin-claude", "claude-default", expect.objectContaining({ worktreePath: "/tmp/wt" }), expect.objectContaining({ sessionId: expect.any(String) }));
		expect(mockSpawn).toHaveBeenCalledWith(
			expect.arrayContaining(["tmux", "-L", "dev3", "split-window", "-h", "-c", "/tmp/wt", "-t", "dev3-abcd1234"]),
			expect.any(Object),
		);
		// split-window must carry -e DEV3_TASK_ID=... so the new column-agent
		// pane doesn't inherit a stale DEV3_TASK_ID from the tmux server's
		// global env (which is whichever task started the server first).
		const splitCall = mockSpawn.mock.calls.find(
			(c) => Array.isArray(c[0]) && c[0].includes("split-window") && c[0].includes("-h"),
		);
		expect(splitCall).toBeDefined();
		expect(splitCall![0]).toContain("DEV3_TASK_ID=abcd1234-full-id");
		expect(splitCall![0]).toContain("DEV3_WORKTREE_ROOT=/tmp/wt");
		const [, script] = (globalThis as any).Bun.write.mock.calls[0];
		expect(script).toContain("export DEV3_ARTIFACT_TEMPLATE_DIR='/tmp/test-dev3/artifact-template-v1'");
		expect(data.updateTask).toHaveBeenCalledWith(project, task.id, expect.objectContaining({
			agentId: "builtin-claude",
			configId: "claude-default",
		}));
		expect(push).toHaveBeenCalledWith("taskUpdated", { projectId: project.id, task: updatedTask });
	});

	it("uses resolveCommandForProject when agentId is null", async () => {
		const project = makeProject();
		const task = makeTask({ id: "abcd1234-full-id", worktreePath: "/tmp/wt" });
		(data.getProject as any).mockResolvedValue(project);
		(data.getTask as any).mockResolvedValue(task);
		(agents.resolveCommandForProject as any).mockResolvedValue({ command: "claude", extraEnv: {} });
		mockSpawn.mockReturnValue({ stderr: new Response(""), stdout: new Response(""), exited: Promise.resolve(0) });

		await handlers.spawnAgentInTask({ taskId: "abcd1234-full-id", projectId: "proj-1", agentId: null, configId: null });

		expect(agents.resolveCommandForProject).toHaveBeenCalled();
		expect(agents.resolveCommandForAgent).not.toHaveBeenCalled();
	});

	it("throws when task has no worktree", async () => {
		const project = makeProject();
		const task = makeTask({ worktreePath: null });
		(data.getProject as any).mockResolvedValue(project);
		(data.getTask as any).mockResolvedValue(task);

		await expect(
			handlers.spawnAgentInTask({ taskId: "task-1", projectId: "proj-1", agentId: null, configId: null }),
		).rejects.toThrow("Task has no worktree");
	});

	it("throws when tmux split-window fails", async () => {
		const project = makeProject();
		const task = makeTask({ id: "abcd1234-full-id", worktreePath: "/tmp/wt" });
		(data.getProject as any).mockResolvedValue(project);
		(data.getTask as any).mockResolvedValue(task);
		(agents.resolveCommandForAgent as any).mockResolvedValue({ command: "claude", extraEnv: {} });
		mockSpawn.mockReturnValue({ stderr: new Response("no session"), stdout: new Response(""), exited: Promise.resolve(1) });

		await expect(
			handlers.spawnAgentInTask({ taskId: "abcd1234-full-id", projectId: "proj-1", agentId: "builtin-claude", configId: null }),
		).rejects.toThrow("Failed to spawn agent");
	});

	// Regression: the primary launch path re-patches ~/.codex/config.toml via
	// ensureCodexTrust before every codex launch (strips the legacy
	// [profiles.dev3-*] tables codex ≥0.134 rejects). Spawning an extra Codex
	// agent used to skip that step, so the pane crashed with
	// "--profile dev3-dark cannot be used while config.toml contains legacy profile".
	it("ensures Codex trust before spawning a Codex agent", async () => {
		const project = makeProject();
		const task = makeTask({ id: "abcd1234-full-id", worktreePath: "/tmp/codex-wt" });
		(data.getProject as any).mockResolvedValue(project);
		(data.getTask as any).mockResolvedValue(task);
		(agents.resolveCommandForAgent as any).mockResolvedValue({
			command: "codex -p dev3-dark",
			extraEnv: {},
			config: { baseCommandOverride: "codex" },
		});
		mockSpawn.mockReturnValue({ stderr: new Response(""), stdout: new Response(""), exited: Promise.resolve(0) });

		await handlers.spawnAgentInTask({ taskId: "abcd1234-full-id", projectId: "proj-1", agentId: "builtin-codex", configId: null });

		expect(agents.ensureCodexTrust).toHaveBeenCalledWith("/tmp/codex-wt");
	});

	it("ensures Claude trust before spawning any agent", async () => {
		const project = makeProject();
		const task = makeTask({ id: "abcd1234-full-id", worktreePath: "/tmp/wt" });
		(data.getProject as any).mockResolvedValue(project);
		(data.getTask as any).mockResolvedValue(task);
		(agents.resolveCommandForAgent as any).mockResolvedValue({ command: "claude --resume", extraEnv: {} });
		mockSpawn.mockReturnValue({ stderr: new Response(""), stdout: new Response(""), exited: Promise.resolve(0) });

		await handlers.spawnAgentInTask({ taskId: "abcd1234-full-id", projectId: "proj-1", agentId: "builtin-claude", configId: "claude-default" });

		// 3rd arg is the per-launch accountId (undefined here → registry default).
		expect(agents.ensureClaudeTrust).toHaveBeenCalledWith("/tmp/wt", project.path, undefined);
	});
});

// ================================================================
// handlers.spawnBugHuntersInTask
// ================================================================

describe("handlers.spawnBugHuntersInTask", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.useFakeTimers();
		(globalThis as any).Bun.write = vi.fn().mockResolvedValue(undefined);
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	function makeSplitMock(paneIds: string[]) {
		let i = 0;
		const enc = new TextEncoder();
		mockSpawn.mockImplementation((args: string[]) => {
			const isSplit = args.includes("split-window");
			if (isSplit) {
				const pane = paneIds[i++] ?? `%99`;
				return { stderr: enc.encode(""), stdout: enc.encode(pane), exited: Promise.resolve(0) };
			}
			return { stderr: enc.encode(""), stdout: enc.encode(""), exited: Promise.resolve(0) };
		});
	}

	it("creates N panes: first horizontal 50% off the session, rest vertical off the previous right pane", async () => {
		const project = makeProject();
		const task = makeTask({ id: "abcd1234-full-id", worktreePath: "/tmp/wt" });
		(data.getProject as any).mockResolvedValue(project);
		(data.getTask as any).mockResolvedValue(task);
		(agents.resolveCommandForAgent as any).mockResolvedValue({ command: "claude", extraEnv: {} });
		makeSplitMock(["%10", "%11", "%12"]);

		const result = await handlers.spawnBugHuntersInTask({ taskId: "abcd1234-full-id", projectId: "proj-1", agentId: "builtin-claude", configId: "claude-default", count: 3 });

		expect(result).toEqual({ spawned: 3 });

		const splitCalls = mockSpawn.mock.calls
			.map((c) => c[0] as string[])
			.filter((args) => args.includes("split-window"));
		expect(splitCalls).toHaveLength(3);

		// First split: -h -l 50% targeting the session
		expect(splitCalls[0]).toEqual(expect.arrayContaining(["split-window", "-h", "-l", "50%", "-t", "dev3-abcd1234"]));
		// Second split: -v -l 67% (so new pane = 67% of target, target shrinks to 33%)
		expect(splitCalls[1]).toEqual(expect.arrayContaining(["split-window", "-v", "-l", "67%", "-t", "%10"]));
		// Third split: -v -l 50% on the previous new pane (gives ~33/33/33 in right column)
		expect(splitCalls[2]).toEqual(expect.arrayContaining(["split-window", "-v", "-l", "50%", "-t", "%11"]));

		// We must NOT call select-layout — it operates on the whole window and would
		// collapse the main left pane to 1/N of the window height.
		const layoutCalls = mockSpawn.mock.calls.map((c) => c[0] as string[]).filter((args) => args.includes("select-layout"));
		expect(layoutCalls).toHaveLength(0);
		const writtenScripts = (globalThis as any).Bun.write.mock.calls.map(([, script]: [string, string]) => script);
		expect(writtenScripts).toHaveLength(3);
		for (const script of writtenScripts) {
			expect(script).toContain("export DEV3_ARTIFACT_TEMPLATE_DIR='/tmp/test-dev3/artifact-template-v1'");
		}

		// After 5s the auto-paste of /dev3-bug-hunter happens. The prompt MUST
		// lock the hunter to changes in this branch only — otherwise hunters
		// would roam the whole codebase, which is not the intent in the local
		// lightbox path. Prompt and Enter are sent as TWO separate send-keys
		// calls (paste, then Enter after a delay) so Claude does not treat the
		// trailing Enter as a newline inside a bracketed paste.
		vi.advanceTimersByTime(5100);
		const pasteCalls = mockSpawn.mock.calls
			.map((c) => c[0] as string[])
			.filter((args) => args.includes("send-keys") && !args.includes("Enter"));
		expect(pasteCalls).toHaveLength(3);
		for (const args of pasteCalls) {
			const prompt = args[args.length - 1];
			expect(prompt).toContain("/dev3-bug-hunter");
			expect(prompt).toContain("read-only helper inside a task owned by the main agent");
			expect(prompt).toContain("Do NOT run the dev3 session-start checklist");
			expect(prompt).toContain("The only permitted dev3 write is `dev3 note add`");
			expect(prompt).toContain("Scope is locked to THIS branch only");
			// Must pin the fork point via merge-base, not diff against the ref
			// directly — otherwise an un-rebased branch pulls in unrelated files
			// that were only changed on origin.
			expect(prompt).toContain("git merge-base origin/main HEAD");
			expect(prompt).toContain('git diff --name-only "$BASE" HEAD');
			expect(prompt).not.toContain("origin/main...HEAD");
			expect(prompt).toContain("dev3/task-test");
			// In-task hunters must route findings to the main agent via dev3
			// notes — their on-screen report is trapped in their own pane.
			expect(prompt).toContain("record it as dev3 notes instead");
			expect(prompt).toContain("dev3 note add");
			expect(prompt).toContain("[bug-hunt]");
			expect(prompt).toContain("do NOT create any");
		}

		// Enter not pressed yet.
		const enterCallsBeforeDelay = mockSpawn.mock.calls.map((c) => c[0] as string[]).filter((args) => args.includes("send-keys") && args.includes("Enter"));
		expect(enterCallsBeforeDelay).toHaveLength(0);

		// After another 800ms the Enter goes in as a discrete keypress.
		vi.advanceTimersByTime(900);
		const enterCalls = mockSpawn.mock.calls.map((c) => c[0] as string[]).filter((args) => args.includes("send-keys") && args.includes("Enter"));
		expect(enterCalls).toHaveLength(3);
		for (const args of enterCalls) {
			expect(args[args.length - 1]).toBe("Enter");
		}
	});

	it("preserves the task assignment while attributing the hunter pane", async () => {
		const project = makeProject();
		let persistedTask = makeTask({
			id: "abcd1234-full-id",
			worktreePath: "/tmp/wt",
			agentId: "primary-agent",
			configId: "primary-config",
		});
		(data.getProject as any).mockResolvedValue(project);
		(data.getTask as any).mockImplementation(async () => persistedTask);
		(data.updateTask as any).mockImplementation(async (_project: Project, _taskId: string, patch: Partial<Task>) => {
			persistedTask = { ...persistedTask, ...patch };
			return persistedTask;
		});
		(agents.resolveCommandForAgent as any).mockResolvedValue({
			command: "claude",
			extraEnv: {},
			agent: { id: "hunter-agent", baseCommand: "claude" },
			config: { id: "hunter-config" },
		});
		makeSplitMock(["%10"]);

		await handlers.spawnBugHuntersInTask({
			taskId: persistedTask.id,
			projectId: project.id,
			agentId: "hunter-agent",
			configId: "hunter-config",
			count: 1,
		});

		expect(persistedTask).toMatchObject({
			agentId: "primary-agent",
			configId: "primary-config",
			sessionState: {
				panes: [
					expect.objectContaining({
						paneId: "%10",
						agentId: "hunter-agent",
						configId: "hunter-config",
					}),
				],
			},
		});
	});

	it("pastes the `$dev3-bug-hunter` prefix for Codex agents", async () => {
		const project = makeProject();
		const task = makeTask({ id: "abcd1234-full-id", worktreePath: "/tmp/wt" });
		(data.getProject as any).mockResolvedValue(project);
		(data.getTask as any).mockResolvedValue(task);
		(agents.resolveCommandForAgent as any).mockResolvedValue({ command: "codex", extraEnv: {}, agent: { baseCommand: "codex" } });
		makeSplitMock(["%10", "%11"]);

		await handlers.spawnBugHuntersInTask({ taskId: "abcd1234-full-id", projectId: "proj-1", agentId: "builtin-codex", configId: "codex-default", count: 2 });

		vi.advanceTimersByTime(5100);
		const pasteCalls = mockSpawn.mock.calls
			.map((c) => c[0] as string[])
			.filter((args) => args.includes("send-keys") && !args.includes("Enter"));
		expect(pasteCalls).toHaveLength(2);
		for (const args of pasteCalls) {
			const prompt = args[args.length - 1];
			expect(prompt).toContain("$dev3-bug-hunter");
			expect(prompt).not.toContain("/dev3-bug-hunter");
		}
	});

	it("honors the project's configured compareRef in the hunter prompt", async () => {
		const project = makeProject({ defaultCompareRef: "upstream/release" });
		const task = makeTask({ id: "abcd1234-full-id", worktreePath: "/tmp/wt" });
		(data.getProject as any).mockResolvedValue(project);
		(data.getTask as any).mockResolvedValue(task);
		(agents.resolveCommandForAgent as any).mockResolvedValue({ command: "claude", extraEnv: {} });
		makeSplitMock(["%10"]);

		await handlers.spawnBugHuntersInTask({ taskId: "abcd1234-full-id", projectId: "proj-1", agentId: "builtin-claude", configId: "claude-default", count: 1 });

		vi.advanceTimersByTime(5100);
		const pasteCalls = mockSpawn.mock.calls
			.map((c) => c[0] as string[])
			.filter((args) => args.includes("send-keys") && !args.includes("Enter"));
		expect(pasteCalls).toHaveLength(1);
		const prompt = pasteCalls[0][pasteCalls[0].length - 1];
		expect(prompt).toContain("git merge-base upstream/release HEAD");
		expect(prompt).not.toContain("origin/main");
	});

	it("uses local base branch when defaultCompareRefMode is 'local'", async () => {
		const project = makeProject({ defaultCompareRefMode: "local" });
		const task = makeTask({ id: "abcd1234-full-id", worktreePath: "/tmp/wt" });
		(data.getProject as any).mockResolvedValue(project);
		(data.getTask as any).mockResolvedValue(task);
		(agents.resolveCommandForAgent as any).mockResolvedValue({ command: "claude", extraEnv: {} });
		makeSplitMock(["%10"]);

		await handlers.spawnBugHuntersInTask({ taskId: "abcd1234-full-id", projectId: "proj-1", agentId: "builtin-claude", configId: "claude-default", count: 1 });

		vi.advanceTimersByTime(5100);
		const pasteCalls = mockSpawn.mock.calls
			.map((c) => c[0] as string[])
			.filter((args) => args.includes("send-keys") && !args.includes("Enter"));
		const prompt = pasteCalls[0][pasteCalls[0].length - 1];
		expect(prompt).toContain("git merge-base main HEAD");
		expect(prompt).not.toContain("origin/main");
	});

	it("clamps count to 1..6", async () => {
		const project = makeProject();
		const task = makeTask({ id: "abcd1234-full-id", worktreePath: "/tmp/wt" });
		(data.getProject as any).mockResolvedValue(project);
		(data.getTask as any).mockResolvedValue(task);
		(agents.resolveCommandForProject as any).mockResolvedValue({ command: "claude", extraEnv: {} });
		makeSplitMock(["%a", "%b", "%c", "%d", "%e", "%f", "%g"]);

		const result = await handlers.spawnBugHuntersInTask({ taskId: "abcd1234-full-id", projectId: "proj-1", agentId: null, configId: null, count: 99 });

		expect(result.spawned).toBe(6);
		const splitCalls = mockSpawn.mock.calls.map((c) => c[0] as string[]).filter((args) => args.includes("split-window"));
		expect(splitCalls).toHaveLength(6);
	});

	it("throws when task has no worktree", async () => {
		const project = makeProject();
		const task = makeTask({ worktreePath: null });
		(data.getProject as any).mockResolvedValue(project);
		(data.getTask as any).mockResolvedValue(task);

		await expect(
			handlers.spawnBugHuntersInTask({ taskId: "task-1", projectId: "proj-1", agentId: null, configId: null, count: 3 }),
		).rejects.toThrow("no worktree");
	});
});

describe("launchTaskPty", () => {
	beforeEach(async () => {
		vi.clearAllMocks();
		// getUserShell caches the resolved login shell module-wide. Tests in
		// this block toggle process.env.SHELL, so reset the cache to honor it.
		const shellEnv = await import("../shell-env");
		shellEnv._resetUserShellCacheForTests();
	});

	it("injects the absolute task-local artifact starter path into the session", async () => {
		const project = makeProject();
		const task = makeTask();

		await launchTaskPty(project, task, "/tmp/wt", "builtin-claude", "claude-default");

		expect(pty.createSession).toHaveBeenCalledWith(
			task.id,
			project.id,
			"/tmp/wt",
			expect.any(String),
			expect.objectContaining({
				DEV3_ARTIFACT_TEMPLATE_DIR: "/tmp/test-dev3/artifact-template-v1",
			}),
			expect.any(String),
		);
	});

	it("does not append manual review instructions for Claude launches when automatic review is enabled", async () => {
		const project = makeProject({ autoReviewEnabled: true });
		const task = makeTask({ description: "Touch a text file and say hello world" });

		await launchTaskPty(project, task, "/tmp/wt", "builtin-claude", "claude-default");

		expect(agents.resolveCommandForAgent).toHaveBeenCalledWith(
			"builtin-claude",
			"claude-default",
			expect.objectContaining({
				taskDescription: "Touch a text file and say hello world",
			}),
			expect.objectContaining({ sessionId: expect.any(String) }),
		);
	});

	it("waits for setup completion before opening the agent pane in blocking mode", async () => {
		process.env.SHELL = "/bin/zsh";
		const project = makeProject({
			setupScript: "bun install",
			...( { setupScriptLaunchMode: "blocking" } as any ),
		});
		const task = makeTask();
		const writeSpy = vi.spyOn(Bun, "write").mockResolvedValue(undefined as never);

		try {
			await launchTaskPty(project, task, "/tmp/wt", "builtin-claude", "claude-default", true);

			const startupCall = writeSpy.mock.calls.find(([path]) => String(path).endsWith("-startup.sh"));
			const script = String(startupCall?.[1] ?? "");
			const setupIndex = script.indexOf(`'${process.env.SHELL}' -x '${process.env.DEV3_TEST_ROOT}/dev3-task-1-setup.sh'`);
			const splitIndex = script.indexOf(`tmux split-window -v -c "/tmp/wt" "'${process.env.SHELL}' '${process.env.DEV3_TEST_ROOT}/dev3-task-1-cmd.sh'"`);

			expect(setupIndex).toBeGreaterThanOrEqual(0);
			expect(splitIndex).toBeGreaterThanOrEqual(0);
			expect(setupIndex).toBeLessThan(splitIndex);
		} finally {
			writeSpy.mockRestore();
		}
	});

	it("opens the agent pane immediately in parallel mode", async () => {
		process.env.SHELL = "/bin/zsh";
		const project = makeProject({
			setupScript: "bun install",
			...( { setupScriptLaunchMode: "parallel" } as any ),
		});
		const task = makeTask();
		const writeSpy = vi.spyOn(Bun, "write").mockResolvedValue(undefined as never);

		try {
			await launchTaskPty(project, task, "/tmp/wt", "builtin-claude", "claude-default", true);

			const startupCall = writeSpy.mock.calls.find(([path]) => String(path).endsWith("-startup.sh"));
			const script = String(startupCall?.[1] ?? "");
			const splitIndex = script.indexOf(`tmux split-window -v -c "/tmp/wt" "'${process.env.SHELL}' '${process.env.DEV3_TEST_ROOT}/dev3-task-1-cmd.sh'"`);
			const setupIndex = script.indexOf(`'${process.env.SHELL}' -x '${process.env.DEV3_TEST_ROOT}/dev3-task-1-setup.sh'`);

			expect(splitIndex).toBeGreaterThanOrEqual(0);
			expect(setupIndex).toBeGreaterThanOrEqual(0);
			expect(splitIndex).toBeLessThan(setupIndex);
		} finally {
			writeSpy.mockRestore();
		}
	});

	it("pre-registers the exact worktree as trusted before launching Codex", async () => {
		const project = makeProject();
		const task = makeTask();
		mockSpawnSync.mockReturnValue({
			exitCode: 0,
			stdout: new TextEncoder().encode("/usr/local/bin/codex\n"),
			stderr: new Uint8Array(),
		});
		(agents.resolveCommandForAgent as any).mockResolvedValueOnce({
			command: "codex",
			extraEnv: {},
			agent: { baseCommand: "codex" },
			config: {},
		});

		await launchTaskPty(project, task, "/tmp/codex-wt", "builtin-codex", "codex-default");

		expect((agents as any).ensureCodexTrust).toHaveBeenCalledWith("/tmp/codex-wt");
	});

	it("persists the initial Codex pane ID before its first lifecycle hook", async () => {
		const project = makeProject();
		const task = makeTask({ agentId: "builtin-codex", configId: "codex-default" });
		(agents.resolveCommandForAgent as any).mockResolvedValueOnce({
			command: "codex --model gpt-test",
			extraEnv: {},
			agent: { baseCommand: "codex" },
			config: {},
		});
		vi.mocked(pty.listPaneIds).mockResolvedValueOnce(["%42"]);

		await launchTaskPty(project, task, "/tmp/codex-wt", "builtin-codex", "codex-default");

		expect(data.updateTask).toHaveBeenLastCalledWith(project, task.id, {
			sessionState: {
				panes: [{
					paneId: "%42",
					agentCmd: "codex",
					sessionId: null,
					agentId: "builtin-codex",
					configId: "codex-default",
				}],
			},
		});
	});

	it("adds the generated Codex hook override only to the launched session", async () => {
		const project = makeProject();
		const task = makeTask();
		mockSpawnSync.mockReturnValue({
			exitCode: 0,
			stdout: new TextEncoder().encode("/usr/local/bin/codex\n"),
			stderr: new Uint8Array(),
		});
		const writeSpy = vi.spyOn(Bun, "write").mockResolvedValue(undefined as never);
		(agents.resolveCommandForAgent as any).mockResolvedValueOnce({
			command: "codex --model gpt-test -- 'Run the task'",
			extraEnv: {},
			agent: { baseCommand: "codex" },
			config: {},
		});
		vi.mocked(setupAgentHooks).mockResolvedValueOnce("hooks={Stop=[]}");

		try {
			await launchTaskPty(project, task, "/tmp/codex-wt", "builtin-codex", "codex-default");

			const runCall = writeSpy.mock.calls.find(([path]) => String(path).endsWith("-run.sh"));
			expect(String(runCall?.[1] ?? "")).toContain("codex -c 'hooks={Stop=[]}' --model gpt-test -- 'Run the task'");
		} finally {
			writeSpy.mockRestore();
		}
	});

	it("places the Codex hook override before the resume subcommand", async () => {
		const project = makeProject();
		const task = makeTask();
		const writeSpy = vi.spyOn(Bun, "write").mockResolvedValue(undefined as never);
		mockSpawnSync.mockReturnValue({
			exitCode: 0,
			stdout: new TextEncoder().encode("/usr/local/bin/codex\n"),
			stderr: new Uint8Array(),
		});
		(agents.resolveCommandForAgent as any).mockResolvedValueOnce({
			command: "codex resume --last --model gpt-test",
			extraEnv: {},
			agent: { baseCommand: "codex" },
			config: {},
		});
		vi.mocked(setupAgentHooks).mockResolvedValueOnce("hooks={Stop=[]}");

		try {
			await launchTaskPty(project, task, "/tmp/codex-wt", "builtin-codex", "codex-default", false, true);

			const runCall = writeSpy.mock.calls.find(([path]) => String(path).endsWith("-run.sh"));
			expect(String(runCall?.[1] ?? "")).toContain("codex -c 'hooks={Stop=[]}' resume --last --model gpt-test");
		} finally {
			writeSpy.mockRestore();
		}
	});

	it("throws without creating a PTY session when command resolution fails", async () => {
		const project = makeProject();
		const task = makeTask();
		vi.mocked(agents.resolveCommandForAgent).mockRejectedValueOnce(new Error("resolve boom"));

		await expect(
			launchTaskPty(project, task, "/tmp/wt", "builtin-claude", "claude-default"),
		).rejects.toThrow("resolve boom");

		expect(pty.createSession).not.toHaveBeenCalled();
	});

	it("rejects a launch when the tmux client exits without creating a session", async () => {
		vi.useFakeTimers();
		const project = makeProject();
		const task = makeTask();
		vi.mocked(pty.tmuxSessionExists).mockResolvedValue(false);

		try {
			const launch = launchTaskPty(project, task, "/tmp/wt", "builtin-claude", "claude-default");
			const rejection = expect(launch).rejects.toThrow(
				"tmux started but did not create session dev3-task-1",
			);
			await vi.runAllTimersAsync();
			await rejection;
			expect(pty.tmuxSessionExists).toHaveBeenCalledTimes(10);
		} finally {
			vi.useRealTimers();
			vi.mocked(pty.tmuxSessionExists).mockResolvedValue(true);
		}
	});

	it("continues launching when ensureClaudeTrust fails", async () => {
		const project = makeProject();
		const task = makeTask();
		vi.mocked(agents.ensureClaudeTrust).mockRejectedValueOnce(new Error("trust boom"));

		await launchTaskPty(project, task, "/tmp/wt", "builtin-claude", "claude-default");

		expect(pty.createSession).toHaveBeenCalledOnce();
	});

	it("continues launching when setupAgentHooks throws", async () => {
		const project = makeProject();
		const task = makeTask();
		vi.mocked(setupAgentHooks).mockImplementationOnce(() => {
			throw new Error("hooks boom");
		});

		await launchTaskPty(project, task, "/tmp/wt", "builtin-claude", "claude-default");

		expect(pty.createSession).toHaveBeenCalledOnce();
	});
});

describe("reorderColumns", () => {
	const colA = { id: "col-aaa", name: "Alpha", color: "#ff0000", llmInstruction: "" };
	const colB = { id: "col-bbb", name: "Beta", color: "#00ff00", llmInstruction: "" };
	const colC = { id: "col-ccc", name: "Gamma", color: "#0000ff", llmInstruction: "" };

	beforeEach(() => {
		vi.clearAllMocks();
		mockSpawn.mockReturnValue({ stderr: new Response(""), stdout: new Response(""), exited: Promise.resolve(0) });
	});

	it("reorders custom columns and stores full columnOrder", async () => {
		const project = makeProject({ customColumns: [colA, colB, colC] });
		const newOrder = ["todo", "in-progress", "col-ccc", "col-aaa", "col-bbb", "completed"];
		vi.mocked(data.updateProjectWith).mockImplementation(async (_projectId, mutator) => {
			const { updates, result } = await mutator(project);
			return { project: { ...project, ...updates }, result };
		});

		const result = await handlers.reorderColumns({
			projectId: "proj-1",
			columnOrder: newOrder,
		});

		expect(data.updateProjectWith).toHaveBeenCalledTimes(1);
		expect(result.customColumns).toEqual([colC, colA, colB]);
	});

	it("ignores unknown IDs in columnOrder for custom column extraction", async () => {
		const project = makeProject({ customColumns: [colA, colB] });
		const newOrder = ["todo", "col-bbb", "col-aaa", "col-unknown", "completed"];
		vi.mocked(data.updateProjectWith).mockImplementation(async (_projectId, mutator) => {
			const { updates, result } = await mutator(project);
			return { project: { ...project, ...updates }, result };
		});

		await handlers.reorderColumns({
			projectId: "proj-1",
			columnOrder: newOrder,
		});

		expect(data.updateProjectWith).toHaveBeenCalledTimes(1);
	});
});

describe("reorderLabels", () => {
	const labA = { id: "lab-aaa", name: "Alpha", color: "#ff0000" };
	const labB = { id: "lab-bbb", name: "Beta", color: "#00ff00" };
	const labC = { id: "lab-ccc", name: "Gamma", color: "#0000ff" };

	beforeEach(() => {
		vi.clearAllMocks();
		mockSpawn.mockReturnValue({ stderr: new Response(""), stdout: new Response(""), exited: Promise.resolve(0) });
	});

	it("reorders labels to match labelOrder", async () => {
		const project = makeProject({ labels: [labA, labB, labC] });
		vi.mocked(data.updateProjectWith).mockImplementation(async (_projectId, mutator) => {
			const { updates, result } = await mutator(project);
			return { project: { ...project, ...updates }, result };
		});

		const result = await handlers.reorderLabels({
			projectId: "proj-1",
			labelOrder: ["lab-ccc", "lab-aaa", "lab-bbb"],
		});

		expect(data.updateProjectWith).toHaveBeenCalledTimes(1);
		expect(result.labels).toEqual([labC, labA, labB]);
	});

	it("appends labels missing from labelOrder and skips unknown IDs", async () => {
		const project = makeProject({ labels: [labA, labB, labC] });
		vi.mocked(data.updateProjectWith).mockImplementation(async (_projectId, mutator) => {
			const { updates, result } = await mutator(project);
			return { project: { ...project, ...updates }, result };
		});

		// Only mentions B (+ an unknown id); A and C must survive, appended in original order.
		const result = await handlers.reorderLabels({
			projectId: "proj-1",
			labelOrder: ["lab-bbb", "lab-unknown"],
		});

		expect(result.labels).toEqual([labB, labA, labC]);
	});
});

describe("moveTaskToCustomColumn — resume logic", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockSpawn.mockReturnValue({ stderr: new Response(""), stdout: new Response(""), exited: Promise.resolve(0) });
		vi.mocked(git.createWorktree).mockReset();
		vi.mocked(git.createWorktree).mockResolvedValue({ worktreePath: "/tmp/new-wt", branchName: "dev3/resumed" } as any);
		vi.mocked(loadSettings).mockResolvedValue({ updateChannel: "stable", taskDropPosition: "top" } as any);
	});

	it("moves active task to custom column without worktree changes", async () => {
		const col = { id: "col-aaa", name: "Alpha", color: "#ff0000", llmInstruction: "" };
		const project = makeProject({ customColumns: [col] });
		const task = makeTask({ status: "in-progress", customColumnId: null });
		vi.mocked(data.getProject).mockResolvedValue(project);
		mockTaskWrites(task);

		const result = await handlers.moveTaskToCustomColumn({ taskId: "task-1", projectId: "proj-1", customColumnId: "col-aaa" });

		expect(git.createWorktree).not.toHaveBeenCalled();
		expect(data.updateTask).toHaveBeenCalledWith(
			project,
			"task-1",
			expect.objectContaining({
				customColumnId: "col-aaa",
				runtimeState: expect.objectContaining({ runtime: "running" }),
			}),
			{ dropPosition: "top" },
		);
		expect(result.customColumnId).toBe("col-aaa");
	});

	it("resumes completed task when moved to custom column", async () => {
		const col = { id: "col-aaa", name: "Alpha", color: "#ff0000", llmInstruction: "" };
		const project = makeProject({ customColumns: [col] });
		const task = makeTask({ status: "completed", worktreePath: null, branchName: null, customColumnId: null });
		vi.mocked(data.getProject).mockResolvedValue(project);
		mockTaskWrites(task);

		const result = await handlers.moveTaskToCustomColumn({ taskId: "task-1", projectId: "proj-1", customColumnId: "col-aaa" });

		expect(git.createWorktree).toHaveBeenCalledWith(project, task, undefined);
		expect(data.updateTask).toHaveBeenCalledWith(project, "task-1", expect.objectContaining({
			status: "in-progress",
			worktreePath: "/tmp/new-wt",
			branchName: "dev3/resumed",
			customColumnId: "col-aaa",
			runtimeState: expect.objectContaining({ runtime: "running" }),
		}), { dropPosition: "top" });
		expect(result.status).toBe("in-progress");
		expect(result.customColumnId).toBe("col-aaa");
	});

	it("resumes cancelled task when moved to custom column", async () => {
		const col = { id: "col-aaa", name: "Alpha", color: "#ff0000", llmInstruction: "" };
		const project = makeProject({ customColumns: [col] });
		const task = makeTask({ status: "cancelled", worktreePath: null, branchName: null, customColumnId: null });
		vi.mocked(data.getProject).mockResolvedValue(project);
		mockTaskWrites(task);

		await handlers.moveTaskToCustomColumn({ taskId: "task-1", projectId: "proj-1", customColumnId: "col-aaa" });

		expect(git.createWorktree).toHaveBeenCalled();
		expect(data.updateTask).toHaveBeenCalledWith(project, "task-1", expect.objectContaining({
			status: "in-progress",
			customColumnId: "col-aaa",
		}), { dropPosition: "top" });
	});

	it("throws when custom column not found", async () => {
		const project = makeProject({ customColumns: [] });
		const task = makeTask({ status: "in-progress" });
		vi.mocked(data.getProject).mockResolvedValue(project);
		vi.mocked(data.getTask).mockResolvedValue(task);

		await expect(
			handlers.moveTaskToCustomColumn({ taskId: "task-1", projectId: "proj-1", customColumnId: "col-unknown" }),
		).rejects.toThrow("Custom column not found");
	});

	it("clears customColumnId when passing null", async () => {
		const project = makeProject({ customColumns: [] });
		const task = makeTask({ status: "in-progress", customColumnId: "col-old" });
		const updated = { ...task, customColumnId: null };
		vi.mocked(data.getProject).mockResolvedValue(project);
		vi.mocked(data.getTask).mockResolvedValue(task);
		vi.mocked(data.updateTask).mockResolvedValue(updated);

		const result = await handlers.moveTaskToCustomColumn({ taskId: "task-1", projectId: "proj-1", customColumnId: null });

		expect(data.updateTask).toHaveBeenCalledWith(
			project,
			"task-1",
			expect.objectContaining({
				customColumnId: null,
				runtimeState: expect.objectContaining({ runtime: "running" }),
			}),
			{ dropPosition: "top" },
		);
		expect(result.customColumnId).toBeNull();
	});
});

// ================================================================
// checkOpenPRsForPromotion — PR detection poller
// ================================================================

describe("checkOpenPRsForPromotion", () => {
	beforeEach(() => {
		vi.mocked(data.loadProjects).mockReset();
		vi.mocked(data.loadTasks).mockReset();
		vi.mocked(data.updateTask).mockReset();
		vi.mocked(git.getCurrentBranch).mockReset();
		vi.mocked(git.getUnpushedCount).mockReset();
		vi.mocked(github.runGitHub).mockReset();
		_resetPRPollerState();
		// Zero jitter so a freshly-seen task is due on the first direct call.
		_setScheduleRandomForTest(() => 0);
	});

	function setup(taskOverrides?: Partial<Task>, projectOverrides?: Partial<Project>) {
		const project = makeProject(projectOverrides);
		const task = makeTask({ status: "review-by-user", worktreePath: "/tmp/wt", ...taskOverrides });
		vi.mocked(data.loadProjects).mockResolvedValue([project]);
		vi.mocked(data.loadTasks).mockResolvedValue([task]);
		vi.mocked(git.getCurrentBranch).mockResolvedValue("dev3/my-feature");
		vi.mocked(git.getUnpushedCount).mockResolvedValue(0);
		vi.mocked(data.updateTask).mockImplementation(async (_project, taskId, updates) => ({
			...task,
			...updates,
			id: taskId,
		} as Task));
		return { project, task };
	}

	it("promotes task to review-by-colleague when open non-draft PR found", async () => {
		const { project, task } = setup();
		const promoted = { ...task, status: "review-by-colleague" as const };
		vi.mocked(github.runGitHub).mockResolvedValue({ ok: true, stdout: JSON.stringify([{ number: 42, isDraft: false }]), stderr: "", code: 0 });
		vi.mocked(data.updateTask).mockResolvedValue(promoted);

		const push = vi.fn();
		setPushMessage(push);

		await checkOpenPRsForPromotion();

		expect(data.updateTask).toHaveBeenCalledWith(project, task.id, { status: "review-by-colleague" });
		expect(push).toHaveBeenCalledWith("taskUpdated", { projectId: project.id, task: promoted });
	});

	it("does not promote when PR is a draft", async () => {
		setup();
		vi.mocked(github.runGitHub).mockResolvedValue({ ok: true, stdout: JSON.stringify([{ number: 7, isDraft: true }]), stderr: "", code: 0 });

		await checkOpenPRsForPromotion();

		expect(data.updateTask).not.toHaveBeenCalled();
	});

	it("does not promote when no PR exists", async () => {
		setup();
		vi.mocked(github.runGitHub).mockResolvedValue({ ok: true, stdout: JSON.stringify([]), stderr: "", code: 0 });

		await checkOpenPRsForPromotion();

		expect(data.updateTask).not.toHaveBeenCalled();
	});

	it("skips projects with peerReviewEnabled === false", async () => {
		setup({}, { peerReviewEnabled: false });
		vi.mocked(github.runGitHub).mockResolvedValue({ ok: true, stdout: JSON.stringify([{ number: 1, isDraft: false }]), stderr: "", code: 0 });

		await checkOpenPRsForPromotion();

		expect(git.getCurrentBranch).not.toHaveBeenCalled();
		expect(data.updateTask).not.toHaveBeenCalled();
	});

	it("skips tasks not in review-by-user status", async () => {
		setup({ status: "in-progress" });

		await checkOpenPRsForPromotion();

		expect(git.getCurrentBranch).not.toHaveBeenCalled();
		expect(data.updateTask).not.toHaveBeenCalled();
	});

	it("skips tasks with no worktreePath", async () => {
		setup({ worktreePath: null });

		await checkOpenPRsForPromotion();

		expect(git.getCurrentBranch).not.toHaveBeenCalled();
		expect(data.updateTask).not.toHaveBeenCalled();
	});

	it("skips branches that were never pushed (getUnpushedCount === -1)", async () => {
		setup();
		vi.mocked(git.getUnpushedCount).mockResolvedValue(-1);

		await checkOpenPRsForPromotion();

		expect(github.runGitHub).not.toHaveBeenCalled();
		expect(data.updateTask).not.toHaveBeenCalled();
	});

	it("does not re-check already promoted tasks", async () => {
		const { task } = setup();
		const promoted = { ...task, status: "review-by-colleague" as const };
		vi.mocked(github.runGitHub).mockResolvedValue({ ok: true, stdout: JSON.stringify([{ number: 1, isDraft: false }]), stderr: "", code: 0 });
		vi.mocked(data.updateTask).mockResolvedValue(promoted);

		const push = vi.fn();
		setPushMessage(push);

		await checkOpenPRsForPromotion();
		expect(data.updateTask).toHaveBeenCalledTimes(1);

		// Reset mocks but keep the actor's promotion state.
		vi.mocked(data.updateTask).mockClear();
		vi.mocked(push).mockClear();

		await checkOpenPRsForPromotion();
		expect(data.updateTask).not.toHaveBeenCalled();
	});

	it("keeps a detected PR polling while the task is in progress", async () => {
		const { task } = setup({
			status: "in-progress",
			prNumber: 42,
			prUrl: "https://github.com/test/repo/pull/42",
		});
		vi.mocked(github.runGitHub).mockResolvedValue({
			ok: true,
			stdout: JSON.stringify([{ number: 42, isDraft: false, url: "https://github.com/test/repo/pull/42", title: "Keep polling" }]),
			stderr: "",
			code: 0,
		});

		const push = vi.fn();
		setPushMessage(push);

		await checkOpenPRsForPromotion();

		expect(git.getCurrentBranch).toHaveBeenCalledWith(task.worktreePath);
		expect(push).toHaveBeenCalledWith("taskPrStatus", expect.objectContaining({
			taskId: task.id,
			prNumber: 42,
			prTitle: "Keep polling",
		}));
	});

	it("polls sticky PRs even when peer review promotion is disabled", async () => {
		const { task } = setup({
			status: "in-progress",
			prNumber: 42,
			prUrl: "https://github.com/test/repo/pull/42",
		}, { peerReviewEnabled: false });
		vi.mocked(github.runGitHub).mockResolvedValue({
			ok: true,
			stdout: JSON.stringify([{ number: 42, isDraft: false, url: task.prUrl }]),
			stderr: "",
			code: 0,
		});
		const push = vi.fn();
		setPushMessage(push);

		await checkOpenPRsForPromotion();

		expect(git.getCurrentBranch).toHaveBeenCalled();
		expect(push).toHaveBeenCalledWith("taskPrStatus", expect.objectContaining({ taskId: task.id }));
	});

	it("keeps a merged sticky PR linked and reports its merged state", async () => {
		const { project, task } = setup({
			status: "review-by-user",
			prNumber: 42,
			prUrl: "https://github.com/test/repo/pull/42",
		});
		const mergedPr = {
			number: 42,
			isDraft: false,
			autoMergeRequest: null,
			url: task.prUrl,
			statusCheckRollup: [],
			reviewDecision: null,
			mergeable: "UNKNOWN",
			mergeStateStatus: "UNKNOWN",
			state: "MERGED",
			title: "Merged change",
		};
		vi.mocked(github.runGitHub)
			.mockResolvedValueOnce({ ok: true, stdout: "[]", stderr: "", code: 0 })
			.mockResolvedValueOnce({ ok: true, stdout: JSON.stringify(mergedPr), stderr: "", code: 0 })
			.mockResolvedValueOnce({
				ok: true,
				stdout: JSON.stringify({
					data: {
						repository: {
							pullRequest: {
								reviewThreads: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
							},
						},
					},
				}),
				stderr: "",
				code: 0,
			});
		const push = vi.fn();
		setPushMessage(push);

		await checkOpenPRsForPromotion();

		expect(github.runGitHub).toHaveBeenNthCalledWith(
			2,
			project,
			task.worktreePath,
			expect.arrayContaining(["pr", "view", "42", "--json"]),
			expect.objectContaining({ timeoutMs: expect.any(Number) }),
		);
		expect(data.updateTask).toHaveBeenCalledWith(project, task.id, expect.objectContaining({
			prNumber: 42,
			prUrl: task.prUrl,
			prStatusCache: expect.objectContaining({
				number: 42,
				url: task.prUrl,
				mergeState: { mergeable: "UNKNOWN", status: "UNKNOWN", state: "MERGED" },
			}),
		}));
		expect(push).toHaveBeenCalledWith("taskPrStatus", expect.objectContaining({
			taskId: task.id,
			prNumber: 42,
			prUrl: task.prUrl,
			mergeState: { mergeable: "UNKNOWN", status: "UNKNOWN", state: "MERGED" },
		}));
		expect(data.updateTask).not.toHaveBeenCalledWith(project, task.id, { status: "review-by-colleague" });
	});

	it("uses the GraphQL review-thread page and persists the PR identity", async () => {
		const { project, task } = setup({ status: "review-by-colleague" }, { githubAuthHost: "ghe.example.com" });
		const prUrl = "https://ghe.example.com/test/repo/pull/42";
		const persisted = { ...task, prNumber: 42, prUrl };
		vi.mocked(github.runGitHub)
			.mockResolvedValueOnce({
				ok: true,
				stdout: JSON.stringify([{
					number: 42,
					isDraft: false,
					autoMergeRequest: { enabledAt: "2026-07-15T18:00:00Z" },
					reviewDecision: "REVIEW_REQUIRED",
					url: prUrl,
					statusCheckRollup: [{ name: "build", status: "COMPLETED", conclusion: "FAILURE", detailsUrl: "https://ci/build" }],
					mergeable: "CONFLICTING",
					mergeStateStatus: "DIRTY",
					state: "OPEN",
					title: "Needs attention",
				}]),
				stderr: "",
				code: 0,
			})
			.mockResolvedValueOnce({
				ok: true,
				stdout: JSON.stringify({
					data: {
						repository: {
							pullRequest: {
								reviewThreads: {
									nodes: [{ isResolved: false }, { isResolved: true }],
									pageInfo: { hasNextPage: true, endCursor: "cursor-1" },
								},
							},
						},
					},
				}),
				stderr: "",
				code: 0,
			});
		vi.mocked(github.runGitHub).mockResolvedValueOnce({
			ok: true,
			stdout: JSON.stringify({
				data: {
					repository: {
						pullRequest: {
							reviewThreads: {
								nodes: [{ isResolved: false }],
								pageInfo: { hasNextPage: false, endCursor: null },
							},
						},
					},
				},
			}),
			stderr: "",
			code: 0,
		});
		vi.mocked(data.updateTask).mockResolvedValue(persisted);
		const push = vi.fn();
		setPushMessage(push);

		await checkOpenPRsForPromotion();

		expect(data.updateTask).toHaveBeenCalledWith(project, task.id, expect.objectContaining({
			prNumber: 42,
			prUrl,
			prStatusCache: expect.objectContaining({
				number: 42,
				url: prUrl,
				autoMergeEnabled: true,
				reviewDecision: "review_required",
				ciStatus: "failure",
				unresolvedCount: 2,
				cachedAt: expect.any(String),
			}),
		}));
		expect(github.runGitHub).toHaveBeenNthCalledWith(
			2,
			project,
			task.worktreePath,
			expect.arrayContaining(["api", "graphql", "--hostname", "ghe.example.com", expect.stringContaining("reviewThreads")]),
			expect.objectContaining({ timeoutMs: expect.any(Number) }),
		);
		expect(github.runGitHub).toHaveBeenNthCalledWith(
			3,
			project,
			task.worktreePath,
			expect.arrayContaining(["after=cursor-1"]),
			expect.objectContaining({ timeoutMs: expect.any(Number) }),
		);
		expect(push).toHaveBeenCalledWith("taskPrStatus", expect.objectContaining({
			unresolvedCount: 2,
			autoMergeEnabled: true,
			reviewDecision: "review_required",
			mergeState: { mergeable: "CONFLICTING", status: "DIRTY", state: "OPEN" },
			checks: [{ name: "build", status: "COMPLETED", conclusion: "FAILURE", detailsUrl: "https://ci/build" }],
			prTitle: "Needs attention",
		}));
	});

	it("polls pending CI at the active one-minute cadence, then backs off when settled", async () => {
		vi.useFakeTimers();
		try {
			const { task } = setup({ status: "review-by-colleague" });
			vi.mocked(github.runGitHub)
				.mockResolvedValueOnce({
					ok: true,
					stdout: JSON.stringify([{ number: 42, isDraft: false, url: "https://example/pr/42", statusCheckRollup: [{ status: "IN_PROGRESS" }] }]),
					stderr: "",
					code: 0,
				})
				.mockResolvedValueOnce({
					ok: true,
					stdout: JSON.stringify([{ number: 42, isDraft: false, url: "https://example/pr/42", statusCheckRollup: [{ status: "COMPLETED", conclusion: "SUCCESS" }] }]),
					stderr: "",
					code: 0,
				});
			const push = vi.fn();
			setPushMessage(push);
			setAppForeground(true);
			setActiveContext({ projectId: "proj-1", taskId: null });
			vi.setSystemTime(0);

			await checkOpenPRsForPromotion();
			expect(github.runGitHub).toHaveBeenCalledTimes(1);

			vi.setSystemTime(60_000);
			await checkOpenPRsForPromotion();
			expect(github.runGitHub).toHaveBeenCalledTimes(2);

			vi.setSystemTime(120_000);
			await checkOpenPRsForPromotion();
			expect(github.runGitHub).toHaveBeenCalledTimes(2);
			expect(task.id).toBe("task-1");
		} finally {
			setAppForeground(false);
			setActiveContext({ projectId: null, taskId: null });
			vi.useRealTimers();
		}
	});

	it("refreshes one task immediately through the RPC handler", async () => {
		const { project, task } = setup({ status: "in-progress", prNumber: 42, prUrl: "https://example/pr/42" });
		vi.mocked(data.getProject).mockResolvedValue(project);
		vi.mocked(data.getTask).mockResolvedValue(task);
		vi.mocked(github.runGitHub).mockResolvedValue({
			ok: true,
			stdout: JSON.stringify([{ number: 42, isDraft: false, url: task.prUrl }]),
			stderr: "",
			code: 0,
		});
		const push = vi.fn();
		setPushMessage(push);

		await handlers.refreshTaskPrStatus({ taskId: task.id, projectId: project.id });

		expect(github.runGitHub).toHaveBeenCalledWith(
			project,
			task.worktreePath,
			expect.arrayContaining(["pr", "list"]),
			expect.objectContaining({ timeoutMs: expect.any(Number) }),
		);
		expect(push).toHaveBeenCalledWith("taskPrStatus", expect.objectContaining({ taskId: task.id, prNumber: 42 }));
	});

	it("skips when gh pr list call fails", async () => {
		setup();
		vi.mocked(github.runGitHub).mockResolvedValue({ ok: false, stdout: "", stderr: "gh: not found", code: 1 });

		await checkOpenPRsForPromotion();

		expect(data.updateTask).not.toHaveBeenCalled();
	});
});

// ================================================================
// getChangelogs
// ================================================================

describe("getChangelogs", () => {
	beforeEach(() => {
		vi.mocked(existsSync).mockReset();
		mockBundledChangelog.length = 0;
	});

	it("returns empty array when no change-logs dir, no JSON file, and no bundled data (reproduces production bug)", async () => {
		// Simulate Electrobun 1.14+ production: no vite.config.ts, no change-logs/,
		// no changelog.json on disk (resources inside tar archive)
		vi.mocked(existsSync).mockReturnValue(false);

		const result = await handlers.getChangelogs();
		expect(result).toEqual([]);
	});

	it("returns bundled data when filesystem paths are inaccessible (Electrobun 1.14+ fix)", async () => {
		// Simulate production: all filesystem checks fail
		vi.mocked(existsSync).mockReturnValue(false);

		// But bundled data is available (inlined at build time)
		mockBundledChangelog.push(
			{ date: "2026-03-09", type: "fix", slug: "test-fix", title: "A test fix" },
			{ date: "2026-03-08", type: "feature", slug: "test-feat", title: "A test feature" },
		);

		const result = await handlers.getChangelogs();
		expect(result).toHaveLength(2);
		expect(result[0]).toEqual({ date: "2026-03-09", type: "fix", slug: "test-fix", title: "A test fix" });
	});

	it("reads from JSON file when it exists on disk", async () => {
		const fakeEntries = [{ date: "2026-03-01", type: "fix", slug: "s", title: "T" }];
		// existsSync: false for vite.config.ts (20 calls), false for change-logs/,
		// then true for prodJson path
		const calls: string[] = [];
		vi.mocked(existsSync).mockImplementation((p: any) => {
			calls.push(String(p));
			if (String(p).endsWith("changelog.json")) return true;
			return false;
		});

		// Mock Bun.file().text() to return JSON
		(globalThis as any).Bun.file = vi.fn(() => ({
			text: () => Promise.resolve(JSON.stringify(fakeEntries)),
			exists: () => Promise.resolve(true),
			json: () => Promise.resolve(fakeEntries),
		}));

		const result = await handlers.getChangelogs();
		expect(result).toEqual(fakeEntries);
	});
});

describe("startMergeDetectionPoller / stopMergeDetectionPoller", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.useFakeTimers();
		stopMergeDetectionPoller();
		_resetMergePollerState();
		// Simulate the user actively viewing this project's board so the poller
		// runs at the full per-tick cadence (off-screen projects are throttled).
		setAppForeground(true);
		setActiveContext({ projectId: "proj-1", taskId: null });
		// Zero jitter so per-task scheduling is deterministic in tests.
		_setScheduleRandomForTest(() => 0);
		vi.mocked(git.getHeadSha).mockResolvedValue("abc123");
		// clearAllMocks does not reset implementations left by earlier describe
		// blocks (e.g. isWorktreeDirty -> true), so pin a clean worktree here.
		vi.mocked(git.isWorktreeDirty).mockResolvedValue(false);
		vi.mocked(data.updateTask).mockImplementation(async (_project: Project, taskId: string, patch: Partial<Task>) => (
			makeTask({ ...patch, id: taskId })
		));
		vi.mocked(loadSettings).mockResolvedValue({ updateChannel: "stable", taskDropPosition: "top" } as any);
	});

	afterEach(() => {
		stopMergeDetectionPoller();
		_resetMergePollerState();
		setAppForeground(false);
		setActiveContext({ projectId: null, taskId: null });
		vi.mocked(data.updateTask).mockReset();
		vi.useRealTimers();
	});

	it("can be stopped after starting", () => {
		startMergeDetectionPoller();
		// Should not throw
		stopMergeDetectionPoller();
	});

	it("stopMergeDetectionPoller is a no-op when not started", () => {
		// Should not throw
		stopMergeDetectionPoller();
	});

	it("does not stack intervals when called multiple times", () => {
		const setIntervalSpy = vi.spyOn(globalThis, "setInterval");
		const clearIntervalSpy = vi.spyOn(globalThis, "clearInterval");

		startMergeDetectionPoller();
		startMergeDetectionPoller();
		startMergeDetectionPoller();

		// Each start clears the previous, so setInterval called 3 times, clearInterval called 3 times (once per start)
		expect(setIntervalSpy).toHaveBeenCalledTimes(3);
		// First call: stop before start (no-op since null), second: clears first, third: clears second
		expect(clearIntervalSpy).toHaveBeenCalledTimes(2);

		setIntervalSpy.mockRestore();
		clearIntervalSpy.mockRestore();
	});

	it("notifies about merged PR Review tasks on the first 60-second poll", async () => {
		const project = makeProject();
		const task = makeTask({
			status: "review-by-colleague",
			worktreePath: "/tmp/test-worktree",
			branchName: "dev3/task-test",
		});
		const push = vi.fn();

		vi.mocked(data.loadProjects).mockResolvedValue([project]);
		vi.mocked(data.loadTasks).mockResolvedValue([task]);
		vi.mocked(git.fetchOrigin).mockResolvedValue(true);
		vi.mocked(git.getCurrentBranch).mockResolvedValue("dev3/task-test");
		vi.mocked(git.getUnpushedCount).mockResolvedValue(0);
		vi.mocked(git.isContentMergedInto).mockResolvedValue(true);
		setPushMessage(push);

		startMergeDetectionPoller();
		await vi.advanceTimersByTimeAsync(60_000);

		expect(push).toHaveBeenCalledWith("branchMerged", {
			taskId: task.id,
			projectId: project.id,
			taskTitle: task.title,
			branchName: "dev3/task-test",
			fingerprint: "v1:dev3/task-test:abc123",
			subject: buildTaskDialogSubject(task, project),
		});
	});

	it.each([
		["manual task flag", { manualCompletion: true }, undefined, false],
		["global setting", {}, { suggestCompletingTasksAfterMerge: false }, true],
	])("emits the expected notice-only merge event for %s", async (_name, taskOverrides, settingsOverride, shouldNotify) => {
		const project = makeProject();
		const task = makeTask({
			status: "review-by-user",
			worktreePath: "/tmp/test-worktree",
			branchName: "dev3/task-test",
			...taskOverrides,
		});
		const push = vi.fn();
		if (settingsOverride) {
			vi.mocked(loadSettings).mockResolvedValue({
				updateChannel: "stable",
				taskDropPosition: "top",
				...settingsOverride,
			} as GlobalSettings);
		}

		vi.mocked(data.loadProjects).mockResolvedValue([project]);
		vi.mocked(data.loadTasks).mockResolvedValue([task]);
		vi.mocked(git.fetchOrigin).mockResolvedValue(true);
		vi.mocked(git.getCurrentBranch).mockResolvedValue("dev3/task-test");
		vi.mocked(git.getUnpushedCount).mockResolvedValue(0);
		vi.mocked(git.isContentMergedInto).mockResolvedValue(true);
		setPushMessage(push);

		startMergeDetectionPoller();
		await vi.advanceTimersByTimeAsync(60_000);

		expect(push).toHaveBeenCalledWith("branchMerged", expect.objectContaining({
			taskId: task.id,
			shouldPrompt: false,
			shouldNotify,
		}));
		expect(data.updateTask).not.toHaveBeenCalled();
	});

	it("compares PR-review tasks against the project base branch, not the reviewed branch itself", async () => {
		// PR-review tasks are created from an existing branch; deriveTaskBaseBranch
		// sets their baseBranch to that same branch. Comparing the branch against
		// origin/<itself> is trivially "merged" and produced a false prompt. The
		// poller must instead compare against the project's real base branch.
		const project = makeProject({ defaultBaseBranch: "main" });
		const task = makeTask({
			status: "review-by-colleague",
			worktreePath: "/tmp/test-worktree",
			baseBranch: "fix/deepseek-reasoning-dsml-recovery",
			branchName: "fix/deepseek-reasoning-dsml-recovery",
		});
		const push = vi.fn();

		vi.mocked(data.loadProjects).mockResolvedValue([project]);
		vi.mocked(data.loadTasks).mockResolvedValue([task]);
		vi.mocked(git.fetchOrigin).mockResolvedValue(true);
		vi.mocked(git.getCurrentBranch).mockResolvedValue("fix/deepseek-reasoning-dsml-recovery");
		vi.mocked(git.getUnpushedCount).mockResolvedValue(0);
		// Not merged into the real base — no prompt.
		vi.mocked(git.isContentMergedInto).mockResolvedValue(false);
		setPushMessage(push);

		startMergeDetectionPoller();
		await vi.advanceTimersByTimeAsync(60_000);

		expect(push).not.toHaveBeenCalledWith("branchMerged", expect.anything());
		expect(git.isContentMergedInto).toHaveBeenCalledWith(
			"/tmp/test-worktree",
			"origin/main",
			project,
		);
	});

	it("still notifies a PR-review task when its branch is genuinely merged into the project base", async () => {
		const project = makeProject({ defaultBaseBranch: "main" });
		const task = makeTask({
			status: "review-by-colleague",
			worktreePath: "/tmp/test-worktree",
			baseBranch: "fix/deepseek-reasoning-dsml-recovery",
			branchName: "fix/deepseek-reasoning-dsml-recovery",
		});
		const push = vi.fn();

		vi.mocked(data.loadProjects).mockResolvedValue([project]);
		vi.mocked(data.loadTasks).mockResolvedValue([task]);
		vi.mocked(git.fetchOrigin).mockResolvedValue(true);
		vi.mocked(git.getCurrentBranch).mockResolvedValue("fix/deepseek-reasoning-dsml-recovery");
		vi.mocked(git.getUnpushedCount).mockResolvedValue(0);
		// Merged into origin/main — the reviewed PR actually landed.
		vi.mocked(git.isContentMergedInto).mockResolvedValue(true);
		setPushMessage(push);

		startMergeDetectionPoller();
		await vi.advanceTimersByTimeAsync(60_000);

		expect(git.isContentMergedInto).toHaveBeenCalledWith(
			"/tmp/test-worktree",
			"origin/main",
			project,
		);
		expect(push).toHaveBeenCalledWith("branchMerged", {
			taskId: task.id,
			projectId: project.id,
			taskTitle: task.title,
			branchName: "fix/deepseek-reasoning-dsml-recovery",
			fingerprint: "v1:fix/deepseek-reasoning-dsml-recovery:abc123",
			subject: buildTaskDialogSubject(task, project),
		});
	});

	it("skips merge detection when the task branch is the project base branch itself", async () => {
		const project = makeProject({ defaultBaseBranch: "main" });
		const task = makeTask({
			status: "review-by-user",
			worktreePath: "/tmp/test-worktree",
			baseBranch: "main",
			branchName: "main",
		});
		const push = vi.fn();

		vi.mocked(data.loadProjects).mockResolvedValue([project]);
		vi.mocked(data.loadTasks).mockResolvedValue([task]);
		vi.mocked(git.fetchOrigin).mockResolvedValue(true);
		vi.mocked(git.getCurrentBranch).mockResolvedValue("main");
		vi.mocked(git.getUnpushedCount).mockResolvedValue(0);
		vi.mocked(git.isContentMergedInto).mockResolvedValue(true);
		setPushMessage(push);

		startMergeDetectionPoller();
		await vi.advanceTimersByTimeAsync(60_000);

		expect(push).not.toHaveBeenCalledWith("branchMerged", expect.anything());
		expect(git.isContentMergedInto).not.toHaveBeenCalled();
	});

	it("notifies about merged Has Questions tasks on the first 60-second poll", async () => {
		const project = makeProject();
		const task = makeTask({
			id: "task-user-questions",
			status: "user-questions",
			worktreePath: "/tmp/test-worktree",
			branchName: "dev3/task-test",
		});
		const push = vi.fn();

		vi.mocked(data.loadProjects).mockResolvedValue([project]);
		vi.mocked(data.loadTasks).mockResolvedValue([task]);
		vi.mocked(git.fetchOrigin).mockResolvedValue(true);
		vi.mocked(git.getCurrentBranch).mockResolvedValue("dev3/task-test");
		vi.mocked(git.getUnpushedCount).mockResolvedValue(0);
		vi.mocked(git.isContentMergedInto).mockResolvedValue(true);
		setPushMessage(push);

		startMergeDetectionPoller();
		await vi.advanceTimersByTimeAsync(60_000);

		expect(push).toHaveBeenCalledWith("branchMerged", {
			taskId: task.id,
			projectId: project.id,
			taskTitle: task.title,
			branchName: "dev3/task-test",
			fingerprint: "v1:dev3/task-test:abc123",
			subject: buildTaskDialogSubject(task, project),
		});
	});

	it("does not notify again for the same branch head after the prompt was reserved", async () => {
		const project = makeProject();
		const task = makeTask({
			status: "review-by-user",
			worktreePath: "/tmp/test-worktree",
			branchName: "dev3/task-test",
			mergeCompletionPrompt: {
				fingerprint: "v1:dev3/task-test:abc123",
				promptedAt: "2026-05-09T08:00:00.000Z",
				dismissedAt: "2026-05-09T08:01:00.000Z",
				precise: true,
			},
		});
		const push = vi.fn();

		vi.mocked(data.loadProjects).mockResolvedValue([project]);
		vi.mocked(data.loadTasks).mockResolvedValue([task]);
		vi.mocked(git.fetchOrigin).mockResolvedValue(true);
		vi.mocked(git.getCurrentBranch).mockResolvedValue("dev3/task-test");
		vi.mocked(git.getUnpushedCount).mockResolvedValue(0);
		vi.mocked(git.isContentMergedInto).mockResolvedValue(true);
		vi.mocked(git.getHeadSha).mockResolvedValue("abc123");
		setPushMessage(push);

		startMergeDetectionPoller();
		await vi.advanceTimersByTimeAsync(60_000);

		expect(push).not.toHaveBeenCalledWith("branchMerged", expect.anything());
		expect(data.updateTask).not.toHaveBeenCalled();
	});

	it("notifies again when the task branch head changes", async () => {
		const project = makeProject();
		const task = makeTask({
			status: "review-by-user",
			worktreePath: "/tmp/test-worktree",
			branchName: "dev3/task-test",
			mergeCompletionPrompt: {
				fingerprint: "v1:dev3/task-test:abc123",
				promptedAt: "2026-05-09T08:00:00.000Z",
				dismissedAt: "2026-05-09T08:01:00.000Z",
				precise: true,
			},
		});
		const push = vi.fn();

		vi.mocked(data.loadProjects).mockResolvedValue([project]);
		vi.mocked(data.loadTasks).mockResolvedValue([task]);
		vi.mocked(git.fetchOrigin).mockResolvedValue(true);
		vi.mocked(git.getCurrentBranch).mockResolvedValue("dev3/task-test");
		vi.mocked(git.getUnpushedCount).mockResolvedValue(0);
		vi.mocked(git.isContentMergedInto).mockResolvedValue(true);
		vi.mocked(git.getHeadSha).mockResolvedValue("def456");
		setPushMessage(push);

		startMergeDetectionPoller();
		await vi.advanceTimersByTimeAsync(60_000);

		expect(push).toHaveBeenCalledWith("branchMerged", {
			taskId: task.id,
			projectId: project.id,
			taskTitle: task.title,
			branchName: "dev3/task-test",
			fingerprint: "v1:dev3/task-test:def456",
			subject: buildTaskDialogSubject(task, project),
		});
		expect(data.updateTask).toHaveBeenCalledWith(project, task.id, {
			mergeCompletionPrompt: {
				fingerprint: "v1:dev3/task-test:def456",
				promptedAt: expect.any(String),
				dismissedAt: null,
				precise: true,
			},
		});
	});

	it("suppresses fallback fingerprints for one hour", async () => {
		const project = makeProject();
		const task = makeTask({
			status: "review-by-user",
			worktreePath: "/tmp/test-worktree",
			branchName: "dev3/task-test",
			mergeCompletionPrompt: {
				fingerprint: "fallback:dev3/task-test",
				promptedAt: new Date(Date.now() - 30 * 60_000).toISOString(),
				dismissedAt: new Date(Date.now() - 30 * 60_000).toISOString(),
				precise: false,
			},
		});
		const push = vi.fn();

		vi.mocked(data.loadProjects).mockResolvedValue([project]);
		vi.mocked(data.loadTasks).mockResolvedValue([task]);
		vi.mocked(git.fetchOrigin).mockResolvedValue(true);
		vi.mocked(git.getCurrentBranch).mockResolvedValue("dev3/task-test");
		vi.mocked(git.getUnpushedCount).mockResolvedValue(0);
		vi.mocked(git.isContentMergedInto).mockResolvedValue(true);
		vi.mocked(git.getHeadSha).mockResolvedValue(null);
		setPushMessage(push);

		startMergeDetectionPoller();
		await vi.advanceTimersByTimeAsync(60_000);

		expect(push).not.toHaveBeenCalledWith("branchMerged", expect.anything());
	});

	it("does not notify about merged AI Review tasks", async () => {
		const project = makeProject();
		const task = makeTask({
			status: "review-by-ai",
			worktreePath: "/tmp/test-worktree",
			branchName: "dev3/task-test",
		});
		const push = vi.fn();

		vi.mocked(data.loadProjects).mockResolvedValue([project]);
		vi.mocked(data.loadTasks).mockResolvedValue([task]);
		vi.mocked(git.fetchOrigin).mockResolvedValue(true);
		vi.mocked(git.getCurrentBranch).mockResolvedValue("dev3/task-test");
		vi.mocked(git.getUnpushedCount).mockResolvedValue(0);
		vi.mocked(git.isContentMergedInto).mockResolvedValue(true);
		setPushMessage(push);

		startMergeDetectionPoller();
		await vi.advanceTimersByTimeAsync(60_000);

		expect(push).not.toHaveBeenCalled();
		expect(git.isContentMergedInto).not.toHaveBeenCalled();
	});

	it("re-prompts a precise prompt that was reserved over an hour ago but never answered", async () => {
		// App restart / undelivered push leaves promptedAt set with dismissedAt
		// null — the popup was lost and must come back, not be muted forever.
		const project = makeProject();
		const task = makeTask({
			status: "review-by-user",
			worktreePath: "/tmp/test-worktree",
			branchName: "dev3/task-test",
			mergeCompletionPrompt: {
				fingerprint: "v1:dev3/task-test:abc123",
				promptedAt: new Date(Date.now() - 2 * 60 * 60_000).toISOString(),
				dismissedAt: null,
				precise: true,
			},
		});
		const push = vi.fn();

		vi.mocked(data.loadProjects).mockResolvedValue([project]);
		vi.mocked(data.loadTasks).mockResolvedValue([task]);
		vi.mocked(git.fetchOrigin).mockResolvedValue(true);
		vi.mocked(git.getCurrentBranch).mockResolvedValue("dev3/task-test");
		vi.mocked(git.getUnpushedCount).mockResolvedValue(0);
		vi.mocked(git.isContentMergedInto).mockResolvedValue(true);
		setPushMessage(push);

		startMergeDetectionPoller();
		await vi.advanceTimersByTimeAsync(60_000);

		expect(push).toHaveBeenCalledWith("branchMerged", expect.objectContaining({
			taskId: task.id,
			fingerprint: "v1:dev3/task-test:abc123",
		}));
	});

	it("re-prompts a recently-reserved unanswered prompt, but only once per session (in-memory throttle)", async () => {
		// Option B: an unanswered prompt (dismissedAt null) is never time-muted —
		// even one reserved 30 min ago must re-offer completion when the task is
		// eligible (e.g. it flipped to in-progress and back to review-by-user).
		// The in-memory reservation still prevents the 60s poller from re-pushing
		// every tick within the same session.
		const project = makeProject();
		const task = makeTask({
			status: "review-by-user",
			worktreePath: "/tmp/test-worktree",
			branchName: "dev3/task-test",
			mergeCompletionPrompt: {
				fingerprint: "v1:dev3/task-test:abc123",
				promptedAt: new Date(Date.now() - 30 * 60_000).toISOString(),
				dismissedAt: null,
				precise: true,
			},
		});
		const push = vi.fn();

		vi.mocked(data.loadProjects).mockResolvedValue([project]);
		vi.mocked(data.loadTasks).mockResolvedValue([task]);
		vi.mocked(git.fetchOrigin).mockResolvedValue(true);
		vi.mocked(git.getCurrentBranch).mockResolvedValue("dev3/task-test");
		vi.mocked(git.getUnpushedCount).mockResolvedValue(0);
		vi.mocked(git.isContentMergedInto).mockResolvedValue(true);
		setPushMessage(push);

		startMergeDetectionPoller();
		await vi.advanceTimersByTimeAsync(60_000);

		expect(push).toHaveBeenCalledWith("branchMerged", expect.objectContaining({
			taskId: task.id,
			fingerprint: "v1:dev3/task-test:abc123",
		}));

		// Second tick without any status change: the in-memory reservation
		// throttles the re-push, so the user is not spammed every minute.
		await vi.advanceTimersByTimeAsync(60_000);
		expect(push.mock.calls.filter((c) => c[0] === "branchMerged")).toHaveLength(1);
	});

	it("never re-prompts a precise prompt the user dismissed, even after the retry window", async () => {
		const project = makeProject();
		const task = makeTask({
			status: "review-by-user",
			worktreePath: "/tmp/test-worktree",
			branchName: "dev3/task-test",
			mergeCompletionPrompt: {
				fingerprint: "v1:dev3/task-test:abc123",
				promptedAt: new Date(Date.now() - 3 * 60 * 60_000).toISOString(),
				dismissedAt: new Date(Date.now() - 3 * 60 * 60_000).toISOString(),
				precise: true,
			},
		});
		const push = vi.fn();

		vi.mocked(data.loadProjects).mockResolvedValue([project]);
		vi.mocked(data.loadTasks).mockResolvedValue([task]);
		vi.mocked(git.fetchOrigin).mockResolvedValue(true);
		vi.mocked(git.getCurrentBranch).mockResolvedValue("dev3/task-test");
		vi.mocked(git.getUnpushedCount).mockResolvedValue(0);
		vi.mocked(git.isContentMergedInto).mockResolvedValue(true);
		setPushMessage(push);

		startMergeDetectionPoller();
		await vi.advanceTimersByTimeAsync(60_000);

		expect(push).not.toHaveBeenCalledWith("branchMerged", expect.anything());
	});

	it("checks suppression before running expensive merge detection for dismissed prompts", async () => {
		// Dismissed tasks must not burn git/gh calls on every 60s tick.
		const project = makeProject();
		const task = makeTask({
			status: "review-by-user",
			worktreePath: "/tmp/test-worktree",
			branchName: "dev3/task-test",
			mergeCompletionPrompt: {
				fingerprint: "v1:dev3/task-test:abc123",
				promptedAt: new Date(Date.now() - 10 * 60_000).toISOString(),
				dismissedAt: new Date(Date.now() - 10 * 60_000).toISOString(),
				precise: true,
			},
		});
		const push = vi.fn();

		vi.mocked(data.loadProjects).mockResolvedValue([project]);
		vi.mocked(data.loadTasks).mockResolvedValue([task]);
		vi.mocked(git.fetchOrigin).mockResolvedValue(true);
		vi.mocked(git.getCurrentBranch).mockResolvedValue("dev3/task-test");
		vi.mocked(git.getUnpushedCount).mockResolvedValue(0);
		vi.mocked(git.isContentMergedInto).mockResolvedValue(true);
		setPushMessage(push);

		startMergeDetectionPoller();
		await vi.advanceTimersByTimeAsync(60_000);

		expect(git.isContentMergedInto).not.toHaveBeenCalled();
		expect(git.getUnpushedCount).not.toHaveBeenCalled();
		expect(push).not.toHaveBeenCalledWith("branchMerged", expect.anything());
	});

	it("falls back to the GitHub merged-PR check when the remote branch is gone (unpushed === -1)", async () => {
		// delete_branch_on_merge prunes origin/<branch> after the PR lands;
		// getUnpushedCount then returns -1 and the merged task was silently skipped.
		const project = makeProject();
		const task = makeTask({
			status: "review-by-user",
			worktreePath: "/tmp/test-worktree",
			branchName: "dev3/task-test",
		});
		const push = vi.fn();

		vi.mocked(data.loadProjects).mockResolvedValue([project]);
		vi.mocked(data.loadTasks).mockResolvedValue([task]);
		vi.mocked(git.fetchOrigin).mockResolvedValue(true);
		vi.mocked(git.getCurrentBranch).mockResolvedValue("dev3/task-test");
		vi.mocked(git.getUnpushedCount).mockResolvedValue(-1);
		vi.mocked(git.isBranchMergedViaGitHubPR).mockResolvedValue(true);
		setPushMessage(push);

		startMergeDetectionPoller();
		await vi.advanceTimersByTimeAsync(60_000);

		expect(git.isBranchMergedViaGitHubPR).toHaveBeenCalledWith("/tmp/test-worktree", project);
		expect(git.isContentMergedInto).not.toHaveBeenCalled();
		expect(push).toHaveBeenCalledWith("branchMerged", expect.objectContaining({
			taskId: task.id,
			fingerprint: "v1:dev3/task-test:abc123",
		}));
	});

	it("does not prompt when the remote branch is gone and GitHub has no matching merged PR", async () => {
		const project = makeProject();
		const task = makeTask({
			status: "review-by-user",
			worktreePath: "/tmp/test-worktree",
			branchName: "dev3/task-test",
		});
		const push = vi.fn();

		vi.mocked(data.loadProjects).mockResolvedValue([project]);
		vi.mocked(data.loadTasks).mockResolvedValue([task]);
		vi.mocked(git.fetchOrigin).mockResolvedValue(true);
		vi.mocked(git.getCurrentBranch).mockResolvedValue("dev3/task-test");
		vi.mocked(git.getUnpushedCount).mockResolvedValue(-1);
		vi.mocked(git.isBranchMergedViaGitHubPR).mockResolvedValue(false);
		setPushMessage(push);

		startMergeDetectionPoller();
		await vi.advanceTimersByTimeAsync(60_000);

		expect(push).not.toHaveBeenCalledWith("branchMerged", expect.anything());
	});

	it("does not prompt or reserve while the worktree is dirty, then prompts once clean", async () => {
		// The popup claims "no changes left" — a dirty worktree means changes
		// DO remain, and completing the task would destroy them.
		const project = makeProject();
		const task = makeTask({
			status: "review-by-user",
			worktreePath: "/tmp/test-worktree",
			branchName: "dev3/task-test",
		});
		const push = vi.fn();

		vi.mocked(data.loadProjects).mockResolvedValue([project]);
		vi.mocked(data.loadTasks).mockResolvedValue([task]);
		vi.mocked(git.fetchOrigin).mockResolvedValue(true);
		vi.mocked(git.getCurrentBranch).mockResolvedValue("dev3/task-test");
		vi.mocked(git.getUnpushedCount).mockResolvedValue(0);
		vi.mocked(git.isContentMergedInto).mockResolvedValue(true);
		vi.mocked(git.isWorktreeDirty).mockResolvedValue(true);
		setPushMessage(push);

		startMergeDetectionPoller();
		await vi.advanceTimersByTimeAsync(60_000);

		expect(push).not.toHaveBeenCalledWith("branchMerged", expect.anything());
		expect(data.updateTask).not.toHaveBeenCalled();

		vi.mocked(git.isWorktreeDirty).mockResolvedValue(false);
		await vi.advanceTimersByTimeAsync(60_000);

		expect(push).toHaveBeenCalledWith("branchMerged", expect.objectContaining({ taskId: task.id }));
	});

	it("re-prompts in the same session when an unanswered in-memory reservation expires", async () => {
		const project = makeProject();
		const task = makeTask({
			status: "review-by-user",
			worktreePath: "/tmp/test-worktree",
			branchName: "dev3/task-test",
		});
		const push = vi.fn();

		vi.mocked(data.loadProjects).mockResolvedValue([project]);
		vi.mocked(data.loadTasks).mockResolvedValue([task]);
		vi.mocked(git.fetchOrigin).mockResolvedValue(true);
		vi.mocked(git.getCurrentBranch).mockResolvedValue("dev3/task-test");
		vi.mocked(git.getUnpushedCount).mockResolvedValue(0);
		vi.mocked(git.isContentMergedInto).mockResolvedValue(true);
		setPushMessage(push);

		startMergeDetectionPoller();
		await vi.advanceTimersByTimeAsync(60_000);
		expect(push).toHaveBeenCalledTimes(1);

		// loadTasks keeps returning the task without persisted prompt state,
		// so only the in-memory reservation suppresses re-prompts here.
		await vi.advanceTimersByTimeAsync(62 * 60_000);
		expect(push).toHaveBeenCalledTimes(2);
	});
});

describe("prepareMergeCompletionPrompt (force re-check)", () => {
	const FINGERPRINT = "v1:dev3/task-test:abc123";
	let project: Project;

	function dismissedTask(): Task {
		return makeTask({
			status: "review-by-user",
			mergeCompletionPrompt: {
				fingerprint: FINGERPRINT,
				promptedAt: "2026-06-01T08:00:00.000Z",
				dismissedAt: "2026-06-01T08:01:00.000Z",
				precise: true,
			},
		});
	}

	beforeEach(() => {
		vi.clearAllMocks();
		_resetMergePollerState();
		project = makeProject();
		vi.mocked(loadSettings).mockResolvedValue({ updateChannel: "stable", taskDropPosition: "top" } as any);
		vi.mocked(data.getProject).mockResolvedValue(project);
		vi.mocked(data.updateTask).mockImplementation(async (_p: Project, _id: string, patch: Partial<Task>) => makeTask(patch));
	});

	afterEach(() => {
		_resetMergePollerState();
	});

	it("suppresses a dismissed precise head on a normal (non-forced) check", async () => {
		vi.mocked(data.getTask).mockResolvedValue(dismissedTask());
		const res = await handlers.prepareMergeCompletionPrompt({
			taskId: "task-1",
			projectId: "proj-1",
			fingerprint: FINGERPRINT,
		});
		expect(res.shouldPrompt).toBe(false);
		expect(data.updateTask).not.toHaveBeenCalled();
	});

	it("re-offers a dismissed precise head when force is set (user clicked git refresh)", async () => {
		vi.mocked(data.getTask).mockResolvedValue(dismissedTask());
		const res = await handlers.prepareMergeCompletionPrompt({
			taskId: "task-1",
			projectId: "proj-1",
			fingerprint: FINGERPRINT,
			force: true,
		});
		expect(res.shouldPrompt).toBe(true);
		// The forced reservation clears the prior dismissal so the popup can show.
		expect(data.updateTask).toHaveBeenCalledWith(project, "task-1", {
			mergeCompletionPrompt: {
				fingerprint: FINGERPRINT,
				promptedAt: expect.any(String),
				dismissedAt: null,
				precise: true,
			},
		});
	});

	it("force bypasses the in-memory reservation that mutes back-to-back non-forced checks", async () => {
		// A fresh, never-dismissed merged head.
		vi.mocked(data.getTask).mockResolvedValue(makeTask({ status: "review-by-user" }));

		const first = await handlers.prepareMergeCompletionPrompt({
			taskId: "task-1",
			projectId: "proj-1",
			fingerprint: FINGERPRINT,
		});
		expect(first.shouldPrompt).toBe(true);

		// A second non-forced check is throttled by the in-memory reservation.
		const second = await handlers.prepareMergeCompletionPrompt({
			taskId: "task-1",
			projectId: "proj-1",
			fingerprint: FINGERPRINT,
		});
		expect(second.shouldPrompt).toBe(false);

		// Forcing it re-offers despite the reservation.
		const forced = await handlers.prepareMergeCompletionPrompt({
			taskId: "task-1",
			projectId: "proj-1",
			fingerprint: FINGERPRINT,
			force: true,
		});
		expect(forced.shouldPrompt).toBe(true);
	});

	it("returns a notice-only decision for a manually completed task", async () => {
		vi.mocked(data.getTask).mockResolvedValue(makeTask({ manualCompletion: true }));
		const first = await handlers.prepareMergeCompletionPrompt({
			taskId: "task-1",
			projectId: "proj-1",
			fingerprint: FINGERPRINT,
		});
		const second = await handlers.prepareMergeCompletionPrompt({
			taskId: "task-1",
			projectId: "proj-1",
			fingerprint: FINGERPRINT,
		});

		expect(first).toEqual({ shouldPrompt: false, shouldNotify: false, fingerprint: FINGERPRINT });
		expect(second).toEqual({ shouldPrompt: false, shouldNotify: false, fingerprint: FINGERPRINT });
		expect(data.updateTask).not.toHaveBeenCalled();
	});

	it("returns a notice-only decision when the global suggestion is off", async () => {
		vi.mocked(loadSettings).mockResolvedValue({
			updateChannel: "stable",
			taskDropPosition: "top",
			suggestCompletingTasksAfterMerge: false,
		} as GlobalSettings);
		vi.mocked(data.getTask).mockResolvedValue(makeTask());

		const result = await handlers.prepareMergeCompletionPrompt({
			taskId: "task-1",
			projectId: "proj-1",
			fingerprint: FINGERPRINT,
		});

		expect(result).toEqual({ shouldPrompt: false, shouldNotify: true, fingerprint: FINGERPRINT });
	});
});

describe("dismissMergeCompletionPrompt broadcast", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		_resetMergePollerState();
	});

	afterEach(() => {
		_resetMergePollerState();
	});

	it("broadcasts mergePromptResolved so other clients close their open dialog", async () => {
		const project = makeProject();
		const task = makeTask({ status: "review-by-user", branchName: "dev3/task-test" });
		const push = vi.fn();
		vi.mocked(data.getProject).mockResolvedValue(project);
		vi.mocked(data.getTask).mockResolvedValue(task);
		vi.mocked(data.updateTask).mockImplementation(async (_p: Project, _id: string, patch: Partial<Task>) => makeTask(patch));
		setPushMessage(push);

		await handlers.dismissMergeCompletionPrompt({
			taskId: task.id,
			projectId: project.id,
			fingerprint: "v1:dev3/task-test:abc123",
		});

		expect(push).toHaveBeenCalledWith("mergePromptResolved", {
			taskId: task.id,
			projectId: project.id,
			fingerprint: "v1:dev3/task-test:abc123",
		});
	});
});

describe("setTaskManualCompletion", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		_resetMergePollerState();
	});

	it("persists the task policy and broadcasts the task update", async () => {
		const project = makeProject();
		const task = makeTask({ manualCompletion: false });
		const updated = { ...task, manualCompletion: true, mergeCompletionPrompt: null };
		const push = vi.fn();
		vi.mocked(data.getProject).mockResolvedValue(project);
		vi.mocked(data.getTask).mockResolvedValue(task);
		vi.mocked(data.updateTask).mockResolvedValue(updated);
		setPushMessage(push);

		const result = await handlers.setTaskManualCompletion({
			taskId: task.id,
			projectId: project.id,
			manualCompletion: true,
		});

		expect(result).toEqual(updated);
		expect(data.updateTask).toHaveBeenCalledWith(project, task.id, {
			manualCompletion: true,
			mergeCompletionPrompt: null,
		});
		expect(push).toHaveBeenCalledWith("taskUpdated", { projectId: project.id, task: updated });
		expect(push).not.toHaveBeenCalledWith("manualCompletionChanged", expect.anything());
	});
});

describe("startPRDetectionPoller / stopPRDetectionPoller", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		stopPRDetectionPoller();
		_resetPRPollerState();
		_setScheduleRandomForTest(() => 0);
	});

	afterEach(() => {
		stopPRDetectionPoller();
		_resetPRPollerState();
		vi.useRealTimers();
	});

	it("can be stopped after starting", () => {
		startPRDetectionPoller();
		stopPRDetectionPoller();
	});

	it("stopPRDetectionPoller is a no-op when not started", () => {
		stopPRDetectionPoller();
	});

	it("does not stack intervals when called multiple times", () => {
		const setIntervalSpy = vi.spyOn(globalThis, "setInterval");
		const clearIntervalSpy = vi.spyOn(globalThis, "clearInterval");

		startPRDetectionPoller();
		startPRDetectionPoller();
		startPRDetectionPoller();

		expect(setIntervalSpy).toHaveBeenCalledTimes(3);
		expect(clearIntervalSpy).toHaveBeenCalledTimes(2);

		setIntervalSpy.mockRestore();
		clearIntervalSpy.mockRestore();
	});
});

// ================================================================
// renameBuiltinColumn
// ================================================================

describe("renameBuiltinColumn", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("sets a custom label for a built-in status", async () => {
		const project = makeProject();
		vi.mocked(data.updateProjectWith).mockImplementation(async (_projectId, mutator) => {
			const { updates, result } = await mutator(project);
			return { project: { ...project, ...updates }, result };
		});

		const result = await handlers.renameBuiltinColumn({ projectId: "proj-1", status: "todo", name: "Backlog" });

		expect(result.customStatusLabels).toEqual({ todo: "Backlog" });
	});

	it("clears a custom label when name is null", async () => {
		const project = makeProject({ customStatusLabels: { todo: "Backlog" } });
		vi.mocked(data.updateProjectWith).mockImplementation(async (_projectId, mutator) => {
			const { updates, result } = await mutator(project);
			return { project: { ...project, ...updates }, result };
		});

		const result = await handlers.renameBuiltinColumn({ projectId: "proj-1", status: "todo", name: null });
		expect(result.customStatusLabels).toBeUndefined();
	});

	it("clears a custom label when name is empty string", async () => {
		const project = makeProject({ customStatusLabels: { todo: "Backlog", "in-progress": "Doing" } });
		vi.mocked(data.updateProjectWith).mockImplementation(async (_projectId, mutator) => {
			const { updates, result } = await mutator(project);
			return { project: { ...project, ...updates }, result };
		});

		const result = await handlers.renameBuiltinColumn({ projectId: "proj-1", status: "todo", name: "" });
		expect(result.customStatusLabels).toEqual({ "in-progress": "Doing" });
	});

	it("trims whitespace from the custom name", async () => {
		const project = makeProject();
		vi.mocked(data.updateProjectWith).mockImplementation(async (_projectId, mutator) => {
			const { updates, result } = await mutator(project);
			return { project: { ...project, ...updates }, result };
		});

		const result = await handlers.renameBuiltinColumn({ projectId: "proj-1", status: "todo", name: "  Backlog  " });
		expect(result.customStatusLabels).toEqual({ todo: "Backlog" });
	});
});

// ---- resolveBinaryPath ----

describe("resolveBinaryPath", () => {
	beforeEach(() => {
		mockSpawnSync.mockReset();
		vi.mocked(existsSync).mockReset().mockReturnValue(false);
		vi.mocked(statSync).mockReset().mockReturnValue({ isFile: () => true, mode: 0o755 } as any);
		vi.mocked(accessSync).mockReset().mockImplementation(() => undefined);
	});

	it("returns custom path when it exists", () => {
		vi.mocked(existsSync).mockReturnValue(true);
		const result = resolveBinaryPath("claude", "/custom/bin/claude");
		expect(result.resolvedPath).toBe("/custom/bin/claude");
		expect(result.customPathError).toBe(false);
	});

	it("returns customPathError when custom path does not exist", () => {
		vi.mocked(existsSync).mockReturnValue(false);
		mockSpawnSync.mockReturnValue({ exitCode: 1, stdout: null });
		const result = resolveBinaryPath("claude", "/bad/path/claude");
		expect(result.customPathError).toBe(true);
		expect(result.resolvedPath).toBeUndefined();
	});

	it("rejects an existing directory configured as a custom binary path", () => {
		vi.mocked(existsSync).mockReturnValue(true);
		vi.mocked(statSync).mockReturnValue({ isDirectory: () => true, isFile: () => false, size: 0 } as any);
		mockSpawnSync.mockReturnValue({ exitCode: 1, stdout: null });

		const result = resolveBinaryPath("tmux", "/Users/tester");

		expect(result.customPathError).toBe(true);
		expect(result.resolvedPath).toBeUndefined();
	});

	it("finds binary via which when no custom path", () => {
		mockSpawnSync.mockReturnValue({ exitCode: 0, stdout: new TextEncoder().encode("/usr/local/bin/claude") });
		vi.mocked(existsSync).mockImplementation((p) => String(p) === "/usr/local/bin/claude");
		const result = resolveBinaryPath("claude");
		expect(result.resolvedPath).toBe("/usr/local/bin/claude");
		expect(result.customPathError).toBe(false);
	});

	it("finds binary via fallback paths when which fails", () => {
		mockSpawnSync.mockReturnValue({ exitCode: 1, stdout: null });
		vi.mocked(existsSync).mockImplementation((path: any) => {
			return path === "/opt/homebrew/bin/claude";
		});
		const result = resolveBinaryPath("claude");
		expect(result.resolvedPath).toBe("/opt/homebrew/bin/claude");
	});

	it("returns undefined when binary not found anywhere", () => {
		mockSpawnSync.mockReturnValue({ exitCode: 1, stdout: null });
		vi.mocked(existsSync).mockReturnValue(false);
		const result = resolveBinaryPath("nonexistent-binary");
		expect(result.resolvedPath).toBeUndefined();
		expect(result.customPathError).toBe(false);
	});

	it("prefers custom path over which", () => {
		vi.mocked(existsSync).mockReturnValue(true);
		mockSpawnSync.mockReturnValue({ exitCode: 0, stdout: new TextEncoder().encode("/usr/bin/claude") });
		const result = resolveBinaryPath("claude", "/my/custom/claude");
		expect(result.resolvedPath).toBe("/my/custom/claude");
	});

	it("prefers an existing vendored path over which", () => {
		vi.mocked(existsSync).mockImplementation((path: any) => path === "/opt/homebrew/opt/tmux@3.6/bin/tmux");
		mockSpawnSync.mockReturnValue({ exitCode: 0, stdout: new TextEncoder().encode("/opt/homebrew/bin/tmux") });
		const result = resolveBinaryPath("tmux", undefined, ["/opt/homebrew/opt/tmux@3.6/bin/tmux"]);
		expect(result.resolvedPath).toBe("/opt/homebrew/opt/tmux@3.6/bin/tmux");
	});

	it("prefers custom path over vendored paths", () => {
		vi.mocked(existsSync).mockReturnValue(true);
		const result = resolveBinaryPath("tmux", "/my/custom/tmux", ["/opt/homebrew/opt/tmux@3.6/bin/tmux"]);
		expect(result.resolvedPath).toBe("/my/custom/tmux");
	});

	it("falls through to which when no vendored path exists", () => {
		vi.mocked(existsSync).mockImplementation((p) => String(p) === "/opt/homebrew/bin/tmux");
		mockSpawnSync.mockReturnValue({ exitCode: 0, stdout: new TextEncoder().encode("/opt/homebrew/bin/tmux") });
		const result = resolveBinaryPath("tmux", undefined, ["/opt/homebrew/opt/tmux@3.6/bin/tmux"]);
		expect(result.resolvedPath).toBe("/opt/homebrew/bin/tmux");
	});
});

// ---- bundledTmuxCandidates (decisions/137) ----

describe("bundledTmuxCandidates", () => {
	it("maps the app-bundle layout: Contents/MacOS → Resources/app/tmux/tmux", () => {
		const candidates = bundledTmuxCandidates("darwin", "/Applications/dev-3.0.app/Contents/MacOS");
		expect(candidates).toContain("/Applications/dev-3.0.app/Contents/Resources/app/tmux/tmux");
	});

	it("maps the CLI tarball/libexec layout: tmux/tmux next to the binary", () => {
		const candidates = bundledTmuxCandidates("darwin", "/opt/homebrew/Cellar/dev3/1.36.0/libexec");
		expect(candidates).toContain("/opt/homebrew/Cellar/dev3/1.36.0/libexec/tmux/tmux");
	});

	it("returns nothing on non-macOS platforms", () => {
		expect(bundledTmuxCandidates("linux", "/usr/lib/dev3")).toEqual([]);
	});

	it("returns nothing when the real exec dir is unknown", () => {
		expect(bundledTmuxCandidates("darwin", undefined)).toEqual([]);
	});
});

// ---- checkAgentAvailability ----

describe("checkAgentAvailability", () => {
	beforeEach(() => {
		mockSpawnSync.mockReset();
		vi.mocked(existsSync).mockReset().mockReturnValue(false);
		vi.mocked(statSync).mockReset().mockReturnValue({ isFile: () => true, mode: 0o755 } as any);
		vi.mocked(accessSync).mockReset().mockImplementation(() => undefined);
		vi.mocked(agents.getAllAgents).mockResolvedValue([
			{ id: "builtin-claude", name: "Claude", baseCommand: "claude", isDefault: true, configurations: [], installCommand: "brew install claude-code" },
			{ id: "builtin-codex", name: "Codex", baseCommand: "codex", isDefault: true, configurations: [], installCommand: "npm install -g @openai/codex" },
			{ id: "builtin-gemini", name: "Gemini", baseCommand: "gemini", isDefault: true, configurations: [], installCommand: "npm install -g @anthropic-ai/gemini-cli" },
			{ id: "builtin-cursor", name: "Cursor Agent", baseCommand: "agent", isDefault: true, configurations: [], installCommand: "npm install -g @anthropic-ai/cursor-agent" },
		]);
		vi.mocked(loadSettings).mockResolvedValue({
			defaultAgentId: "builtin-claude",
			defaultConfigId: "claude-default",
			taskDropPosition: "top",
			updateChannel: "stable",
		});
		vi.mocked(saveSettings).mockResolvedValue(undefined);
	});

	it("returns availability for all agents", async () => {
		mockSpawnSync.mockReturnValue({ exitCode: 1, stdout: null });
		const results = await handlers.checkAgentAvailability();
		expect(results).toHaveLength(4);
		expect(results[0].agentId).toBe("builtin-claude");
		expect(results[0].installed).toBe(false);
		expect(results[0].installCommand).toBe("brew install claude-code");
	});

	it("detects installed agent via which", async () => {
		vi.mocked(existsSync).mockImplementation((path) => String(path) === "/usr/local/bin/claude");
		mockSpawnSync.mockImplementation((args: string[]) => {
			if (args[0] === "which" && args[1] === "claude") {
				return { exitCode: 0, stdout: new TextEncoder().encode("/usr/local/bin/claude") };
			}
			return { exitCode: 1, stdout: null };
		});
		const results = await handlers.checkAgentAvailability();
		const claude = results.find((r) => r.agentId === "builtin-claude");
		expect(claude?.installed).toBe(true);
		expect(claude?.resolvedPath).toBe("/usr/local/bin/claude");
	});

	it("uses saved custom path for agent", async () => {
		vi.mocked(loadSettings).mockResolvedValue({
			defaultAgentId: "builtin-claude",
			defaultConfigId: "claude-default",
			taskDropPosition: "top",
			updateChannel: "stable",
			agentBinaryPaths: { "builtin-codex": "/custom/codex" },
		});
		vi.mocked(existsSync).mockImplementation((path: any) => path === "/custom/codex");
		mockSpawnSync.mockReturnValue({ exitCode: 1, stdout: null });

		const results = await handlers.checkAgentAvailability();
		const codex = results.find((r) => r.agentId === "builtin-codex");
		expect(codex?.installed).toBe(true);
		expect(codex?.resolvedPath).toBe("/custom/codex");
	});

	it("auto-saves resolved paths when found", async () => {
		vi.mocked(existsSync).mockImplementation((path) => String(path) === "/opt/homebrew/bin/claude");
		mockSpawnSync.mockImplementation((args: string[]) => {
			if (args[0] === "which" && args[1] === "claude") {
				return { exitCode: 0, stdout: new TextEncoder().encode("/opt/homebrew/bin/claude") };
			}
			return { exitCode: 1, stdout: null };
		});

		await handlers.checkAgentAvailability();
		expect(saveSettings).toHaveBeenCalledWith(expect.objectContaining({
			agentBinaryPaths: expect.objectContaining({ "builtin-claude": "/opt/homebrew/bin/claude" }),
		}));
	});

	it("reports customPathError when saved path no longer exists", async () => {
		vi.mocked(loadSettings).mockResolvedValue({
			defaultAgentId: "builtin-claude",
			defaultConfigId: "claude-default",
			taskDropPosition: "top",
			updateChannel: "stable",
			agentBinaryPaths: { "builtin-claude": "/deleted/path/claude" },
		});
		vi.mocked(existsSync).mockReturnValue(false);
		mockSpawnSync.mockReturnValue({ exitCode: 1, stdout: null });

		const results = await handlers.checkAgentAvailability();
		const claude = results.find((r) => r.agentId === "builtin-claude");
		expect(claude?.installed).toBe(false);
		expect(claude?.customPathError).toBe(true);
	});
});

// ---- setAgentBinaryPath ----

describe("setAgentBinaryPath", () => {
	beforeEach(() => {
		vi.mocked(existsSync).mockReset().mockReturnValue(true);
		vi.mocked(loadSettings).mockResolvedValue({
			defaultAgentId: "builtin-claude",
			defaultConfigId: "claude-default",
			taskDropPosition: "top",
			updateChannel: "stable",
		});
		vi.mocked(saveSettings).mockResolvedValue(undefined);
	});

	it("saves the binary path for an agent", async () => {
		await handlers.setAgentBinaryPath({ agentId: "builtin-claude", path: "/usr/local/bin/claude" });
		expect(saveSettings).toHaveBeenCalledWith(expect.objectContaining({
			agentBinaryPaths: { "builtin-claude": "/usr/local/bin/claude" },
		}));
	});

	it("throws when path does not exist", async () => {
		vi.mocked(existsSync).mockReturnValue(false);
		await expect(handlers.setAgentBinaryPath({ agentId: "builtin-claude", path: "/bad/path" }))
			.rejects.toThrow("File not found");
	});
});

// ---- triggerColumnAgentIfNeeded ----

describe("triggerColumnAgentIfNeeded", () => {
	function makeProcMock() {
		return {
			stdout: new Response("%1").body,
			stderr: new Response("").body,
			exited: Promise.resolve(0),
		};
	}

	beforeEach(() => {
		vi.clearAllMocks();
		vi.mocked(data.getProject).mockReset();
		vi.mocked(data.getTask).mockReset();
		vi.mocked(data.updateTask).mockReset();
		mockSpawn.mockReturnValue(makeProcMock());
		mockSpawnSync.mockReturnValue({ exitCode: 0, stdout: new TextEncoder().encode("") });
		vi.mocked(repoConfig.resolveProjectConfig).mockImplementation(async (project) => project);
		vi.mocked(agents.resolveCommandForAgent).mockResolvedValue({
			command: "claude 'review prompt'",
			agent: { id: "builtin-claude", name: "Claude", baseCommand: "claude", configurations: [], defaultConfigId: "" } as any,
			config: undefined,
			extraEnv: {},
		});
	});

	it("uses DEFAULT_REVIEW_PROMPT when builtinColumnAgents has empty prompt", async () => {
		const project = makeProject({
			builtinColumnAgents: {
				"review-by-ai": { agentId: "builtin-claude", configId: "claude-bypass-sonnet", prompt: "" },
			},
		});
		const task = makeTask({ status: "review-by-ai", worktreePath: "/tmp/wt" });

		vi.mocked(repoConfig.resolveProjectConfig).mockResolvedValue(project);

		await triggerColumnAgentIfNeeded("review-by-ai", project, task);

		expect(agents.resolveCommandForAgent).toHaveBeenCalledWith(
			"builtin-claude",
			"claude-bypass-sonnet",
			expect.objectContaining({
				taskDescription: expect.stringContaining("Review all changes on this branch"),
			}),
			expect.anything(),
		);
	});

	it("uses DEFAULT_REVIEW_PROMPT when builtinColumnAgents is absent", async () => {
		const project = makeProject();
		const task = makeTask({ status: "review-by-ai", worktreePath: "/tmp/wt" });

		vi.mocked(repoConfig.resolveProjectConfig).mockResolvedValue(project);

		await triggerColumnAgentIfNeeded("review-by-ai", project, task);

		expect(agents.resolveCommandForAgent).toHaveBeenCalledWith(
			"builtin-claude",
			"claude-bypass-sonnet",
			expect.objectContaining({
				taskDescription: expect.stringContaining("Review all changes on this branch"),
			}),
			expect.anything(),
		);
	});

	it("uses custom prompt when provided", async () => {
		const customPrompt = "Custom review: check for security issues only";
		const project = makeProject({
			builtinColumnAgents: {
				"review-by-ai": { agentId: "builtin-claude", configId: "claude-bypass-sonnet", prompt: customPrompt },
			},
		});
		const task = makeTask({ status: "review-by-ai", worktreePath: "/tmp/wt" });

		vi.mocked(repoConfig.resolveProjectConfig).mockResolvedValue(project);

		await triggerColumnAgentIfNeeded("review-by-ai", project, task);

		expect(agents.resolveCommandForAgent).toHaveBeenCalledWith(
			"builtin-claude",
			"claude-bypass-sonnet",
			expect.objectContaining({
				taskDescription: customPrompt,
			}),
			expect.anything(),
		);
	});

	it("adds the session-scoped hook override to a Codex review agent", async () => {
		const project = makeProject({
			autoReviewEnabled: true,
			builtinColumnAgents: {
				"review-by-ai": { agentId: "builtin-codex", configId: "codex-default", prompt: "Review" },
			},
		});
		const task = makeTask({ status: "review-by-ai", worktreePath: "/tmp/wt" });
		const writeSpy = vi.spyOn(Bun, "write").mockResolvedValue(undefined as never);
		vi.mocked(repoConfig.resolveProjectConfig).mockResolvedValue(project);
		vi.mocked(agents.resolveCommandForAgent).mockResolvedValueOnce({
			command: "codex 'Review'",
			agent: { id: "builtin-codex", name: "Codex", baseCommand: "codex", configurations: [], defaultConfigId: "" } as any,
			config: undefined,
			extraEnv: {},
		});
		vi.mocked(setupAgentHooks).mockResolvedValueOnce("hooks={Stop=[]}");

		try {
			await triggerColumnAgentIfNeeded("review-by-ai", project, task);

			const scriptCall = writeSpy.mock.calls.find(([path]) => String(path).endsWith("-col-agent.sh"));
			expect(String(scriptCall?.[1] ?? "")).toContain("codex -c 'hooks={Stop=[]}' 'Review'");
		} finally {
			writeSpy.mockRestore();
		}
	});

	it("defaults agentId and configId when config has empty values", async () => {
		const project = makeProject({
			builtinColumnAgents: {
				"review-by-ai": { agentId: "", configId: "", prompt: "" },
			},
		});
		const task = makeTask({ status: "review-by-ai", worktreePath: "/tmp/wt" });

		vi.mocked(repoConfig.resolveProjectConfig).mockResolvedValue(project);

		await triggerColumnAgentIfNeeded("review-by-ai", project, task);

		expect(agents.resolveCommandForAgent).toHaveBeenCalledWith(
			"builtin-claude",
			"claude-bypass-sonnet",
			expect.anything(),
			expect.anything(),
		);
	});

	it("skips when builtinColumnAgents exists but review-by-ai key is absent", async () => {
		const project = makeProject({
			builtinColumnAgents: {},
		});
		const task = makeTask({ status: "review-by-ai", worktreePath: "/tmp/wt" });

		vi.mocked(repoConfig.resolveProjectConfig).mockResolvedValue(project);

		await triggerColumnAgentIfNeeded("review-by-ai", project, task);

		expect(agents.resolveCommandForAgent).not.toHaveBeenCalled();
	});

	it("keeps review-agent launch failure best-effort when its fallback move cannot persist", async () => {
		const project = makeProject();
		const task = makeTask({ status: "review-by-ai", worktreePath: "/tmp/wt" });
		vi.mocked(agents.resolveCommandForAgent).mockRejectedValueOnce(new Error("agent unavailable"));
		vi.mocked(data.updateTask).mockRejectedValueOnce(new Error("task write failed"));

		await expect(triggerColumnAgentIfNeeded("review-by-ai", project, task)).resolves.toBeUndefined();

		expect(data.updateTask).toHaveBeenCalledWith(
			project,
			task.id,
			expect.objectContaining({
				status: "review-by-user",
				customColumnId: null,
				runtimeState: expect.objectContaining({ runtime: "running" }),
			}),
			{ dropPosition: "top", ifStatus: "review-by-ai" },
		);
	});

	it("falls back to review-by-user when review-agent configuration cannot resolve", async () => {
		const project = makeProject();
		const task = makeTask({ status: "review-by-ai", worktreePath: "/tmp/wt" });
		vi.mocked(repoConfig.resolveProjectConfig).mockRejectedValueOnce(new Error("invalid review config"));
		mockTaskWrites(task);

		await triggerColumnAgentIfNeeded("review-by-ai", project, task);

		expect(data.updateTask).toHaveBeenCalledWith(
			project,
			task.id,
			expect.objectContaining({ status: "review-by-user", customColumnId: null }),
			{ dropPosition: "top", ifStatus: "review-by-ai" },
		);
	});

	it("notifies the user via pushMessage when a custom-column agent fails to launch", async () => {
		// Bug M7·Y: review-by-ai has a fallback path, but a custom-column agent
		// failure would previously leave the task silently parked with no agent
		// and no notification.
		const project = makeProject();
		const task = makeTask({ status: "in-progress", worktreePath: "/tmp/wt" });
		const customColumn: any = {
			id: "col-1",
			name: "Security Review",
			color: "#abcdef",
			agentConfig: { agentId: "builtin-claude", configId: "claude-bypass-sonnet", prompt: "audit" },
		};

		vi.mocked(agents.resolveCommandForAgent).mockRejectedValueOnce(
			new Error("boom: agent binary missing"),
		);

		const push = vi.fn();
		setPushMessage(push);

		await triggerColumnAgentIfNeeded(customColumn.id, project, task, { customColumn });

		const events = push.mock.calls.map((c) => c[0]);
		expect(events).toContain("columnAgentFailed");
		const payload = push.mock.calls.find((c) => c[0] === "columnAgentFailed")?.[1];
		expect(payload).toMatchObject({
			taskId: task.id,
			projectId: project.id,
			columnName: "Security Review",
		});
		expect(String(payload.error)).toContain("boom");
	});
});

// ================================================================
// notifyWatchedTaskStatusChange
// ================================================================

describe("notifyWatchedTaskStatusChange", () => {
	beforeEach(() => {
		vi.mocked(Utils.showNotification).mockClear();
		_resetWatchedNotificationState();
	});

	it("calls Utils.showNotification when task is watched and status changed", () => {
		const task = makeTask({ watched: true, seq: 42, customTitle: "Fix bug" });
		notifyWatchedTaskStatusChange(task, "in-progress", "review-by-user", "MyProject");

		expect(Utils.showNotification).toHaveBeenCalledWith({
			title: "#42 Fix bug",
			body: "In Progress → Review By User",
			subtitle: "MyProject",
			silent: true,
		});
	});

	it("skips notification when task is not watched", () => {
		const task = makeTask({ watched: false });
		notifyWatchedTaskStatusChange(task, "in-progress", "review-by-user", "MyProject");
		expect(Utils.showNotification).not.toHaveBeenCalled();
	});

	it("skips notification when watched is undefined", () => {
		const task = makeTask();
		notifyWatchedTaskStatusChange(task, "in-progress", "review-by-user", "MyProject");
		expect(Utils.showNotification).not.toHaveBeenCalled();
	});

	it("skips notification when old and new status are the same", () => {
		const task = makeTask({ watched: true });
		notifyWatchedTaskStatusChange(task, "in-progress", "in-progress", "MyProject");
		expect(Utils.showNotification).not.toHaveBeenCalled();
	});

	it("records the notification target so it can be consumed on window focus", () => {
		const task = makeTask({ watched: true, projectId: "proj-7" });
		notifyWatchedTaskStatusChange(task, "in-progress", "review-by-user", "MyProject");

		const consumed = consumeRecentWatchedNotification();
		expect(consumed).toEqual({ taskId: task.id, projectId: "proj-7" });
	});

	it("does not record the notification target when the task is not watched", () => {
		const task = makeTask({ watched: false });
		notifyWatchedTaskStatusChange(task, "in-progress", "review-by-user", "MyProject");
		expect(consumeRecentWatchedNotification()).toBeNull();
	});

	it("shows the banner but does NOT arm click-to-open when the app is in the foreground", () => {
		setAppForeground(true);
		const task = makeTask({ watched: true, projectId: "proj-fg" });
		notifyWatchedTaskStatusChange(task, "in-progress", "review-by-user", "MyProject");

		// Banner still shown — the user is just informed, not teleported.
		expect(Utils.showNotification).toHaveBeenCalledTimes(1);
		// Slot must stay empty so a later in-app click cannot trigger navigation.
		expect(consumeRecentWatchedNotification()).toBeNull();
	});

	it("arms click-to-open when the app is in the background", () => {
		setAppForeground(false);
		const task = makeTask({ watched: true, projectId: "proj-bg" });
		notifyWatchedTaskStatusChange(task, "in-progress", "review-by-user", "MyProject");

		expect(consumeRecentWatchedNotification()).toEqual({ taskId: task.id, projectId: "proj-bg" });
	});

	it("queues watched-task notifications until terminal focus ends", () => {
		const push = vi.fn();
		setPushMessage(push);
		setTerminalFocus(true);
		const task = makeTask({ watched: true, projectId: "proj-focus" });

		notifyWatchedTaskStatusChange(task, "in-progress", "review-by-user", "MyProject");

		expect(Utils.showNotification).not.toHaveBeenCalled();
		expect(push).not.toHaveBeenCalled();

		setTerminalFocus(false);

		expect(Utils.showNotification).toHaveBeenCalledTimes(1);
		expect(push).toHaveBeenCalledWith("webNotification", expect.objectContaining({ taskId: task.id, kind: "status-change" }));
	});
});

describe("web notification push (remote/browser mode mirror)", () => {
	beforeEach(() => {
		vi.mocked(Utils.showNotification).mockClear();
		_resetWatchedNotificationState();
	});

	afterEach(() => {
		setPushMessage(() => {});
	});

	it("pushes webNotification alongside the native banner on a watched status change", () => {
		const push = vi.fn();
		setPushMessage(push);
		const task = makeTask({ watched: true, seq: 7, customTitle: "Fix bug", projectId: "proj-x" });
		notifyWatchedTaskStatusChange(task, "in-progress", "review-by-user", "MyProject");

		expect(push).toHaveBeenCalledWith("webNotification", {
			taskId: task.id,
			projectId: "proj-x",
			title: "#7 Fix bug",
			kind: "status-change",
			body: "In Progress → Review By User",
			level: "info",
			taskSeq: 7,
			taskTitle: "Fix bug",
			projectName: "MyProject",
		});
	});

	it("does not push when the status did not actually change", () => {
		const push = vi.fn();
		setPushMessage(push);
		const task = makeTask({ watched: true });
		notifyWatchedTaskStatusChange(task, "in-progress", "in-progress", "MyProject");
		expect(push).not.toHaveBeenCalled();
	});

	it("pushes webNotification for a CLI --desktop notification", () => {
		const push = vi.fn();
		setPushMessage(push);
		const task = makeTask({ seq: 3, customTitle: "Ship it", projectId: "proj-y" });
		notifyFromCliDesktop({ task, body: "build done", projectName: "MyProject" });

		expect(push).toHaveBeenCalledWith("webNotification", {
			taskId: task.id,
			projectId: "proj-y",
			title: "#3 Ship it",
			kind: "event",
			body: "build done",
			level: "info",
			taskSeq: 3,
			taskTitle: "Ship it",
			projectName: "MyProject",
		});
	});

	it("pushes webNotification for a watched task event", () => {
		const push = vi.fn();
		setPushMessage(push);
		const task = makeTask({ watched: true, seq: 9, customTitle: "CI run", projectId: "proj-z" });
		notifyWatchedTaskEvent(task, "CI passed", "MyProject");

		expect(push).toHaveBeenCalledWith("webNotification", expect.objectContaining({
			taskId: task.id,
			title: "#9 CI run",
			body: "CI passed",
			level: "info",
		}));
	});

	it("does not push a watched event for an unwatched task", () => {
		const push = vi.fn();
		setPushMessage(push);
		const task = makeTask({ watched: false });
		notifyWatchedTaskEvent(task, "CI passed", "MyProject");
		expect(push).not.toHaveBeenCalled();
	});
});

describe("setAppForeground / isAppForeground", () => {
	beforeEach(() => {
		_resetWatchedNotificationState();
	});

	it("defaults to false after reset and toggles with setAppForeground", () => {
		expect(isAppForeground()).toBe(false);
		setAppForeground(true);
		expect(isAppForeground()).toBe(true);
		setAppForeground(false);
		expect(isAppForeground()).toBe(false);
	});

	it("handlers.setWindowForeground forwards the renderer's focus state", async () => {
		await handlers.setWindowForeground({ focused: true });
		expect(isAppForeground()).toBe(true);
		await handlers.setWindowForeground({ focused: false });
		expect(isAppForeground()).toBe(false);
	});
});

describe("consumeRecentWatchedNotification", () => {
	beforeEach(() => {
		vi.mocked(Utils.showNotification).mockClear();
		_resetWatchedNotificationState();
	});

	it("returns null when nothing has been recorded", () => {
		expect(consumeRecentWatchedNotification()).toBeNull();
	});

	it("returns and clears the stored target on first call", () => {
		const task = makeTask({ watched: true, projectId: "proj-A" });
		notifyWatchedTaskStatusChange(task, "todo", "in-progress", "P");

		expect(consumeRecentWatchedNotification()).toEqual({ taskId: task.id, projectId: "proj-A" });
		// Second call must yield null — the slot is one-shot.
		expect(consumeRecentWatchedNotification()).toBeNull();
	});

	it("returns null and clears the slot when the stored target is older than the TTL", () => {
		const task = makeTask({ watched: true, projectId: "proj-X" });
		notifyWatchedTaskStatusChange(task, "todo", "in-progress", "P");

		// Simulate a focus event arriving long after the notification.
		const farFuture = Date.now() + NOTIFICATION_CLICK_TTL_MS + 1000;
		expect(consumeRecentWatchedNotification(farFuture)).toBeNull();
		// Slot is cleared even on TTL miss — a stale entry must not bleed into a later focus.
		expect(consumeRecentWatchedNotification()).toBeNull();
	});

	it("each new notification overwrites the previous unconsumed target", () => {
		const taskA = makeTask({ id: "a", watched: true, projectId: "p" });
		const taskB = makeTask({ id: "b", watched: true, projectId: "p" });
		notifyWatchedTaskStatusChange(taskA, "todo", "in-progress", "P");
		notifyWatchedTaskStatusChange(taskB, "todo", "in-progress", "P");

		expect(consumeRecentWatchedNotification()).toEqual({ taskId: "b", projectId: "p" });
	});
});

// ================================================================
// toggleTaskWatch handler
// ================================================================

describe("toggleTaskWatch", () => {
	const push = vi.fn();

	beforeEach(() => {
		vi.mocked(data.getProject).mockReset();
		vi.mocked(data.updateTask).mockReset();
		push.mockClear();
		setPushMessage(push);
	});

	it("sets watched to true", async () => {
		const project = makeProject();
		const task = makeTask({ watched: true });
		vi.mocked(data.getProject).mockResolvedValue(project);
		vi.mocked(data.updateTask).mockResolvedValue(task);
		vi.mocked(saveSettings).mockClear();

		const result = await handlers.toggleTaskWatch({
			taskId: "task-1",
			projectId: project.id,
			watched: true,
		});

		expect(data.updateTask).toHaveBeenCalledWith(project, "task-1", { watched: true });
		expect(saveSettings).not.toHaveBeenCalled();
		expect(result.watched).toBe(true);
		expect(push).toHaveBeenCalledWith("taskUpdated", { projectId: project.id, task });
	});

	it("sets watched to false", async () => {
		const project = makeProject();
		const task = makeTask({ watched: false });
		vi.mocked(data.getProject).mockResolvedValue(project);
		vi.mocked(data.updateTask).mockResolvedValue(task);
		vi.mocked(saveSettings).mockClear();

		const result = await handlers.toggleTaskWatch({
			taskId: "task-1",
			projectId: project.id,
			watched: false,
		});

		expect(data.updateTask).toHaveBeenCalledWith(project, "task-1", { watched: false });
		expect(saveSettings).not.toHaveBeenCalled();
		expect(result.watched).toBe(false);
		expect(push).toHaveBeenCalledWith("taskUpdated", { projectId: project.id, task });
	});
});

describe("handlers.createPullRequest", () => {
	function sendKeysCalls() {
		return mockSpawn.mock.calls
			.map((c) => c[0] as string[])
			.filter((args) => args.includes("send-keys"));
	}

	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("sends the PR prompt to the active pane of the task session", async () => {
		vi.useFakeTimers();
		const project = makeProject();
		const task = makeTask({ id: "task-1", worktreePath: "/tmp/test-worktree" });
		vi.mocked(data.getProject).mockResolvedValue(project);
		vi.mocked(data.getTask).mockResolvedValue(task);
		mockSpawn.mockImplementation((args: string[]) => ({
			stdout: args.includes("display-message") ? "%3\n" : "",
			stderr: "",
			exited: Promise.resolve(0),
		}));

		await handlers.createPullRequest({ taskId: "task-1", projectId: project.id });

		const paste = sendKeysCalls();
		expect(paste).toHaveLength(1);
		expect(paste[0]).toEqual(expect.arrayContaining(["send-keys", "-t", "%3"]));
		expect(paste[0]?.some((a) => a.includes("gh pr create"))).toBe(true);

		// Enter is sent as a discrete keypress after a short delay.
		vi.advanceTimersByTime(800);
		const all = sendKeysCalls();
		expect(all).toHaveLength(2);
		expect(all[1]).toEqual(["tmux", "-L", "dev3", "send-keys", "-t", "%3", "Enter"]);
		vi.useRealTimers();
	});

	it("sends the auto-merge variant prompt when autoMerge is set", async () => {
		vi.useFakeTimers();
		const project = makeProject();
		const task = makeTask({ id: "task-1", worktreePath: "/tmp/test-worktree" });
		vi.mocked(data.getProject).mockResolvedValue(project);
		vi.mocked(data.getTask).mockResolvedValue(task);
		mockSpawn.mockImplementation((args: string[]) => ({
			stdout: args.includes("display-message") ? "%3\n" : "",
			stderr: "",
			exited: Promise.resolve(0),
		}));

		await handlers.createPullRequest({ taskId: "task-1", projectId: project.id, autoMerge: true });

		const paste = sendKeysCalls();
		expect(paste).toHaveLength(1);
		expect(paste[0]?.some((a) => a.includes("gh pr create"))).toBe(true);
		expect(paste[0]?.some((a) => a.includes("gh pr merge --auto"))).toBe(true);
		vi.useRealTimers();
	});

	it("does not enable auto-merge in the default prompt", async () => {
		vi.useFakeTimers();
		const project = makeProject();
		const task = makeTask({ id: "task-1", worktreePath: "/tmp/test-worktree" });
		vi.mocked(data.getProject).mockResolvedValue(project);
		vi.mocked(data.getTask).mockResolvedValue(task);
		mockSpawn.mockImplementation((args: string[]) => ({
			stdout: args.includes("display-message") ? "%3\n" : "",
			stderr: "",
			exited: Promise.resolve(0),
		}));

		await handlers.createPullRequest({ taskId: "task-1", projectId: project.id });

		const paste = sendKeysCalls();
		expect(paste[0]?.some((a) => a.includes("gh pr merge --auto"))).toBe(false);
		vi.useRealTimers();
	});

	it("silently does nothing when there is no active pane", async () => {
		const project = makeProject();
		const task = makeTask({ id: "task-1", worktreePath: "/tmp/test-worktree" });
		vi.mocked(data.getProject).mockResolvedValue(project);
		vi.mocked(data.getTask).mockResolvedValue(task);
		mockSpawn.mockImplementation(() => ({
			stdout: "",
			stderr: "",
			exited: Promise.resolve(0),
		}));

		await handlers.createPullRequest({ taskId: "task-1", projectId: project.id });

		expect(sendKeysCalls()).toHaveLength(0);
	});

	// Issue #609: with a single agent pane the prompt must land in that pane even
	// when a different (non-agent) pane is focused — the active pane must NOT win.
	it("routes to the sole agent pane, ignoring a different active pane", async () => {
		vi.useFakeTimers();
		const project = makeProject();
		const task = makeTask({
			id: "task-1",
			worktreePath: "/tmp/test-worktree",
			sessionState: { panes: [{ paneId: "%5", agentCmd: "claude", sessionId: null, agentId: null, configId: null }] },
		});
		vi.mocked(data.getProject).mockResolvedValue(project);
		vi.mocked(data.getTask).mockResolvedValue(task);
		mockSpawn.mockImplementation((args: string[]) => ({
			// Active pane is a non-agent split (%3); the agent lives in %5.
			stdout: args.includes("display-message") ? "%3\n" : args.includes("list-panes") ? "%3\n%5\n" : "",
			stderr: "",
			exited: Promise.resolve(0),
		}));

		await handlers.createPullRequest({ taskId: "task-1", projectId: project.id });

		const paste = sendKeysCalls();
		expect(paste).toHaveLength(1);
		expect(paste[0]).toEqual(expect.arrayContaining(["send-keys", "-t", "%5"]));

		vi.advanceTimersByTime(800);
		const all = sendKeysCalls();
		expect(all[1]).toEqual(["tmux", "-L", "dev3", "send-keys", "-t", "%5", "Enter"]);
		vi.useRealTimers();
	});

	// With two or more agent panes the target is ambiguous, so respect focus.
	it("routes to the active pane when there are two agent panes", async () => {
		const project = makeProject();
		const task = makeTask({
			id: "task-1",
			worktreePath: "/tmp/test-worktree",
			sessionState: {
				panes: [
					{ paneId: "%5", agentCmd: "claude", sessionId: null, agentId: null, configId: null },
					{ paneId: "%7", agentCmd: "codex", sessionId: null, agentId: null, configId: null },
				],
			},
		});
		vi.mocked(data.getProject).mockResolvedValue(project);
		vi.mocked(data.getTask).mockResolvedValue(task);
		mockSpawn.mockImplementation((args: string[]) => ({
			stdout: args.includes("display-message") ? "%3\n" : args.includes("list-panes") ? "%3\n%5\n%7\n" : "",
			stderr: "",
			exited: Promise.resolve(0),
		}));

		await handlers.createPullRequest({ taskId: "task-1", projectId: project.id });

		const paste = sendKeysCalls();
		expect(paste).toHaveLength(1);
		expect(paste[0]).toEqual(expect.arrayContaining(["send-keys", "-t", "%3"]));
	});

	it("routes to the active Codex main pane when its pane id is not persisted", async () => {
		const project = makeProject();
		const task = makeTask({
			id: "task-1",
			worktreePath: "/tmp/test-worktree",
			sessionState: {
				panes: [
					{ paneId: null, agentCmd: "codex", sessionId: null, agentId: "builtin-codex", configId: null },
					{ paneId: "%7", agentCmd: "claude", sessionId: null, agentId: "builtin-claude", configId: null },
				],
			},
		});
		vi.mocked(data.getProject).mockResolvedValue(project);
		vi.mocked(data.getTask).mockResolvedValue(task);
		mockSpawn.mockImplementation((args: string[]) => ({
			stdout: args.includes("display-message") ? "%3\n" : args.includes("list-panes") ? "%3\n%7\n" : "",
			stderr: "",
			exited: Promise.resolve(0),
		}));

		await handlers.createPullRequest({ taskId: "task-1", projectId: project.id });

		const paste = sendKeysCalls();
		expect(paste).toHaveLength(1);
		expect(paste[0]).toEqual(expect.arrayContaining(["send-keys", "-t", "%3"]));
	});

	it("routes a legacy Codex main pane before a focused shell split", async () => {
		const project = makeProject();
		const task = makeTask({
			id: "task-1",
			worktreePath: "/tmp/test-worktree",
			sessionState: {
				panes: [{ paneId: null, agentCmd: "codex", sessionId: null, agentId: "builtin-codex", configId: null }],
			},
		});
		vi.mocked(data.getProject).mockResolvedValue(project);
		vi.mocked(data.getTask).mockResolvedValue(task);
		mockSpawn.mockImplementation((args: string[]) => ({
			// The initial agent pane is listed first, but a shell split is focused.
			stdout: args.includes("display-message") ? "%3\n" : args.includes("list-panes") ? "%5\n%3\n" : "",
			stderr: "",
			exited: Promise.resolve(0),
		}));

		await handlers.createPullRequest({ taskId: "task-1", projectId: project.id });

		const paste = sendKeysCalls();
		expect(paste).toHaveLength(1);
		expect(paste[0]).toEqual(expect.arrayContaining(["send-keys", "-t", "%5"]));
	});

	// A registered agent pane that no longer exists must not hijack the routing —
	// fall back to the active pane (preserves the legacy behavior).
	it("falls back to the active pane when the recorded agent pane is dead", async () => {
		const project = makeProject();
		const task = makeTask({
			id: "task-1",
			worktreePath: "/tmp/test-worktree",
			sessionState: { panes: [{ paneId: "%5", agentCmd: "claude", sessionId: null, agentId: null, configId: null }] },
		});
		vi.mocked(data.getProject).mockResolvedValue(project);
		vi.mocked(data.getTask).mockResolvedValue(task);
		mockSpawn.mockImplementation((args: string[]) => ({
			// %5 is gone; only the active pane %3 is live.
			stdout: args.includes("display-message") ? "%3\n" : args.includes("list-panes") ? "%3\n" : "",
			stderr: "",
			exited: Promise.resolve(0),
		}));

		await handlers.createPullRequest({ taskId: "task-1", projectId: project.id });

		const paste = sendKeysCalls();
		expect(paste).toHaveLength(1);
		expect(paste[0]).toEqual(expect.arrayContaining(["send-keys", "-t", "%3"]));
	});

	it("throws when the task has no worktree", async () => {
		const project = makeProject();
		const task = makeTask({ id: "task-1", worktreePath: null });
		vi.mocked(data.getProject).mockResolvedValue(project);
		vi.mocked(data.getTask).mockResolvedValue(task);

		await expect(
			handlers.createPullRequest({ taskId: "task-1", projectId: project.id }),
		).rejects.toThrow("Task has no worktree");
	});
});

// handlers.openInApp — launching external editors / Finder.
// Issue: Zed launched via `open -a Zed` reuses its window and swaps the
// project, so worktree B replaces worktree A. The Zed CLI's `-n` flag is
// required to give each worktree its own window.
describe("handlers.openInApp", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.mocked(existsSync).mockReturnValue(true);
	});

	it("opens a path in Finder via `open <path>`", async () => {
		await handlers.openInApp({ appName: "Finder", path: "/tmp/work" });
		expect(mockSpawn).toHaveBeenCalledWith(["open", "/tmp/work"], expect.anything());
	});

	it("opens non-Zed editors via `open -a <app> <path>`", async () => {
		await handlers.openInApp({ appName: "Visual Studio Code", path: "/tmp/work" });
		expect(mockSpawn).toHaveBeenCalledWith(
			["open", "-a", "Visual Studio Code", "/tmp/work"],
			expect.anything(),
		);
	});

	it("opens Zed in a NEW window via the bundled Zed CLI `-n` flag", async () => {
		// Only the bundled cli inside the app exists (no `zed` on PATH).
		vi.mocked(existsSync).mockImplementation(
			(p) => p === "/Applications/Zed.app/Contents/MacOS/cli",
		);
		await handlers.openInApp({ appName: "Zed", path: "/tmp/work" });
		expect(mockSpawn).toHaveBeenCalledWith(
			["/Applications/Zed.app/Contents/MacOS/cli", "-n", "/tmp/work"],
			expect.anything(),
		);
	});

	it("prefers a Zed CLI on PATH over the app bundle", async () => {
		// All candidates exist → the first (PATH binary) wins.
		vi.mocked(existsSync).mockReturnValue(true);
		await handlers.openInApp({ appName: "Zed", path: "/tmp/work" });
		expect(mockSpawn).toHaveBeenCalledWith(
			["/usr/local/bin/zed", "-n", "/tmp/work"],
			expect.anything(),
		);
	});

	it("falls back to `open -a Zed` when no Zed CLI is found", async () => {
		vi.mocked(existsSync).mockReturnValue(false);
		await handlers.openInApp({ appName: "Zed", path: "/tmp/work" });
		expect(mockSpawn).toHaveBeenCalledWith(
			["open", "-a", "Zed", "/tmp/work"],
			expect.anything(),
		);
	});

	it("rejects relative paths and path traversal", async () => {
		await expect(
			handlers.openInApp({ appName: "Zed", path: "relative/path" }),
		).rejects.toThrow("Invalid path");
		await expect(
			handlers.openInApp({ appName: "Zed", path: "/tmp/../etc/passwd" }),
		).rejects.toThrow("Invalid path");
	});

	it("rejects app names containing a slash", async () => {
		await expect(
			handlers.openInApp({ appName: "../evil", path: "/tmp/work" }),
		).rejects.toThrow("Invalid app name");
	});
});

describe("handlers.getProjectPtyUrl — virtual board guard", () => {
	beforeEach(() => {
		vi.mocked(pty.hasSession).mockReturnValue(false);
		vi.mocked(pty.hasDeadSession).mockReturnValue(false);
	});

	it("rejects a virtual (Operations) board instead of opening a doomed terminal", async () => {
		// A virtual board's synthetic path is created lazily per-task; without the
		// guard getProjectPtyUrl threw "Project path does not exist" (or opened a
		// shell in dev3's internal data dir). Now it rejects with a clear message.
		vi.mocked(data.getProject).mockResolvedValue(
			makeProject({ kind: "virtual", path: "/Users/x/.dev3.0/ops/operations" }),
		);
		await expect(handlers.getProjectPtyUrl({ projectId: "vproj-1" })).rejects.toThrow(/Operations boards/);
	});

	it("opens a project terminal for a normal git project (guard does not over-fire)", async () => {
		vi.mocked(data.getProject).mockResolvedValue(makeProject({ path: "/tmp/real-repo" }));
		vi.mocked(existsSync).mockReturnValue(true);
		const url = await handlers.getProjectPtyUrl({ projectId: "proj-1" });
		expect(url).toContain("session=project-proj-1");
	});
});


// ----------------------------------------------------------------------------
// handlers.tmuxPaneNavigate (narrow-viewport pane carousel)
// ----------------------------------------------------------------------------
describe("handlers.tmuxPaneNavigate", () => {
	const TASK_ID = "abcd1234-0000-0000-0000-000000000000";
	const SESSION = "dev3-abcd1234";
	const SEP = "\t";
	const HOST = "mac";

	// One list-panes row: id, active, zoom, current_command, host_short, title.
	// Title defaults to the hostname (tmux default) so labels fall back to cmd.
	function row(id: string, active: string, zoom: string, cmd: string, title: string = HOST): string {
		return [id, active, zoom, cmd, HOST, title].join(SEP);
	}
	const lay = (...rows: string[]) => rows.join("\n");

	// list-panes output is FIFO: each readPaneLayout consumes the next layout,
	// falling back to the last. Every other tmux command exits 0.
	function mockLayouts(layouts: string[]) {
		const queue = [...layouts];
		mockSpawn.mockReset();
		mockSpawn.mockImplementation((args: string[]) => {
			if (args.includes("list-panes")) {
				const out = queue.length > 1 ? queue.shift()! : queue[0] ?? "";
				return { stdout: out, stderr: new Response(""), exited: Promise.resolve(0) };
			}
			return { stdout: "", stderr: new Response(""), exited: Promise.resolve(0) };
		});
	}

	const calls = () => mockSpawn.mock.calls.map((c) => c[0] as string[]);
	const called = (needle: string) => calls().some((a) => a.join(" ").includes(needle));

	it("zoom-on-entry: zooms a multi-pane window that is not yet zoomed", async () => {
		mockLayouts([lay(row("%1", "1", "0", "claude"), row("%2", "0", "0", "bash"), row("%3", "0", "0", "zsh"))]);
		const res = await handlers.tmuxPaneNavigate({ taskId: TASK_ID, zoom: true });
		expect(res).toEqual({ count: 3, activeIndex: 0, zoomed: true, labels: ["claude", "bash", "zsh"] });
		expect(called("resize-pane -Z")).toBe(true);
		expect(called("select-pane")).toBe(false);
	});

	it("labels prefer an explicitly-set pane title over the command", async () => {
		mockLayouts([lay(row("%1", "1", "0", "node", "Agent"), row("%2", "0", "0", "node", "Dev Server"))]);
		const res = await handlers.tmuxPaneNavigate({ taskId: TASK_ID, zoom: true });
		expect(res.labels).toEqual(["Agent", "Dev Server"]);
	});

	it("step next + keep-zoom: selects the next pane then re-zooms it", async () => {
		mockLayouts([
			lay(row("%1", "1", "0", "claude"), row("%2", "0", "0", "bash"), row("%3", "0", "0", "zsh")), // before
			lay(row("%1", "0", "0", "claude"), row("%2", "1", "0", "bash"), row("%3", "0", "0", "zsh")), // after select (active moved, auto-unzoomed)
		]);
		const res = await handlers.tmuxPaneNavigate({ taskId: TASK_ID, step: "next", zoom: true });
		expect(res).toEqual({ count: 3, activeIndex: 1, zoomed: true, labels: ["claude", "bash", "zsh"] });
		expect(called(`select-pane -t ${SESSION}:.+`)).toBe(true);
		expect(called("resize-pane -Z")).toBe(true);
	});

	it("absolute index: selects that pane by its id", async () => {
		mockLayouts([
			lay(row("%1", "1", "0", "claude"), row("%2", "0", "0", "bash"), row("%3", "0", "0", "zsh")),
			lay(row("%1", "0", "0", "claude"), row("%2", "0", "0", "bash"), row("%3", "1", "0", "zsh")),
		]);
		const res = await handlers.tmuxPaneNavigate({ taskId: TASK_ID, index: 2, zoom: true });
		expect(res.activeIndex).toBe(2);
		expect(called("select-pane -t %3")).toBe(true);
	});

	it("single pane: no navigation, no zoom, hides nothing to switch", async () => {
		mockLayouts([lay(row("%1", "1", "0", "claude"))]);
		const res = await handlers.tmuxPaneNavigate({ taskId: TASK_ID, step: "next", zoom: true });
		expect(res).toEqual({ count: 1, activeIndex: 0, zoomed: false, labels: ["claude"] });
		expect(called("select-pane")).toBe(false);
		expect(called("resize-pane")).toBe(false);
	});

	it("idempotent zoom: already zoomed + zoom:true is a no-op", async () => {
		mockLayouts([lay(row("%1", "1", "1", "claude"), row("%2", "0", "1", "bash"), row("%3", "0", "1", "zsh"))]);
		const res = await handlers.tmuxPaneNavigate({ taskId: TASK_ID, zoom: true });
		expect(res).toEqual({ count: 3, activeIndex: 0, zoomed: true, labels: ["claude", "bash", "zsh"] });
		expect(called("resize-pane")).toBe(false);
	});

	it("zoom:false unzooms a zoomed window (pager unmount / restore split)", async () => {
		mockLayouts([lay(row("%1", "1", "1", "claude"), row("%2", "0", "1", "bash"))]);
		const res = await handlers.tmuxPaneNavigate({ taskId: TASK_ID, zoom: false });
		expect(res).toEqual({ count: 2, activeIndex: 0, zoomed: false, labels: ["claude", "bash"] });
		expect(called("resize-pane -Z")).toBe(true);
	});
});

// ----------------------------------------------------------------------------
// handlers.tmuxWindowNavigate (narrow-viewport window switcher)
// ----------------------------------------------------------------------------
describe("handlers.tmuxWindowNavigate", () => {
	const TASK_ID = "abcd1234-0000-0000-0000-000000000000";
	const SESSION = "dev3-abcd1234";
	const SEP = "\t";

	// One list-windows row: window_id, window_active, window_name.
	function row(id: string, active: string, name: string): string {
		return [id, active, name].join(SEP);
	}
	const lay = (...rows: string[]) => rows.join("\n");

	// list-windows output is FIFO: each readWindowLayout consumes the next layout,
	// falling back to the last. Every other tmux command exits 0.
	function mockLayouts(layouts: string[]) {
		const queue = [...layouts];
		mockSpawn.mockReset();
		mockSpawn.mockImplementation((args: string[]) => {
			if (args.includes("list-windows")) {
				const out = queue.length > 1 ? queue.shift()! : queue[0] ?? "";
				return { stdout: out, stderr: new Response(""), exited: Promise.resolve(0) };
			}
			return { stdout: "", stderr: new Response(""), exited: Promise.resolve(0) };
		});
	}

	const calls = () => mockSpawn.mock.calls.map((c) => c[0] as string[]);
	const called = (needle: string) => calls().some((a) => a.join(" ").includes(needle));

	it("read-only (no step/index) returns the layout and never selects", async () => {
		mockLayouts([lay(row("@1", "1", "claude"), row("@2", "0", "shell"), row("@3", "0", "logs"))]);
		const res = await handlers.tmuxWindowNavigate({ taskId: TASK_ID });
		expect(res).toEqual({ count: 3, activeIndex: 0, labels: ["claude", "shell", "logs"] });
		expect(called("select-window")).toBe(false);
	});

	it("labels use the window name (tmux auto-names by command)", async () => {
		mockLayouts([lay(row("@1", "1", "nvim"), row("@2", "0", "build"))]);
		const res = await handlers.tmuxWindowNavigate({ taskId: TASK_ID });
		expect(res.labels).toEqual(["nvim", "build"]);
	});

	it("step next: selects the next window then re-reads", async () => {
		mockLayouts([
			lay(row("@1", "1", "claude"), row("@2", "0", "shell"), row("@3", "0", "logs")), // before
			lay(row("@1", "0", "claude"), row("@2", "1", "shell"), row("@3", "0", "logs")), // after select
		]);
		const res = await handlers.tmuxWindowNavigate({ taskId: TASK_ID, step: "next" });
		expect(res).toEqual({ count: 3, activeIndex: 1, labels: ["claude", "shell", "logs"] });
		expect(called(`select-window -t ${SESSION}:+`)).toBe(true);
	});

	it("step prev: selects the previous window", async () => {
		mockLayouts([
			lay(row("@1", "0", "claude"), row("@2", "1", "shell")),
			lay(row("@1", "1", "claude"), row("@2", "0", "shell")),
		]);
		const res = await handlers.tmuxWindowNavigate({ taskId: TASK_ID, step: "prev" });
		expect(res.activeIndex).toBe(0);
		expect(called(`select-window -t ${SESSION}:-`)).toBe(true);
	});

	it("absolute index: selects that window by its id", async () => {
		mockLayouts([
			lay(row("@1", "1", "claude"), row("@2", "0", "shell"), row("@3", "0", "logs")),
			lay(row("@1", "0", "claude"), row("@2", "0", "shell"), row("@3", "1", "logs")),
		]);
		const res = await handlers.tmuxWindowNavigate({ taskId: TASK_ID, index: 2 });
		expect(res.activeIndex).toBe(2);
		expect(called("select-window -t @3")).toBe(true);
	});

	it("single window: no navigation even when a step is requested", async () => {
		mockLayouts([lay(row("@1", "1", "claude"))]);
		const res = await handlers.tmuxWindowNavigate({ taskId: TASK_ID, step: "next" });
		expect(res).toEqual({ count: 1, activeIndex: 0, labels: ["claude"] });
		expect(called("select-window")).toBe(false);
	});

	it("no session / tmux error: returns an empty layout", async () => {
		mockSpawn.mockReset();
		mockSpawn.mockImplementation((args: string[]) => {
			if (args.includes("list-windows")) {
				return { stdout: "", stderr: new Response("no server"), exited: Promise.resolve(1) };
			}
			return { stdout: "", stderr: new Response(""), exited: Promise.resolve(0) };
		});
		const res = await handlers.tmuxWindowNavigate({ taskId: TASK_ID, step: "next" });
		expect(res).toEqual({ count: 0, activeIndex: 0, labels: [] });
		expect(called("select-window")).toBe(false);
	});
});

describe("handlers.getLastRoute / saveLastRoute — fresh-start (dev) mode", () => {
	const ORIGINAL_FRESH = process.env.DEV3_FRESH_START;

	beforeEach(() => {
		vi.mocked(data.loadLastRoute).mockReset();
		vi.mocked(data.saveLastRoute).mockReset();
	});

	afterEach(() => {
		if (ORIGINAL_FRESH === undefined) delete process.env.DEV3_FRESH_START;
		else process.env.DEV3_FRESH_START = ORIGINAL_FRESH;
	});

	it("normally restores the persisted route", async () => {
		delete process.env.DEV3_FRESH_START;
		vi.mocked(data.loadLastRoute).mockResolvedValue(JSON.stringify({ screen: "project", projectId: "p1" }));
		const res = await handlers.getLastRoute();
		expect(res).toEqual({ route: JSON.stringify({ screen: "project", projectId: "p1" }) });
		expect(data.loadLastRoute).toHaveBeenCalledTimes(1);
	});

	it("returns no route in fresh-start mode (always land on dashboard)", async () => {
		process.env.DEV3_FRESH_START = "1";
		vi.mocked(data.loadLastRoute).mockResolvedValue(JSON.stringify({ screen: "project", projectId: "p1" }));
		const res = await handlers.getLastRoute();
		expect(res).toEqual({ route: null });
		// Must not even read the persisted route.
		expect(data.loadLastRoute).not.toHaveBeenCalled();
	});

	it("normally persists the route", async () => {
		delete process.env.DEV3_FRESH_START;
		await handlers.saveLastRoute({ route: JSON.stringify({ screen: "dashboard" }) });
		expect(data.saveLastRoute).toHaveBeenCalledWith(JSON.stringify({ screen: "dashboard" }));
	});

	it("does not persist the route in fresh-start mode (never clobbers shared state)", async () => {
		process.env.DEV3_FRESH_START = "1";
		await handlers.saveLastRoute({ route: JSON.stringify({ screen: "project", projectId: "p1" }) });
		expect(data.saveLastRoute).not.toHaveBeenCalled();
	});
});

describe("handlers.previewUpdatePopover", () => {
	// Under vitest `import.meta.dir` is empty, so the repo-root walk finds no
	// change-logs dir — the handler must degrade to a safe unavailable result
	// rather than throw. The git-window computation itself is unit-tested via the
	// shared resolvePrevTag / changedKeysFromPaths / selectReleaseWindow helpers.
	it("degrades to a safe unavailable result when no repo root is resolvable", async () => {
		const res = await handlers.previewUpdatePopover();
		expect(res.available).toBe(false);
		expect(res.changelog).toBeNull();
		expect(res.diagnostics.includesUncommitted).toBe(true);
	});
});
