import { describe, it, expect, vi, beforeEach } from "vitest";
import type { GlobalSettings, Project, Task } from "../../shared/types";
import { getPreparingStageProgress } from "../../shared/types";

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
	loadTasks: vi.fn(),
	updateTask: vi.fn(),
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
}));

vi.mock("../git", () => ({
	removeWorktree: vi.fn(),
	createWorktree: vi.fn(),
	applySparseCheckout: vi.fn(),
	isGitRepo: vi.fn(),
	getDefaultBranch: vi.fn(),
	fetchOrigin: vi.fn(),
	getBranchStatus: vi.fn(),
	getTaskDiff: vi.fn(),
	getUncommittedChanges: vi.fn(),
	getUnpushedCount: vi.fn(),
	getBranchDiffStats: vi.fn(),
	canRebaseCleanly: vi.fn(),
	isContentMergedInto: vi.fn(),
	cloneRepo: vi.fn(),
	extractRepoName: vi.fn(),
	getCurrentBranch: vi.fn(),
	getHeadSha: vi.fn(),
	isWorktreeDirty: vi.fn(),
	listBranches: vi.fn(),
	pullOrigin: vi.fn(),
	saveDiffSnapshot: vi.fn().mockResolvedValue(undefined),
	taskDir: vi.fn(),
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
	getPtyPort: vi.fn(() => 9999),
	getSessionProjectId: vi.fn(() => null),
	getSessionSocket: vi.fn(() => "dev3"),
	getSessionTmuxName: vi.fn((key: string) => `dev3-${key.slice(0, 8)}`),
	getSessionType: vi.fn(() => null),
	capturePane: vi.fn(),
	applyTmuxTheme: vi.fn(),
	tmuxArgs: vi.fn((_socket: string, ...args: string[]) => ["tmux", "-L", _socket, ...args]),
	setTmuxBinary: vi.fn(),
	getTmuxBinary: vi.fn(() => "tmux"),
	TMUX_CONF_PATH: "/tmp/dev3-tmux.conf",
	DEFAULT_TMUX_SOCKET: "dev3",
	HOME_TERMINAL_SESSION_KEY: "home",
	HOME_TERMINAL_TMUX_NAME: "dev3-home",
}));

vi.mock("../system-clipboard", () => ({
	writeSystemClipboard: vi.fn(() => "pbcopy"),
}));

vi.mock("../agents", () => ({
	ensureClaudeTrust: vi.fn(),
	ensureCodexTrust: vi.fn(),
	ensureGeminiTrust: vi.fn(),
	isClaudeCommand: vi.fn(() => false),
	isCodexCommand: vi.fn((cmd: string) => cmd === "codex"),
	isGeminiCommand: vi.fn(() => false),
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
}));

vi.mock("../repo-config", () => ({
	resolveProjectConfig: vi.fn((project: any) => project),
	migrateProjectConfig: vi.fn(),
	loadRepoConfigRaw: vi.fn(() => ({})),
	loadLocalConfigRaw: vi.fn(() => ({})),
	saveRepoConfig: vi.fn(),
	saveRepoLocalConfig: vi.fn(),
	getConfigSources: vi.fn(() => []),
	hasRepoConfig: vi.fn(() => false),
	hasLocalConfig: vi.fn(() => false),
}));

vi.mock("../agent-hooks", () => ({
	setupAgentHooks: vi.fn(),
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
}));

const mockSpawn = vi.fn();
const mockSpawnSync = vi.fn();
vi.mock("../spawn", () => ({
	spawn: (...args: any[]) => mockSpawn(...args),
	spawnSync: (...args: any[]) => mockSpawnSync(...args),
}));

// Mock node:fs for existsSync and readdirSync
vi.mock("node:fs", () => ({
	existsSync: vi.fn(() => true),
	readdirSync: vi.fn(() => []),
	statSync: vi.fn(() => ({ isDirectory: () => true, size: 0 })),
	mkdirSync: vi.fn(() => undefined),
	writeFileSync: vi.fn(() => undefined),
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
	FFIType: { ptr: "ptr" },
}));

import * as data from "../data";
import * as git from "../git";
import * as github from "../github";
import * as pty from "../pty-server";
import * as systemClipboard from "../system-clipboard";
import * as agents from "../agents";
import * as updater from "../updater";
import { setupAgentHooks } from "../agent-hooks";
import { loadSettings, loadSettingsSync, saveSettings } from "../settings";
import * as repoConfig from "../repo-config";
import * as cowClone from "../cow-clone";
import { Utils } from "electrobun/bun";
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
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
	startMergeDetectionPoller,
	stopMergeDetectionPoller,
	startPRDetectionPoller,
	stopPRDetectionPoller,
	resolveBinaryPath,
	launchTaskPty,
	activateTask,
	resolveOperationalProjectConfig,
	triggerColumnAgentIfNeeded,
	notifyWatchedTaskStatusChange,
	consumeRecentWatchedNotification,
	_resetWatchedNotificationState,
	NOTIFICATION_CLICK_TTL_MS,
	emitTaskSound,
	runCleanupScript,
} = await import("../rpc-handlers");

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

		expect(data.updateTask).toHaveBeenCalledWith(project, "task-1", { status: "user-questions" }, { dropPosition: "top" });
		expect(push).toHaveBeenCalledWith("taskUpdated", {
			projectId: "proj-1",
			task: expect.objectContaining({ status: "user-questions" }),
		});
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
		// runCleanupScript now uses async `Bun.file(path).exists()` instead of
		// `existsSync` — stub the worktree check so the function reaches spawn.
		const fileSpy = vi.spyOn(Bun, "file").mockReturnValue({ exists: () => Promise.resolve(true) } as any);

		await runCleanupScript(task, project, {
			fromStatus: "in-progress",
			toStatus: "completed",
		});

		fileSpy.mockRestore();

		expect(mockSpawn).toHaveBeenCalledTimes(1);
		expect(mockSpawn.mock.calls[0]?.[1]).toMatchObject({
			cwd: "/tmp/test-worktree",
			env: expect.objectContaining({
				TERM: "xterm-256color",
				DEV3_TASK_TITLE: "Ship it",
				DEV3_TASK_ID: "task-123",
				DEV3_PROJECT_NAME: "Alpha Project",
				DEV3_PROJECT_PATH: "/tmp/project-root",
				DEV3_WORKTREE_PATH: "/tmp/test-worktree",
				DEV3_TASK_STATUS: "completed",
				DEV3_TASK_FROM_STATUS: "in-progress",
				DEV3_TASK_TO_STATUS: "completed",
			}),
		});
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
	// is just `bash "/tmp/dev3-{taskId}-run.sh"` regardless of description length.
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
		// The tmux argument is just `bash "/tmp/dev3-{taskId}-run.sh"`.
		const taskId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
		const wrapperCmd = `bash "/tmp/dev3-${taskId}-run.sh"`;

		// Script file can be arbitrarily long — no tmux limit
		const scriptContent = buildCmdScript(agentCmd);
		expect(scriptContent).toContain(`&& ${agentCmd}`);
		expect(scriptContent.length).toBeGreaterThan(TMUX_CMD_LIMIT);

		// But the wrapper command passed to tmux stays tiny
		expect(wrapperCmd.length).toBeLessThan(100);
		expect(wrapperCmd.length).toBeLessThan(TMUX_CMD_LIMIT);
	});
});

// ================================================================
// handlers.getProjects
// ================================================================

describe("handlers.getProjects", () => {
	beforeEach(() => vi.clearAllMocks());

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
		);
		expect(data.addProject).toHaveBeenCalledWith("/base/my-repo", "my-repo");
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
	beforeEach(() => vi.clearAllMocks());

	it("delegates to saveSettings", async () => {
		const settings = { updateChannel: "stable" } as GlobalSettings;
		await handlers.saveGlobalSettings(settings);
		expect(saveSettings).toHaveBeenCalledWith(settings);
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
		expect(result).toEqual(updatedTask);
		expect(git.createWorktree).toHaveBeenCalledWith(project, task, undefined);
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
		expect(data.addTask).toHaveBeenCalledWith(project, "Continue login work", "in-progress", { existingBranch: "feature/login" });
		expect(git.createWorktree).toHaveBeenCalledWith(project, task, "feature/login");
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

		expect(result).toEqual({ branch: "feat/login", isBaseBranch: false, isDirty: true });
		expect(git.getCurrentBranch).toHaveBeenCalledWith(project.path);
		expect(git.isWorktreeDirty).toHaveBeenCalledWith(project.path);
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
		const updatedTask = makeTask({ status: "in-progress", worktreePath: "/tmp/wt", branchName: "dev3/t" });

		vi.mocked(data.getProject).mockResolvedValue(project);
		vi.mocked(data.getTask).mockResolvedValue(task);
		vi.mocked(git.createWorktree).mockResolvedValue({ worktreePath: "/tmp/wt", branchName: "dev3/t" });
		vi.mocked(data.updateTask).mockResolvedValue(updatedTask);

		const result = await handlers.moveTask({ taskId: "task-1", projectId: "proj-1", newStatus: "in-progress" });
		expect(result.status).toBe("in-progress");
		expect(git.createWorktree).toHaveBeenCalled();
		expect(pty.createSession).toHaveBeenCalled();
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

	it("in-progress → completed: emits renderer sound before cleanup finishes", async () => {
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

		expect(push.mock.invocationCallOrder[0]).toBeLessThan(
			vi.mocked(git.removeWorktree).mock.invocationCallOrder[0],
		);
		expect(push).toHaveBeenCalledWith("taskSound", { status: "completed" });
		expect(result.status).toBe("completed");
	});

	it("emitTaskSound: pushes a renderer event when sound setting is enabled", () => {
		const push = vi.fn();
		vi.mocked(loadSettingsSync).mockReturnValue({ playSoundOnTaskComplete: true } as any);
		setPushMessage(push);

		emitTaskSound("completed");

		expect(push).toHaveBeenCalledWith("taskSound", { status: "completed" });
	});

	it("emitTaskSound: stays silent when the setting is disabled", () => {
		const push = vi.fn();
		vi.mocked(loadSettingsSync).mockReturnValue({ playSoundOnTaskComplete: false } as any);
		setPushMessage(push);

		emitTaskSound("cancelled");

		expect(push).not.toHaveBeenCalledWith("taskSound", expect.anything());
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
		const updatedTask = makeTask({ status: "completed", worktreePath: null, branchName: null });

		vi.mocked(data.getProject).mockResolvedValue(project);
		vi.mocked(data.getTask).mockResolvedValue(task);
		vi.mocked(data.updateTask).mockResolvedValue(updatedTask);
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
		const updatedTask = makeTask({ status: "cancelled", worktreePath: null, branchName: null });

		vi.mocked(data.getProject).mockResolvedValue(project);
		vi.mocked(data.getTask).mockResolvedValue(task);
		vi.mocked(data.updateTask).mockResolvedValue(updatedTask);
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
		expect(data.updateTask).toHaveBeenCalledWith(project, "task-1", { status: "review-by-user", customColumnId: null }, { dropPosition: "top" });
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
		expect(data.updateTask).toHaveBeenCalledWith(project, "task-1", {
			status: "completed",
			worktreePath: null,
			branchName: null,
			customColumnId: null,
		}, { dropPosition: "top" });
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

describe("resolveOperationalProjectConfig", () => {
	beforeEach(() => vi.clearAllMocks());

	it("prefers project-level operational scripts over stale worktree config", async () => {
		const projectResolved = makeProject({
			setupScript: "project setup",
			devScript: "project dev",
			cleanupScript: "project cleanup",
			...( { setupScriptLaunchMode: "blocking" } as any ),
		});
		const worktreeResolved = makeProject({
			setupScript: "worktree setup",
			devScript: "worktree dev",
			cleanupScript: "worktree cleanup",
			defaultBaseBranch: "release",
			...( { setupScriptLaunchMode: "parallel" } as any ),
		});

		vi.mocked(repoConfig.resolveProjectConfig)
			.mockResolvedValueOnce(projectResolved)
			.mockResolvedValueOnce(worktreeResolved);

		const resolved = await resolveOperationalProjectConfig(projectResolved, "/tmp/wt");

		expect(repoConfig.resolveProjectConfig).toHaveBeenNthCalledWith(1, projectResolved);
		expect(repoConfig.resolveProjectConfig).toHaveBeenNthCalledWith(2, projectResolved, "/tmp/wt");
		expect(resolved.setupScript).toBe("project setup");
		expect(resolved.devScript).toBe("project dev");
		expect(resolved.cleanupScript).toBe("project cleanup");
		expect((resolved as any).setupScriptLaunchMode).toBe("blocking");
		expect(resolved.defaultBaseBranch).toBe("release");
	});

	it("falls back to worktree-resolved scripts when project-level scripts are empty", async () => {
		// Reproduces bug: new project has .dev3/config.json with devScript only in the
		// feature-branch worktree (not yet merged to main). project.path has no
		// .dev3/config.json, so projectResolved.devScript is "" (DEFAULTS). The operational
		// resolver must NOT shadow the worktree value with this empty string, otherwise the
		// dev-server button is green (worktree has devScript) but start fails with
		// "No dev script configured".
		const projectResolved = makeProject({
			setupScript: "",
			devScript: "",
			cleanupScript: "",
		});
		const worktreeResolved = makeProject({
			setupScript: "bun install",
			devScript: "PORT=${DEV3_PORT0:-8080} bun run dev",
			cleanupScript: "rm -rf node_modules",
		});

		vi.mocked(repoConfig.resolveProjectConfig)
			.mockResolvedValueOnce(projectResolved)
			.mockResolvedValueOnce(worktreeResolved);

		const resolved = await resolveOperationalProjectConfig(projectResolved, "/tmp/wt");

		expect(resolved.setupScript).toBe("bun install");
		expect(resolved.devScript).toBe("PORT=${DEV3_PORT0:-8080} bun run dev");
		expect(resolved.cleanupScript).toBe("rm -rf node_modules");
	});

	it("falls back to worktree scripts when project-level scripts are whitespace-only", async () => {
		const projectResolved = makeProject({
			setupScript: "   ",
			devScript: "\n\t ",
			cleanupScript: "",
		});
		const worktreeResolved = makeProject({
			setupScript: "bun install",
			devScript: "bun run dev",
			cleanupScript: "echo cleanup",
		});

		vi.mocked(repoConfig.resolveProjectConfig)
			.mockResolvedValueOnce(projectResolved)
			.mockResolvedValueOnce(worktreeResolved);

		const resolved = await resolveOperationalProjectConfig(projectResolved, "/tmp/wt");

		expect(resolved.setupScript).toBe("bun install");
		expect(resolved.devScript).toBe("bun run dev");
		expect(resolved.cleanupScript).toBe("echo cleanup");
	});

	it("mixes project and worktree scripts per-field when project only defines some", async () => {
		const projectResolved = makeProject({
			setupScript: "project setup",
			devScript: "",
			cleanupScript: "project cleanup",
		});
		const worktreeResolved = makeProject({
			setupScript: "worktree setup",
			devScript: "worktree dev",
			cleanupScript: "worktree cleanup",
		});

		vi.mocked(repoConfig.resolveProjectConfig)
			.mockResolvedValueOnce(projectResolved)
			.mockResolvedValueOnce(worktreeResolved);

		const resolved = await resolveOperationalProjectConfig(projectResolved, "/tmp/wt");

		// Project wins for setupScript and cleanupScript (both set); worktree fills devScript.
		expect(resolved.setupScript).toBe("project setup");
		expect(resolved.devScript).toBe("worktree dev");
		expect(resolved.cleanupScript).toBe("project cleanup");
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
		const variantTask = makeTask({ id: "variant-1", status: "todo" });

		vi.mocked(data.getProject).mockResolvedValue(project);
		vi.mocked(data.getTask).mockResolvedValue(sourceTask);
		vi.mocked(data.addTask).mockResolvedValue(variantTask);
		vi.mocked(data.deleteTask).mockResolvedValue(undefined);

		const result = await handlers.spawnVariants({
			taskId: "task-1",
			projectId: "proj-1",
			targetStatus: "todo",
			variants: [{ agentId: "agent-1", configId: null }],
		});

		expect(result).toHaveLength(1);
		expect(data.addTask).toHaveBeenCalledOnce();
		expect(data.deleteTask).toHaveBeenCalledWith(project, "task-1");
		expect(git.createWorktree).not.toHaveBeenCalled();
	});

	it("spawns variants into active status with worktree + PTY", async () => {
		const project = makeProject();
		const sourceTask = makeTask({ status: "todo", seq: 5 });
		const variantTask = makeTask({ id: "variant-1", status: "in-progress", preparing: true });
		const updatedVariant = makeTask({ id: "variant-1", status: "in-progress", worktreePath: "/tmp/vwt" });

		vi.mocked(data.getProject).mockResolvedValue(project);
		vi.mocked(data.getTask).mockResolvedValue(sourceTask);
		vi.mocked(data.addTask).mockResolvedValue(variantTask);
		vi.mocked(git.createWorktree).mockResolvedValue({ worktreePath: "/tmp/vwt", branchName: "dev3/v1" });
		vi.mocked(data.updateTask).mockResolvedValue(updatedVariant);

		const result = await handlers.spawnVariants({
			taskId: "task-1",
			projectId: "proj-1",
			targetStatus: "in-progress",
			variants: [
				{ agentId: "agent-1", configId: null },
				{ agentId: "agent-2", configId: "conf-1" },
			],
		});

		// Phase 1: returns tasks immediately with preparing flag
		expect(result).toHaveLength(2);
		expect(data.addTask).toHaveBeenCalledTimes(2);
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
		const variantTask = makeTask({ id: "variant-1", status: "in-progress", preparing: true });
		const updatedVariant = makeTask({ id: "variant-1", status: "in-progress", worktreePath: "/tmp/vwt" });

		vi.mocked(data.getProject).mockResolvedValue(project);
		vi.mocked(data.getTask).mockResolvedValue(sourceTask);
		vi.mocked(data.addTask).mockResolvedValue(variantTask);
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
		const variantTask = makeTask({ id: "variant-1", status: "in-progress", existingBranch: "feature/login", preparing: true });
		const updatedVariant = makeTask({ id: "variant-1", status: "in-progress", worktreePath: "/tmp/vwt", branchName: "feature/login" });

		vi.mocked(data.getProject).mockResolvedValue(project);
		vi.mocked(data.getTask).mockResolvedValue(sourceTask);
		vi.mocked(data.addTask).mockResolvedValue(variantTask);
		vi.mocked(git.createWorktree).mockResolvedValue({ worktreePath: "/tmp/vwt", branchName: "feature/login" });
		vi.mocked(data.updateTask).mockResolvedValue(updatedVariant);

		await handlers.spawnVariants({
			taskId: "task-1",
			projectId: "proj-1",
			targetStatus: "in-progress",
			variants: [{ agentId: null, configId: null }],
		});

		expect(data.addTask).toHaveBeenCalledWith(
			project,
			sourceTask.description,
			"in-progress",
			expect.objectContaining({
				existingBranch: "feature/login",
				preparing: true,
				preparingStage: "resolving-config",
				preparingProgress: getPreparingStageProgress("resolving-config"),
			}),
		);
		// Background: single variant uses existing branch directly, no variantBranchName
		await vi.waitFor(() => {
			expect(git.createWorktree).toHaveBeenCalledWith(
				project,
				expect.objectContaining({
					...variantTask,
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
		const variantTask = makeTask({ id: "variant-1", status: "in-progress", existingBranch: "feature/login", preparing: true });
		const updatedVariant = makeTask({ id: "variant-1", status: "in-progress", worktreePath: "/tmp/vwt" });

		vi.mocked(data.getProject).mockResolvedValue(project);
		vi.mocked(data.getTask).mockResolvedValue(sourceTask);
		vi.mocked(data.addTask).mockResolvedValue(variantTask);
		vi.mocked(git.createWorktree).mockResolvedValue({ worktreePath: "/tmp/vwt", branchName: "feature/login-v1" });
		vi.mocked(data.updateTask).mockResolvedValue(updatedVariant);

		await handlers.spawnVariants({
			taskId: "task-1",
			projectId: "proj-1",
			targetStatus: "in-progress",
			variants: [
				{ agentId: "agent-1", configId: null },
				{ agentId: "agent-2", configId: null },
			],
		});

		// Both variants store existingBranch for reference
		const addTaskCalls = vi.mocked(data.addTask).mock.calls;
		expect(addTaskCalls).toHaveLength(2);
		expect(addTaskCalls[0][3]).toEqual(expect.objectContaining({
			existingBranch: "feature/login",
			preparing: true,
			preparingStage: "resolving-config",
			preparingProgress: getPreparingStageProgress("resolving-config"),
		}));
		expect(addTaskCalls[1][3]).toEqual(expect.objectContaining({
			existingBranch: "feature/login",
			preparing: true,
			preparingStage: "resolving-config",
			preparingProgress: getPreparingStageProgress("resolving-config"),
		}));

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
		const variantTask = makeTask({ id: "variant-1", status: "in-progress", preparing: true });
		const updatedVariant = makeTask({ id: "variant-1", status: "in-progress", worktreePath: "/tmp/vwt" });

		vi.mocked(data.getProject).mockResolvedValue(project);
		vi.mocked(data.getTask).mockResolvedValue(sourceTask);
		vi.mocked(data.addTask).mockResolvedValue(variantTask);
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

	it("clears preparing when project config resolution fails before variant setup starts", async () => {
		const project = makeProject();
		const sourceTask = makeTask({ status: "todo", seq: 5 });
		const variantTask = makeTask({ id: "variant-1", status: "in-progress", preparing: true });
		const unstuckVariant = makeTask({ id: "variant-1", status: "in-progress", preparing: false, preparingStage: null, preparingProgress: null });

		vi.mocked(data.getProject).mockResolvedValue(project);
		vi.mocked(data.getTask).mockResolvedValue(sourceTask);
		vi.mocked(data.addTask).mockResolvedValue(variantTask);
		vi.mocked(data.updateTask).mockResolvedValue(unstuckVariant);
		vi.mocked(repoConfig.resolveProjectConfig).mockRejectedValueOnce(new Error("bad repo config"));

		await handlers.spawnVariants({
			taskId: "task-1",
			projectId: "proj-1",
			targetStatus: "in-progress",
			variants: [{ agentId: "agent-1", configId: null }],
		});

		await vi.waitFor(() => {
			expect(data.updateTask).toHaveBeenCalledWith(project, "variant-1", {
				preparing: false,
				preparingStage: null,
				preparingProgress: null,
				preparingStartedAt: null,
			});
		});

		expect(git.createWorktree).not.toHaveBeenCalled();
	});

	it("clears preparing when PTY launch fails after the worktree is created", async () => {
		const project = makeProject();
		const sourceTask = makeTask({ status: "todo", seq: 5 });
		const variantTask = makeTask({ id: "variant-1", status: "in-progress", preparing: true });
		const unstuckVariant = makeTask({ id: "variant-1", status: "in-progress", preparing: false, preparingStage: null, preparingProgress: null });

		vi.mocked(data.getProject).mockResolvedValue(project);
		vi.mocked(data.getTask).mockResolvedValue(sourceTask);
		vi.mocked(data.addTask).mockResolvedValue(variantTask);
		vi.mocked(git.createWorktree).mockResolvedValue({ worktreePath: "/tmp/vwt", branchName: "dev3/v1" });
		vi.mocked(data.updateTask).mockResolvedValue(unstuckVariant);
		vi.mocked(pty.createSession).mockImplementationOnce(() => {
			throw new Error("pty boom");
		});

		await handlers.spawnVariants({
			taskId: "task-1",
			projectId: "proj-1",
			targetStatus: "in-progress",
			variants: [{ agentId: "agent-1", configId: null }],
		});

		await vi.waitFor(() => {
			expect(data.updateTask).toHaveBeenCalledWith(project, "variant-1", {
				preparing: false,
				preparingStage: null,
				preparingProgress: null,
				preparingStartedAt: null,
			});
		});
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
		const variantTask = makeTask({ id: "variant-1", status: "in-progress", preparing: true });
		const updatedVariant = makeTask({ id: "variant-1", status: "in-progress", worktreePath: "/tmp/vwt" });

		vi.mocked(data.getProject).mockResolvedValue(project);
		vi.mocked(data.getTask).mockResolvedValue(sourceTask);
		vi.mocked(data.addTask).mockResolvedValue(variantTask);
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
			"in-progress",
			expect.objectContaining({
				existingBranch: "feature/login",
				preparing: true,
				preparingStage: "resolving-config",
				preparingProgress: getPreparingStageProgress("resolving-config"),
			}),
		);

		await vi.waitFor(() => {
			expect(git.createWorktree).toHaveBeenCalledWith(
				project,
				expect.objectContaining({
					...attemptTask,
					preparingStage: "resolving-config",
					preparingProgress: getPreparingStageProgress("resolving-config"),
				}),
				"feature/login",
				undefined,
			);
		});
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
			"in-progress",
			expect.objectContaining({
				existingBranch: "feature/login",
			}),
		);

		await vi.waitFor(() => {
			expect(git.createWorktree).toHaveBeenCalledWith(
				project,
				expect.objectContaining({
					...attemptTask,
					preparingStage: "resolving-config",
					preparingProgress: getPreparingStageProgress("resolving-config"),
				}),
				"feature/login",
				undefined,
			);
		});
	});

	it("clears preparing when project config resolution fails before attempt setup starts", async () => {
		const project = makeProject();
		const sourceTask = makeTask({ status: "in-progress", seq: 5, groupId: "group-1", variantIndex: 1 });
		const attemptTask = makeTask({
			id: "attempt-2",
			status: "in-progress",
			groupId: "group-1",
			variantIndex: 2,
			preparing: true,
		});
		const unstuckAttempt = makeTask({
			id: "attempt-2",
			status: "in-progress",
			groupId: "group-1",
			variantIndex: 2,
			preparing: false,
			preparingStage: null,
			preparingProgress: null,
		});

		vi.mocked(data.getProject).mockResolvedValue(project);
		vi.mocked(data.getTask)
			.mockResolvedValueOnce(sourceTask)
			.mockResolvedValueOnce(sourceTask);
		vi.mocked(data.loadTasks).mockResolvedValue([sourceTask]);
		vi.mocked(data.addTask).mockResolvedValue(attemptTask);
		vi.mocked(data.updateTask).mockResolvedValue(unstuckAttempt);
		vi.mocked(repoConfig.resolveProjectConfig).mockRejectedValueOnce(new Error("bad repo config"));

		await handlers.addAttempts({
			taskId: "task-1",
			projectId: "proj-1",
			variants: [{ agentId: "agent-1", configId: null }],
		});

		await vi.waitFor(() => {
			expect(data.updateTask).toHaveBeenCalledWith(project, "attempt-2", {
				preparing: false,
				preparingStage: null,
				preparingProgress: null,
				preparingStartedAt: null,
			});
		});

		expect(git.createWorktree).not.toHaveBeenCalled();
	});

	it("keeps preparing isolated per attempt when one attempt fails and another succeeds", async () => {
		const project = makeProject();
		const sourceTask = makeTask({ status: "in-progress", seq: 5, groupId: "group-1", variantIndex: 1 });
		const firstAttempt = makeTask({
			id: "attempt-2",
			status: "in-progress",
			groupId: "group-1",
			variantIndex: 2,
			preparing: true,
		});
		const secondAttempt = makeTask({
			id: "attempt-3",
			status: "in-progress",
			groupId: "group-1",
			variantIndex: 3,
			preparing: true,
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
		vi.mocked(data.updateTask)
			.mockResolvedValueOnce({ ...firstAttempt, preparing: false, preparingStage: null, preparingProgress: null })
			.mockResolvedValueOnce({
				...secondAttempt,
				worktreePath: "/tmp/attempt-3",
				branchName: "dev3/a3",
				preparing: false,
				preparingStage: null,
				preparingProgress: null,
				preparingStartedAt: null,
			});

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
		expect(data.updateTask).toHaveBeenCalledWith(project, "attempt-2", {
			preparing: false,
			preparingStage: null,
			preparingProgress: null,
			preparingStartedAt: null,
		});
		expect(data.updateTask).toHaveBeenCalledWith(project, "attempt-3", {
			worktreePath: "/tmp/attempt-3",
			branchName: "dev3/a3",
			preparing: false,
			preparingStage: null,
			preparingProgress: null,
			preparingStartedAt: null,
		});
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
		vi.mocked(data.updateTask).mockResolvedValue(revertedTask);
		vi.mocked(git.removeWorktree).mockResolvedValue(undefined);
		vi.mocked(git.taskDir).mockReturnValue("/tmp/test-dev3/worktrees/tmp-test-project/variant-1");

		const result = await handlers.cancelTaskPreparation({
			taskId: task.id,
			projectId: project.id,
		});

		expect(result).toEqual(revertedTask);
		expect(mockSpawn).toHaveBeenCalledWith(["kill", "-9", "111"], expect.anything());
		expect(mockSpawn).toHaveBeenCalledWith(["kill", "-9", "222"], expect.anything());
		expect(data.updateTask).toHaveBeenCalledWith(project, task.id, {
			status: "todo",
			preparing: false,
			preparingStage: null,
			preparingProgress: null,
			preparingStartedAt: null,
			worktreePath: null,
			branchName: null,
			customColumnId: null,
		});
		expect(git.removeWorktree).toHaveBeenCalledWith(project, expect.objectContaining({
			id: task.id,
			worktreePath: "/tmp/test-dev3/worktrees/tmp-test-project/variant-1/worktree",
		}));
	});
});

// ================================================================
// handlers.getBranchStatus
// ================================================================

describe("handlers.getBranchStatus", () => {
	beforeEach(() => vi.clearAllMocks());

	it("returns zeros when task has no worktree", async () => {
		const project = makeProject();
		const task = makeTask({ worktreePath: null });
		vi.mocked(data.getProject).mockResolvedValue(project);
		vi.mocked(data.getTask).mockResolvedValue(task);

		const result = await handlers.getBranchStatus({ taskId: "task-1", projectId: "proj-1" });
		expect(result).toEqual({ ahead: 0, behind: 0, canRebase: false, insertions: 0, deletions: 0, unpushed: 0, mergedByContent: false, diffFiles: 0, diffInsertions: 0, diffDeletions: 0, diffFileNames: [], prNumber: null, prUrl: null, mergeCompletionFingerprint: null });
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
		vi.mocked(git.getBranchDiffStats).mockResolvedValue({ files: 4, insertions: 50, deletions: 20, fileNames: ["a.ts", "b.ts", "c.ts", "d.ts"] });
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
		vi.mocked(git.getBranchDiffStats).mockResolvedValue({ files: 0, insertions: 0, deletions: 0, fileNames: [] });

		const result = await handlers.getBranchStatus({ taskId: "task-1", projectId: "proj-1" });
		expect(result.canRebase).toBe(false);
		expect(git.canRebaseCleanly).not.toHaveBeenCalled();
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
		vi.mocked(git.getBranchDiffStats).mockResolvedValue({ files: 0, insertions: 0, deletions: 0, fileNames: [] });

		await handlers.getBranchStatus({ taskId: "task-1", projectId: "proj-1" });

		// Should have synced the stored branchName
		expect(data.updateTask).toHaveBeenCalledWith(project, "task-1", { branchName: "dev3/fix-login" });
		// Should pass live branch name to getUnpushedCount
		expect(git.getUnpushedCount).toHaveBeenCalledWith("/tmp/wt", "dev3/fix-login");
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
		vi.mocked(git.getBranchDiffStats).mockResolvedValue({ files: 0, insertions: 0, deletions: 0, fileNames: [] });

		await handlers.getBranchStatus({ taskId: "task-1", projectId: "proj-1" });

		expect(data.updateTask).not.toHaveBeenCalled();
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
		vi.mocked(git.getBranchDiffStats).mockResolvedValue({ files: 0, insertions: 0, deletions: 0, fileNames: [] });
		vi.mocked(github.runGitHub).mockResolvedValue({ ok: true, stdout: JSON.stringify([{ number: 42 }]), stderr: "", code: 0 });

		const result = await handlers.getBranchStatus({ taskId: "task-1", projectId: "proj-1" });
		expect(result.prNumber).toBe(42);
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
		vi.mocked(git.getBranchDiffStats).mockResolvedValue({ files: 0, insertions: 0, deletions: 0, fileNames: [] });
		vi.mocked(github.runGitHub).mockResolvedValue({ ok: true, stdout: "[]", stderr: "", code: 0 });

		const result = await handlers.getBranchStatus({ taskId: "task-1", projectId: "proj-1" });
		expect(result.prNumber).toBeNull();
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
		vi.mocked(git.getBranchDiffStats).mockResolvedValue({ files: 0, insertions: 0, deletions: 0, fileNames: [] });
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
		vi.mocked(git.getBranchDiffStats).mockResolvedValue({ files: 0, insertions: 0, deletions: 0, fileNames: [] });
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
		vi.mocked(git.getBranchDiffStats).mockResolvedValue({ files: 0, insertions: 0, deletions: 0, fileNames: [] });
		vi.mocked(github.runGitHub).mockResolvedValue({ ok: true, stdout: JSON.stringify([{ number: 10 }]), stderr: "", code: 0 });

		const result = await handlers.getBranchStatus({ taskId: "task-1", projectId: "proj-1" });
		expect(result.prNumber).toBe(10);
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

		expect(git.fetchOrigin).toHaveBeenCalledWith(project.path);
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

// ================================================================
// handlers.showConfirm
// ================================================================

describe("handlers.showConfirm", () => {
	beforeEach(() => vi.clearAllMocks());

	it("returns true when user clicks OK (response=0)", async () => {
		vi.mocked(Utils.showMessageBox).mockResolvedValue({ response: 0 } as any);
		const result = await handlers.showConfirm({ title: "Confirm", message: "Are you sure?" });
		expect(result).toBe(true);
	});

	it("returns false when user clicks Cancel (response=1)", async () => {
		vi.mocked(Utils.showMessageBox).mockResolvedValue({ response: 1 } as any);
		const result = await handlers.showConfirm({ title: "Confirm", message: "Are you sure?" });
		expect(result).toBe(false);
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
		vi.mocked(existsSync).mockReturnValue(false);  // no fallback paths exist

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

	it("returns session and process details after start", async () => {
		const project = makeProject({ devScript: "bun run dev" });
		const task = makeTask({ worktreePath: "/tmp/wt", id: "abcd1234-0000-0000-0000-000000000000" });
		vi.mocked(data.getProject).mockResolvedValue(project);
		vi.mocked(data.getTask).mockResolvedValue(task);
		const portPool = await import("../port-pool");
		vi.spyOn(portPool, "getPortAssignments").mockReturnValue([50001, 55930, 55937]);
		mockSpawn
			.mockReturnValueOnce({ stdout: "", stderr: new Response(""), exited: Promise.resolve(1) })
			.mockReturnValueOnce({ stdout: "", stderr: new Response(""), exited: Promise.resolve(0) })
			.mockReturnValueOnce({ stdout: "%17\n", stderr: new Response(""), exited: Promise.resolve(0) })
			.mockReturnValue({ stdout: "", stderr: new Response(""), exited: Promise.resolve(0) });
		mockSpawnSync.mockImplementation((args: string[]) => {
			if (args.includes("list-panes") && args.includes("dev3-dev-abcd1234")) {
				return { exitCode: 0, stdout: Buffer.from("81231\n"), stderr: Buffer.from("") };
			}
			if (args.includes("list-panes") && args.includes("dev3-abcd1234")) {
				return { exitCode: 0, stdout: Buffer.from("81230\n"), stderr: Buffer.from("") };
			}
			if (args[0] === "lsof") {
				return { exitCode: 0, stdout: Buffer.from("p81231\ncbun\nn*:5173\n"), stderr: Buffer.from("") };
			}
			return { exitCode: 0, stdout: Buffer.from(""), stderr: Buffer.from("") };
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

		// Use plain string for split-window stdout — new Response(new Response(...)) loses body in Bun test env
		mockSpawn
			.mockReturnValueOnce({ stdout: "", stderr: new Response(""), exited: Promise.resolve(1) }) // has-session → not running
			.mockReturnValueOnce({ stdout: "", stderr: new Response(""), exited: Promise.resolve(0) }) // new-session ok
			.mockReturnValueOnce({ stdout: "%42\n", stderr: new Response(""), exited: Promise.resolve(0) }) // split-window → pane ID
			.mockReturnValue({ stdout: "", stderr: new Response(""), exited: Promise.resolve(0) });

		await handlers.runDevServer({ taskId: task.id, projectId: "proj-1" });

		vi.clearAllMocks();

		// Second call (restart): has-session=running → kill-pane %42, then kill-session, then new-session
		mockSpawn
			.mockReturnValueOnce({ stdout: "", stderr: new Response(""), exited: Promise.resolve(0) }) // has-session → running
			.mockReturnValue({ stdout: "", stderr: new Response(""), exited: Promise.resolve(0) });

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

		// has-session → running; list-panes returns a pane running attach-session for dev3-dev-abcd1234
		// Use plain strings — new Response(new Response(...)) loses body in Bun test env
		mockSpawn
			.mockReturnValueOnce({ stdout: "", stderr: new Response(""), exited: Promise.resolve(0) }) // has-session → running
			.mockReturnValueOnce({ stdout: "%99 TMUX= tmux attach-session -t dev3-dev-abcd1234\n", stderr: new Response(""), exited: Promise.resolve(0) }) // list-panes fallback
			.mockReturnValue({ stdout: "", stderr: new Response(""), exited: Promise.resolve(0) });

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
			stdout: "dev3-pt-a1c9fe4e|/tmp/project|1|1700000001",
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
			stdout: "dev3-abc12345|/tmp/wt|1|1700000001\ndev3-dev-abc12345|/tmp/wt|1|1700000002\ndev3-xyz99999|/tmp/wt|1|1700000000",
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
			stdout: "dev3-abc12345|/tmp/wt|1|1700000001",
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
			stdout: "dev3-abc12345|/tmp/wt|1|1700000001",
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
		expect(mockSpawn).toHaveBeenCalledWith(
			["tmux", "-L", "dev3", "split-window", "-v", "-c", "#{pane_current_path}", "-t", "dev3-abcd1234"],
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
			["tmux", "-L", "dev3", "split-window", "-h", "-c", "#{pane_current_path}", "-t", "dev3-abcd1234"],
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
			listTaskPanes: { exit: 0, out: "%0 1\n%1 0\n%2 1\n" },
		});

		const result = await handlers.exitCopyModeAllPanes({ taskId: "abcd1234-full-id" });

		expect(result).toEqual({ panesExited: 2 });
		expect(mockSpawn).toHaveBeenCalledWith(
			["tmux", "-L", "dev3", "list-panes", "-s", "-t", "dev3-abcd1234", "-F", "#{pane_id} #{pane_in_mode}"],
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
			listTaskPanes: { exit: 0, out: "%10 0\n" },
			listDevPanes: { exit: 0, out: "%99 1\n" }, // dev-server pane in copy-mode
		});

		const result = await handlers.exitCopyModeAllPanes({ taskId: "abcd1234-full-id" });

		expect(result).toEqual({ panesExited: 1 });
		expect(mockSpawn).toHaveBeenCalledWith(
			["tmux", "-L", "dev3", "list-panes", "-s", "-t", "dev3-dev-abcd1234", "-F", "#{pane_id} #{pane_in_mode}"],
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
// handlers.getHomePtyUrl / destroyHomeTerminal
// ================================================================

describe("handlers.getHomePtyUrl", () => {
	beforeEach(() => vi.clearAllMocks());

	it("creates a home PTY session in the user's home directory", async () => {
		vi.mocked(pty.hasSession).mockReturnValue(false);
		vi.mocked(pty.hasDeadSession).mockReturnValue(false);
		vi.mocked(existsSync).mockReturnValue(true);

		const url = await handlers.getHomePtyUrl({});

		expect(pty.createSession).toHaveBeenCalledWith(
			"home",
			"",
			expect.any(String),
			process.env.SHELL || "/bin/zsh",
			{},
			"dev3",
			"home",
		);
		expect(url).toBe("ws://localhost:9999?session=home");
	});

	it("reuses existing home session without creating a new one", async () => {
		vi.mocked(pty.hasSession).mockReturnValue(true);
		vi.mocked(pty.hasDeadSession).mockReturnValue(false);

		await handlers.getHomePtyUrl({});

		expect(pty.createSession).not.toHaveBeenCalled();
	});

	it("destroys dead home session before creating a new one", async () => {
		vi.mocked(pty.hasDeadSession).mockReturnValue(true);
		vi.mocked(pty.hasSession).mockReturnValue(false);
		vi.mocked(existsSync).mockReturnValue(true);

		await handlers.getHomePtyUrl({});

		expect(pty.destroySession).toHaveBeenCalledWith("home");
		expect(pty.createSession).toHaveBeenCalled();
	});
});

describe("handlers.destroyHomeTerminal", () => {
	beforeEach(() => vi.clearAllMocks());

	it("destroys the home terminal session", async () => {
		await handlers.destroyHomeTerminal({});
		expect(pty.destroySession).toHaveBeenCalledWith("home");
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
	beforeEach(() => vi.clearAllMocks());

	it("spawns agent with split-window -h in the tmux session", async () => {
		const project = makeProject();
		const task = makeTask({ id: "abcd1234-full-id", worktreePath: "/tmp/wt" });
		(data.getProject as any).mockResolvedValue(project);
		(data.getTask as any).mockResolvedValue(task);
		(agents.resolveCommandForAgent as any).mockResolvedValue({ command: "claude --resume", extraEnv: { FOO: "bar" } });
		mockSpawn.mockReturnValue({ stderr: new Response(""), stdout: new Response(""), exited: Promise.resolve(0) });

		await handlers.spawnAgentInTask({ taskId: "abcd1234-full-id", projectId: "proj-1", agentId: "builtin-claude", configId: "claude-default" });

		expect(agents.resolveCommandForAgent).toHaveBeenCalledWith("builtin-claude", "claude-default", expect.objectContaining({ worktreePath: "/tmp/wt" }), expect.objectContaining({ sessionId: expect.any(String) }));
		expect(mockSpawn).toHaveBeenCalledWith(
			expect.arrayContaining(["tmux", "-L", "dev3", "split-window", "-h", "-c", "/tmp/wt", "-t", "dev3-abcd1234"]),
			expect.any(Object),
		);
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
});

describe("launchTaskPty", () => {
	beforeEach(async () => {
		vi.clearAllMocks();
		// getUserShell caches the resolved login shell module-wide. Tests in
		// this block toggle process.env.SHELL, so reset the cache to honor it.
		const shellEnv = await import("../shell-env");
		shellEnv._resetUserShellCacheForTests();
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
			const setupIndex = script.indexOf(`'${process.env.SHELL}' -x '/tmp/dev3-task-1-setup.sh'`);
			const splitIndex = script.indexOf(`tmux split-window -v -c "/tmp/wt" "'${process.env.SHELL}' '/tmp/dev3-task-1-cmd.sh'"`);

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
			const splitIndex = script.indexOf(`tmux split-window -v -c "/tmp/wt" "'${process.env.SHELL}' '/tmp/dev3-task-1-cmd.sh'"`);
			const setupIndex = script.indexOf(`'${process.env.SHELL}' -x '/tmp/dev3-task-1-setup.sh'`);

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

	it("throws without creating a PTY session when command resolution fails", async () => {
		const project = makeProject();
		const task = makeTask();
		vi.mocked(agents.resolveCommandForAgent).mockRejectedValueOnce(new Error("resolve boom"));

		await expect(
			launchTaskPty(project, task, "/tmp/wt", "builtin-claude", "claude-default"),
		).rejects.toThrow("resolve boom");

		expect(pty.createSession).not.toHaveBeenCalled();
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

describe("moveTaskToCustomColumn — resume logic", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockSpawn.mockReturnValue({ stderr: new Response(""), stdout: new Response(""), exited: Promise.resolve(0) });
		vi.mocked(git.createWorktree).mockResolvedValue({ worktreePath: "/tmp/new-wt", branchName: "dev3/resumed" } as any);
		vi.mocked(loadSettings).mockResolvedValue({ updateChannel: "stable", taskDropPosition: "top" } as any);
	});

	it("moves active task to custom column without worktree changes", async () => {
		const col = { id: "col-aaa", name: "Alpha", color: "#ff0000", llmInstruction: "" };
		const project = makeProject({ customColumns: [col] });
		const task = makeTask({ status: "in-progress", customColumnId: null });
		const updated = { ...task, customColumnId: "col-aaa" };
		vi.mocked(data.getProject).mockResolvedValue(project);
		vi.mocked(data.getTask).mockResolvedValue(task);
		vi.mocked(data.updateTask).mockResolvedValue(updated);

		const result = await handlers.moveTaskToCustomColumn({ taskId: "task-1", projectId: "proj-1", customColumnId: "col-aaa" });

		expect(git.createWorktree).not.toHaveBeenCalled();
		expect(data.updateTask).toHaveBeenCalledWith(project, "task-1", { customColumnId: "col-aaa" });
		expect(result.customColumnId).toBe("col-aaa");
	});

	it("resumes completed task when moved to custom column", async () => {
		const col = { id: "col-aaa", name: "Alpha", color: "#ff0000", llmInstruction: "" };
		const project = makeProject({ customColumns: [col] });
		const task = makeTask({ status: "completed", worktreePath: null, branchName: null, customColumnId: null });
		const updated = makeTask({ status: "in-progress", worktreePath: "/tmp/new-wt", branchName: "dev3/resumed", customColumnId: "col-aaa" });
		vi.mocked(data.getProject).mockResolvedValue(project);
		vi.mocked(data.getTask).mockResolvedValue(task);
		vi.mocked(data.updateTask).mockResolvedValue(updated);

		const result = await handlers.moveTaskToCustomColumn({ taskId: "task-1", projectId: "proj-1", customColumnId: "col-aaa" });

		expect(git.createWorktree).toHaveBeenCalledWith(project, task, undefined);
		expect(data.updateTask).toHaveBeenCalledWith(project, "task-1", {
			status: "in-progress",
			worktreePath: "/tmp/new-wt",
			branchName: "dev3/resumed",
			customColumnId: "col-aaa",
		}, { dropPosition: "top" });
		expect(result.status).toBe("in-progress");
		expect(result.customColumnId).toBe("col-aaa");
	});

	it("resumes cancelled task when moved to custom column", async () => {
		const col = { id: "col-aaa", name: "Alpha", color: "#ff0000", llmInstruction: "" };
		const project = makeProject({ customColumns: [col] });
		const task = makeTask({ status: "cancelled", worktreePath: null, branchName: null, customColumnId: null });
		const updated = makeTask({ status: "in-progress", customColumnId: "col-aaa" });
		vi.mocked(data.getProject).mockResolvedValue(project);
		vi.mocked(data.getTask).mockResolvedValue(task);
		vi.mocked(data.updateTask).mockResolvedValue(updated);

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

		expect(data.updateTask).toHaveBeenCalledWith(project, "task-1", { customColumnId: null });
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
	});

	function setup(taskOverrides?: Partial<Task>, projectOverrides?: Partial<Project>) {
		const project = makeProject(projectOverrides);
		const task = makeTask({ status: "review-by-user", worktreePath: "/tmp/wt", ...taskOverrides });
		vi.mocked(data.loadProjects).mockResolvedValue([project]);
		vi.mocked(data.loadTasks).mockResolvedValue([task]);
		vi.mocked(git.getCurrentBranch).mockResolvedValue("dev3/my-feature");
		vi.mocked(git.getUnpushedCount).mockResolvedValue(0);
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

		// Reset mocks but keep prPromotedTasks state
		vi.mocked(data.updateTask).mockClear();
		vi.mocked(push).mockClear();

		await checkOpenPRsForPromotion();
		expect(data.updateTask).not.toHaveBeenCalled();
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
		vi.mocked(git.getHeadSha).mockResolvedValue("abc123");
		vi.mocked(data.updateTask).mockImplementation(async (_project: Project, _taskId: string, patch: Partial<Task>) => makeTask(patch));
	});

	afterEach(() => {
		stopMergeDetectionPoller();
		_resetMergePollerState();
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
		});
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
});

describe("startPRDetectionPoller / stopPRDetectionPoller", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		stopPRDetectionPoller();
	});

	afterEach(() => {
		stopPRDetectionPoller();
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

	it("finds binary via which when no custom path", () => {
		mockSpawnSync.mockReturnValue({ exitCode: 0, stdout: new TextEncoder().encode("/usr/local/bin/claude") });
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
});

// ---- checkAgentAvailability ----

describe("checkAgentAvailability", () => {
	beforeEach(() => {
		mockSpawnSync.mockReset();
		vi.mocked(existsSync).mockReset().mockReturnValue(false);
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
		mockSpawn.mockReturnValue(makeProcMock());
		mockSpawnSync.mockReturnValue({ exitCode: 0, stdout: new TextEncoder().encode("") });
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

		const result = await handlers.toggleTaskWatch({
			taskId: "task-1",
			projectId: project.id,
			watched: true,
		});

		expect(data.updateTask).toHaveBeenCalledWith(project, "task-1", { watched: true });
		expect(result.watched).toBe(true);
		expect(push).toHaveBeenCalledWith("taskUpdated", { projectId: project.id, task });
	});

	it("sets watched to false", async () => {
		const project = makeProject();
		const task = makeTask({ watched: false });
		vi.mocked(data.getProject).mockResolvedValue(project);
		vi.mocked(data.updateTask).mockResolvedValue(task);

		const result = await handlers.toggleTaskWatch({
			taskId: "task-1",
			projectId: project.id,
			watched: false,
		});

		expect(data.updateTask).toHaveBeenCalledWith(project, "task-1", { watched: false });
		expect(result.watched).toBe(false);
	});
});
