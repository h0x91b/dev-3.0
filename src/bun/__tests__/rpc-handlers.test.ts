import { describe, it, expect, vi, beforeEach } from "vitest";
import type { GlobalSettings, Project, Task } from "../../shared/types";

// ---- Mocks ----

vi.mock("electrobun/bun", () => ({
	Utils: {
		showMessageBox: vi.fn(),
		openFileDialog: vi.fn(),
		quit: vi.fn(),
	},
}));

vi.mock("../data", () => ({
	getProject: vi.fn(),
	getTask: vi.fn(),
	loadProjects: vi.fn(),
	loadTasks: vi.fn(),
	updateTask: vi.fn(),
	addTask: vi.fn(),
	addProject: vi.fn(),
	deleteTask: vi.fn(),
	removeProject: vi.fn(),
	updateProject: vi.fn(),
	getLastPickedFolder: vi.fn(),
	setLastPickedFolder: vi.fn(),
}));

vi.mock("../git", () => ({
	removeWorktree: vi.fn(),
	createWorktree: vi.fn(),
	isGitRepo: vi.fn(),
	getDefaultBranch: vi.fn(),
	fetchOrigin: vi.fn(),
	getBranchStatus: vi.fn(),
	getUncommittedChanges: vi.fn(),
	getUnpushedCount: vi.fn(),
	canRebaseCleanly: vi.fn(),
	isContentMergedInto: vi.fn(),
	cloneRepo: vi.fn(),
	extractRepoName: vi.fn(),
	getCurrentBranch: vi.fn(),
	listBranches: vi.fn(),
}));

vi.mock("../pty-server", () => ({
	createSession: vi.fn(),
	destroySession: vi.fn(),
	hasSession: vi.fn(),
	hasDeadSession: vi.fn(),
	getPtyPort: vi.fn(() => 9999),
	getSessionProjectId: vi.fn(() => null),
	getSessionSocket: vi.fn(() => null),
	capturePane: vi.fn(),
	tmuxArgs: vi.fn((_socket: string | null, ...args: string[]) => ["tmux", ...args]),
	setTmuxBinary: vi.fn(),
	getTmuxBinary: vi.fn(() => "tmux"),
	TMUX_CONF_PATH: "/tmp/dev3-tmux.conf",
}));

vi.mock("../agents", () => ({
	ensureClaudeTrust: vi.fn(),
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

// Mock node:fs for existsSync
vi.mock("node:fs", () => ({
	existsSync: vi.fn(() => true),
}));

import * as data from "../data";
import * as git from "../git";
import * as pty from "../pty-server";
import * as agents from "../agents";
import * as updater from "../updater";
import { loadSettings, saveSettings } from "../settings";
import { Utils } from "electrobun/bun";
import { existsSync } from "node:fs";

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

describe("setPushMessage / getPushMessage", () => {
	beforeEach(() => {
		// Reset to null
		setPushMessage(() => {});
	});

	it("stores and retrieves the push message function", () => {
		const fn = vi.fn();
		setPushMessage(fn);
		expect(getPushMessage()).toBe(fn);
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
		// Should NOT exec the agent command (only exec bash on failure)
		expect(result).not.toContain(`exec ${cmd}`);
	});

	it("includes exit code handler that keeps shell alive on failure", () => {
		const result = buildCmdScript("claude");
		expect(result).toContain("__EC=$?");
		expect(result).toContain("if [ $__EC -ne 0 ]; then");
		expect(result).toContain("exec bash");
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

// ================================================================
// handlers.updateProjectSettings
// ================================================================

describe("handlers.updateProjectSettings", () => {
	beforeEach(() => vi.clearAllMocks());

	it("updates project with new settings", async () => {
		const updated = makeProject({ setupScript: "bun install" });
		vi.mocked(data.updateProject).mockResolvedValue(updated);

		const result = await handlers.updateProjectSettings({
			projectId: "proj-1",
			setupScript: "bun install",
			devScript: "",
			cleanupScript: "echo done",
			defaultBaseBranch: "main",
			clonePaths: ["node_modules"],
		});

		expect(result).toEqual(updated);
		expect(data.updateProject).toHaveBeenCalledWith("proj-1", {
			setupScript: "bun install",
			devScript: "",
			cleanupScript: "echo done",
			defaultBaseBranch: "main",
			clonePaths: ["node_modules"],
		});
	});
});

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
		expect(pty.destroySession).toHaveBeenCalledWith("task-1");
		expect(git.removeWorktree).toHaveBeenCalledWith(project, task);
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
		expect(pty.destroySession).toHaveBeenCalledWith("task-1");
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

	it("deletes a todo task without cleanup", async () => {
		const project = makeProject();
		const task = makeTask({ status: "todo", worktreePath: null });
		vi.mocked(data.getProject).mockResolvedValue(project);
		vi.mocked(data.getTask).mockResolvedValue(task);

		await handlers.deleteTask({ taskId: "task-1", projectId: "proj-1" });
		expect(data.deleteTask).toHaveBeenCalledWith(project, "task-1");
		expect(pty.destroySession).not.toHaveBeenCalled();
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
		expect(pty.destroySession).toHaveBeenCalledWith("task-1");
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
		const variantTask = makeTask({ id: "variant-1", status: "in-progress" });
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

		expect(result).toHaveLength(2);
		expect(data.addTask).toHaveBeenCalledTimes(2);
		expect(git.createWorktree).toHaveBeenCalledTimes(2);
	});

	it("inherits existingBranch from source task into single variant", async () => {
		const project = makeProject();
		const sourceTask = makeTask({ status: "todo", seq: 5, existingBranch: "feature/login" });
		const variantTask = makeTask({ id: "variant-1", status: "in-progress", existingBranch: "feature/login" });
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
			expect.objectContaining({ existingBranch: "feature/login" }),
		);
		// Single variant: use existing branch directly, no variantBranchName
		expect(git.createWorktree).toHaveBeenCalledWith(project, variantTask, "feature/login", undefined);
	});

	it("creates per-variant branches when spawning multiple variants with existingBranch", async () => {
		const project = makeProject();
		const sourceTask = makeTask({ status: "todo", seq: 5, existingBranch: "feature/login" });
		const variantTask = makeTask({ id: "variant-1", status: "in-progress", existingBranch: "feature/login" });
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
		expect(addTaskCalls[0][3]).toEqual(expect.objectContaining({ existingBranch: "feature/login" }));
		expect(addTaskCalls[1][3]).toEqual(expect.objectContaining({ existingBranch: "feature/login" }));

		// Each variant gets its own branch name derived from the existing branch
		const createWtCalls = vi.mocked(git.createWorktree).mock.calls;
		expect(createWtCalls[0][2]).toBe("feature/login");
		expect(createWtCalls[0][3]).toBe("feature/login-v1");
		expect(createWtCalls[1][2]).toBe("feature/login");
		expect(createWtCalls[1][3]).toBe("feature/login-v2");
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
		expect(result).toEqual({ ahead: 0, behind: 0, canRebase: false, insertions: 0, deletions: 0, unpushed: 0, mergedByContent: false });
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
		vi.mocked(git.canRebaseCleanly).mockResolvedValue(true);

		const result = await handlers.getBranchStatus({ taskId: "task-1", projectId: "proj-1" });
		expect(result).toEqual({
			ahead: 3,
			behind: 2,
			canRebase: true,
			insertions: 10,
			deletions: 5,
			unpushed: 1,
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

		await handlers.getBranchStatus({ taskId: "task-1", projectId: "proj-1" });

		expect(data.updateTask).not.toHaveBeenCalled();
	});
});

// ================================================================
// handlers.getPtyUrl
// ================================================================

describe("handlers.getPtyUrl", () => {
	beforeEach(() => vi.clearAllMocks());

	it("returns URL directly when session exists", async () => {
		vi.mocked(pty.hasSession).mockReturnValue(true);
		vi.mocked(pty.getPtyPort).mockReturnValue(9999);

		const url = await handlers.getPtyUrl({ taskId: "task-1" });
		expect(url).toBe("ws://localhost:9999?session=task-1");
	});

	it("tries to restore PTY when session is missing", async () => {
		const project = makeProject();
		const task = makeTask({ status: "in-progress", worktreePath: "/tmp/wt" });

		vi.mocked(pty.hasSession).mockReturnValue(false);
		vi.mocked(pty.getPtyPort).mockReturnValue(9999);
		vi.mocked(data.loadProjects).mockResolvedValue([project]);
		vi.mocked(data.getTask).mockResolvedValue(task);

		const url = await handlers.getPtyUrl({ taskId: "task-1" });
		expect(url).toContain("ws://localhost:9999");
		expect(url).toContain("session=task-1");
	});

	it("does not crash when worktree is missing during restore", async () => {
		const project = makeProject();
		const task = makeTask({ status: "in-progress", worktreePath: "/tmp/deleted" });

		vi.mocked(pty.hasSession).mockReturnValue(false);
		vi.mocked(data.loadProjects).mockResolvedValue([project]);
		vi.mocked(data.getTask).mockResolvedValue(task);
		vi.mocked(existsSync).mockReturnValue(false);

		const url = await handlers.getPtyUrl({ taskId: "task-1" });
		expect(url).toContain("session=task-1");
	});

	it("handles task not found across projects", async () => {
		vi.mocked(pty.hasSession).mockReturnValue(false);
		vi.mocked(data.loadProjects).mockResolvedValue([makeProject()]);
		vi.mocked(data.getTask).mockRejectedValue(new Error("not found"));

		const url = await handlers.getPtyUrl({ taskId: "task-unknown" });
		expect(url).toContain("session=task-unknown");
	});

	it("skips restore for completed task", async () => {
		const project = makeProject();
		const task = makeTask({ status: "completed", worktreePath: null });

		vi.mocked(pty.hasSession).mockReturnValue(false);
		vi.mocked(data.loadProjects).mockResolvedValue([project]);
		vi.mocked(data.getTask).mockResolvedValue(task);

		const url = await handlers.getPtyUrl({ taskId: "task-1" });
		expect(url).toContain("session=task-1");
		// Should not attempt launchTaskPty for completed task
		expect(pty.createSession).not.toHaveBeenCalled();
	});

	it("destroys dead session and relaunches with resume flag", async () => {
		const project = makeProject();
		const task = makeTask({ status: "in-progress", worktreePath: "/tmp/wt" });

		// Session exists in map but proc is dead; after destroySession, hasSession returns false
		vi.mocked(pty.hasDeadSession).mockReturnValue(true);
		vi.mocked(pty.hasSession).mockReturnValue(false); // reflects state after destroy
		vi.mocked(pty.getPtyPort).mockReturnValue(9999);
		vi.mocked(data.loadProjects).mockResolvedValue([project]);
		vi.mocked(data.getTask).mockResolvedValue(task);

		const url = await handlers.getPtyUrl({ taskId: "task-1", resume: true });

		expect(pty.destroySession).toHaveBeenCalledWith("task-1");
		expect(url).toContain("session=task-1");
		expect(pty.createSession).toHaveBeenCalled();
	});

	it("does not destroy session when resume=true but session is alive", async () => {
		vi.mocked(pty.hasDeadSession).mockReturnValue(false);
		vi.mocked(pty.hasSession).mockReturnValue(true);
		vi.mocked(pty.getPtyPort).mockReturnValue(9999);

		const url = await handlers.getPtyUrl({ taskId: "task-1", resume: true });

		expect(pty.destroySession).not.toHaveBeenCalled();
		expect(url).toBe("ws://localhost:9999?session=task-1");
	});

	it("does not destroy dead session when resume is not set", async () => {
		const project = makeProject();
		const task = makeTask({ status: "in-progress", worktreePath: "/tmp/wt" });

		vi.mocked(pty.hasDeadSession).mockReturnValue(true);
		vi.mocked(pty.hasSession).mockReturnValue(false);
		vi.mocked(pty.getPtyPort).mockReturnValue(9999);
		vi.mocked(data.loadProjects).mockResolvedValue([project]);
		vi.mocked(data.getTask).mockResolvedValue(task);

		await handlers.getPtyUrl({ taskId: "task-1" });

		expect(pty.destroySession).not.toHaveBeenCalled();
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
		vi.mocked(pty.getPtyPort).mockReturnValue(9999);
		vi.mocked(data.loadProjects).mockResolvedValue([project]);
		vi.mocked(data.getTask).mockResolvedValue(task);

		await handlers.getPtyUrl({ taskId: "task-1" });

		expect(agents.resolveCommandForAgent).toHaveBeenCalledWith(
			"agent-claude",
			"config-opus",
			expect.any(Object),
			undefined,
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
		vi.mocked(pty.getPtyPort).mockReturnValue(9999);
		vi.mocked(data.loadProjects).mockResolvedValue([project]);
		vi.mocked(data.getTask).mockResolvedValue(task);

		await handlers.getPtyUrl({ taskId: "task-1", resume: true });

		expect(agents.resolveCommandForAgent).toHaveBeenCalledWith(
			"agent-claude",
			"config-opus",
			expect.any(Object),
			{ resume: true },
		);
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

		const url = await handlers.getPtyUrl({ taskId: "task-1" });
		expect(url).toContain("session=task-1");
	});

	it("does not crash when launchTaskPty throws during restore", async () => {
		const project = makeProject();
		const task = makeTask({ status: "in-progress", worktreePath: "/tmp/wt" });

		vi.mocked(pty.hasSession).mockReturnValue(false);
		vi.mocked(pty.getPtyPort).mockReturnValue(9999);
		vi.mocked(data.loadProjects).mockResolvedValue([project]);
		vi.mocked(data.getTask).mockResolvedValue(task);
		vi.mocked(agents.resolveCommandForProject).mockRejectedValueOnce(new Error("agent resolution failed"));

		const url = await handlers.getPtyUrl({ taskId: "task-1" });
		expect(url).toContain("session=task-1");
	});

	it("skips restore when task has active status but null worktreePath", async () => {
		const project = makeProject();
		const task = makeTask({ status: "in-progress", worktreePath: null });

		vi.mocked(pty.hasSession).mockReturnValue(false);
		vi.mocked(pty.getPtyPort).mockReturnValue(9999);
		vi.mocked(data.loadProjects).mockResolvedValue([project]);
		vi.mocked(data.getTask).mockResolvedValue(task);

		const url = await handlers.getPtyUrl({ taskId: "task-1" });
		expect(url).toContain("session=task-1");
		expect(pty.createSession).not.toHaveBeenCalled();
	});

	it("finds task in second project when first has no match", async () => {
		const project1 = makeProject({ id: "proj-1" });
		const project2 = makeProject({ id: "proj-2" });
		const task = makeTask({ status: "in-progress", worktreePath: "/tmp/wt" });

		vi.mocked(pty.hasSession).mockReturnValue(false);
		vi.mocked(pty.getPtyPort).mockReturnValue(9999);
		vi.mocked(data.loadProjects).mockResolvedValue([project1, project2]);
		vi.mocked(data.getTask)
			.mockRejectedValueOnce(new Error("not found"))
			.mockResolvedValueOnce(task);

		const url = await handlers.getPtyUrl({ taskId: "task-1" });
		expect(url).toContain("session=task-1");
		expect(pty.createSession).toHaveBeenCalled();
	});

	it("resume=true with no dead session and no live session restores normally", async () => {
		const project = makeProject();
		const task = makeTask({ status: "in-progress", worktreePath: "/tmp/wt" });

		vi.mocked(pty.hasDeadSession).mockReturnValue(false);
		vi.mocked(pty.hasSession).mockReturnValue(false);
		vi.mocked(pty.getPtyPort).mockReturnValue(9999);
		vi.mocked(data.loadProjects).mockResolvedValue([project]);
		vi.mocked(data.getTask).mockResolvedValue(task);

		const url = await handlers.getPtyUrl({ taskId: "task-1", resume: true });

		expect(pty.destroySession).not.toHaveBeenCalled();
		expect(url).toContain("session=task-1");
		expect(pty.createSession).toHaveBeenCalled();
	});
});

// ================================================================
// handlers.getTerminalPreview
// ================================================================

describe("handlers.getTerminalPreview", () => {
	beforeEach(() => vi.clearAllMocks());

	it("delegates to pty.capturePane", async () => {
		vi.mocked(pty.capturePane).mockReturnValue("terminal output");
		const result = await handlers.getTerminalPreview({ taskId: "task-1" });
		expect(result).toBe("terminal output");
		expect(pty.capturePane).toHaveBeenCalledWith("task-1");
	});

	it("returns null when no session", async () => {
		vi.mocked(pty.capturePane).mockReturnValue(null);
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

// ================================================================
// handlers.pickFolder
// ================================================================

describe("handlers.pickFolder", () => {
	beforeEach(() => vi.clearAllMocks());

	it("returns the selected path", async () => {
		vi.mocked(Utils.openFileDialog).mockResolvedValue(["/Users/test/project"] as any);
		const result = await handlers.pickFolder();
		expect(result).toBe("/Users/test/project");
	});

	it("always starts from home directory", async () => {
		vi.mocked(Utils.openFileDialog).mockResolvedValue(["/some/path"] as any);
		await handlers.pickFolder();
		const call = vi.mocked(Utils.openFileDialog).mock.calls[0][0] as any;
		expect(call.startingFolder).toBeTruthy();
		expect(typeof call.startingFolder).toBe("string");
	});

	it("returns null when dialog is cancelled (empty array)", async () => {
		vi.mocked(Utils.openFileDialog).mockResolvedValue([] as any);
		const result = await handlers.pickFolder();
		expect(result).toBeNull();
	});

	it("returns null when dialog returns null", async () => {
		vi.mocked(Utils.openFileDialog).mockResolvedValue(null as any);
		const result = await handlers.pickFolder();
		expect(result).toBeNull();
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
		vi.mocked(data.getProject).mockResolvedValue(project);
		vi.mocked(data.updateProject).mockResolvedValue(project);

		const label = await handlers.createLabel({ projectId: "proj-1", name: " My Label " });
		expect(label.name).toBe("My Label");
		expect(label.id).toBeTruthy();
		expect(label.color).toBeTruthy();
		expect(data.updateProject).toHaveBeenCalledWith("proj-1", {
			labels: [expect.objectContaining({ name: "My Label" })],
		});
	});

	it("uses provided color when specified", async () => {
		const project = makeProject({ labels: [] });
		vi.mocked(data.getProject).mockResolvedValue(project);
		vi.mocked(data.updateProject).mockResolvedValue(project);

		const label = await handlers.createLabel({ projectId: "proj-1", name: "Bug", color: "#ff0000" });
		expect(label.color).toBe("#ff0000");
	});

	it("skips already-used colors when auto-picking", async () => {
		const project = makeProject({
			labels: [{ id: "l1", name: "L1", color: "#ef4444" }],
		});
		vi.mocked(data.getProject).mockResolvedValue(project);
		vi.mocked(data.updateProject).mockResolvedValue(project);

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
		vi.mocked(data.getProject).mockResolvedValue(project);
		vi.mocked(data.updateProject).mockResolvedValue(project);

		const result = await handlers.updateLabel({ projectId: "proj-1", labelId: "l1", name: " New " });
		expect(result.name).toBe("New");
		expect(result.color).toBe("#ef4444");
	});

	it("updates label color", async () => {
		const project = makeProject({
			labels: [{ id: "l1", name: "Bug", color: "#ef4444" }],
		});
		vi.mocked(data.getProject).mockResolvedValue(project);
		vi.mocked(data.updateProject).mockResolvedValue(project);

		const result = await handlers.updateLabel({ projectId: "proj-1", labelId: "l1", color: "#00ff00" });
		expect(result.color).toBe("#00ff00");
	});

	it("throws when label not found", async () => {
		const project = makeProject({ labels: [] });
		vi.mocked(data.getProject).mockResolvedValue(project);

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
		vi.mocked(data.updateProject).mockResolvedValue(project);
		vi.mocked(data.loadTasks).mockResolvedValue(tasks);
		vi.mocked(data.updateTask).mockResolvedValue(tasks[0]);

		await handlers.deleteLabel({ projectId: "proj-1", labelId: "l1" });

		// Should only update the label list (without l1)
		expect(data.updateProject).toHaveBeenCalledWith("proj-1", {
			labels: [{ id: "l2", name: "Feature", color: "#3b82f6" }],
		});
		// Should only update task t1 which had l1
		expect(data.updateTask).toHaveBeenCalledTimes(1);
		expect(data.updateTask).toHaveBeenCalledWith(project, "t1", { labelIds: ["l2"] });
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
		const updated = makeTask({ notes: [{ id: "n1", content: "Hello", source: "user", createdAt: "", updatedAt: "" }] });
		vi.mocked(data.getProject).mockResolvedValue(project);
		vi.mocked(data.getTask).mockResolvedValue(task);
		vi.mocked(data.updateTask).mockResolvedValue(updated);

		const result = await handlers.addTaskNote({ taskId: "task-1", projectId: "proj-1", content: "Hello" });
		expect(result.notes).toHaveLength(1);

		const updateCall = vi.mocked(data.updateTask).mock.calls[0];
		const notesArg = updateCall[2].notes as any[];
		expect(notesArg).toHaveLength(1);
		expect(notesArg[0].content).toBe("Hello");
		expect(notesArg[0].source).toBe("user");
	});

	it("adds a note with explicit source 'ai'", async () => {
		const project = makeProject();
		const task = makeTask({ notes: [] });
		vi.mocked(data.getProject).mockResolvedValue(project);
		vi.mocked(data.getTask).mockResolvedValue(task);
		vi.mocked(data.updateTask).mockResolvedValue(makeTask());

		await handlers.addTaskNote({ taskId: "task-1", projectId: "proj-1", content: "AI note", source: "ai" });

		const updateCall = vi.mocked(data.updateTask).mock.calls[0];
		const notesArg = updateCall[2].notes as any[];
		expect(notesArg[0].source).toBe("ai");
	});

	it("appends to existing notes", async () => {
		const existingNote = { id: "n0", content: "Old", source: "user" as const, createdAt: "", updatedAt: "" };
		const project = makeProject();
		const task = makeTask({ notes: [existingNote] });
		vi.mocked(data.getProject).mockResolvedValue(project);
		vi.mocked(data.getTask).mockResolvedValue(task);
		vi.mocked(data.updateTask).mockResolvedValue(makeTask());

		await handlers.addTaskNote({ taskId: "task-1", projectId: "proj-1", content: "New" });

		const updateCall = vi.mocked(data.updateTask).mock.calls[0];
		const notesArg = updateCall[2].notes as any[];
		expect(notesArg).toHaveLength(2);
		expect(notesArg[0].content).toBe("Old");
		expect(notesArg[1].content).toBe("New");
	});
});

describe("handlers.updateTaskNote", () => {
	beforeEach(() => vi.clearAllMocks());

	it("updates the content of a specific note", async () => {
		const note = { id: "n1", content: "Old", source: "user" as const, createdAt: "2024-01-01", updatedAt: "2024-01-01" };
		const project = makeProject();
		const task = makeTask({ notes: [note] });
		vi.mocked(data.getProject).mockResolvedValue(project);
		vi.mocked(data.getTask).mockResolvedValue(task);
		vi.mocked(data.updateTask).mockResolvedValue(makeTask());

		await handlers.updateTaskNote({ taskId: "task-1", projectId: "proj-1", noteId: "n1", content: "Updated" });

		const updateCall = vi.mocked(data.updateTask).mock.calls[0];
		const notesArg = updateCall[2].notes as any[];
		expect(notesArg[0].content).toBe("Updated");
		expect(notesArg[0].id).toBe("n1");
	});

	it("does not modify other notes", async () => {
		const note1 = { id: "n1", content: "Note 1", source: "user" as const, createdAt: "", updatedAt: "" };
		const note2 = { id: "n2", content: "Note 2", source: "ai" as const, createdAt: "", updatedAt: "" };
		const project = makeProject();
		const task = makeTask({ notes: [note1, note2] });
		vi.mocked(data.getProject).mockResolvedValue(project);
		vi.mocked(data.getTask).mockResolvedValue(task);
		vi.mocked(data.updateTask).mockResolvedValue(makeTask());

		await handlers.updateTaskNote({ taskId: "task-1", projectId: "proj-1", noteId: "n1", content: "Changed" });

		const updateCall = vi.mocked(data.updateTask).mock.calls[0];
		const notesArg = updateCall[2].notes as any[];
		expect(notesArg[0].content).toBe("Changed");
		expect(notesArg[1].content).toBe("Note 2"); // unchanged
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
		vi.mocked(data.getTask).mockResolvedValue(task);
		vi.mocked(data.updateTask).mockResolvedValue(makeTask());

		await handlers.deleteTaskNote({ taskId: "task-1", projectId: "proj-1", noteId: "n2" });

		const updateCall = vi.mocked(data.updateTask).mock.calls[0];
		const notesArg = updateCall[2].notes as any[];
		expect(notesArg).toHaveLength(1);
		expect(notesArg[0].id).toBe("n1");
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
			["tmux", "kill-session", "-t", "dev3-abc12345"],
			expect.any(Object),
		);
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
// handlers.showDiff / showUncommittedDiff
// ================================================================

describe("handlers.showDiff", () => {
	beforeEach(() => vi.clearAllMocks());

	it("throws when task has no worktree", async () => {
		const project = makeProject();
		const task = makeTask({ worktreePath: null });
		vi.mocked(data.getProject).mockResolvedValue(project);
		vi.mocked(data.getTask).mockResolvedValue(task);

		await expect(
			handlers.showDiff({ taskId: "task-1", projectId: "proj-1" }),
		).rejects.toThrow("Task has no worktree");
	});
});

describe("handlers.showUncommittedDiff", () => {
	beforeEach(() => vi.clearAllMocks());

	it("throws when task has no worktree", async () => {
		const project = makeProject();
		const task = makeTask({ worktreePath: null });
		vi.mocked(data.getProject).mockResolvedValue(project);
		vi.mocked(data.getTask).mockResolvedValue(task);

		await expect(
			handlers.showUncommittedDiff({ taskId: "task-1", projectId: "proj-1" }),
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
			["tmux", "split-window", "-v", "-c", "#{pane_current_path}", "-t", "dev3-abcd1234"],
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
			["tmux", "split-window", "-h", "-c", "#{pane_current_path}", "-t", "dev3-abcd1234"],
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
			["tmux", "resize-pane", "-Z", "-t", "dev3-abcd1234"],
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
});

describe("reorderCustomColumns", () => {
	const colA = { id: "col-aaa", name: "Alpha", color: "#ff0000", llmInstruction: "" };
	const colB = { id: "col-bbb", name: "Beta", color: "#00ff00", llmInstruction: "" };
	const colC = { id: "col-ccc", name: "Gamma", color: "#0000ff", llmInstruction: "" };

	beforeEach(() => {
		vi.clearAllMocks();
		mockSpawn.mockReturnValue({ stderr: new Response(""), stdout: new Response(""), exited: Promise.resolve(0) });
	});

	it("reorders columns to specified order", async () => {
		const project = makeProject({ customColumns: [colA, colB, colC] });
		const updatedProject = { ...project, customColumns: [colC, colA, colB] };
		vi.mocked(data.getProject).mockResolvedValue(project);
		vi.mocked(data.updateProject).mockResolvedValue(updatedProject);

		const result = await handlers.reorderCustomColumns({
			projectId: "proj-1",
			columnIds: ["col-ccc", "col-aaa", "col-bbb"],
		});

		expect(data.updateProject).toHaveBeenCalledWith("proj-1", {
			customColumns: [colC, colA, colB],
		});
		expect(result.customColumns).toEqual([colC, colA, colB]);
	});

	it("ignores unknown column IDs", async () => {
		const project = makeProject({ customColumns: [colA, colB] });
		const updatedProject = { ...project, customColumns: [colB, colA] };
		vi.mocked(data.getProject).mockResolvedValue(project);
		vi.mocked(data.updateProject).mockResolvedValue(updatedProject);

		await handlers.reorderCustomColumns({
			projectId: "proj-1",
			columnIds: ["col-bbb", "col-aaa", "col-unknown"],
		});

		expect(data.updateProject).toHaveBeenCalledWith("proj-1", {
			customColumns: [colB, colA],
		});
	});
});

describe("moveTaskToCustomColumn — resume logic", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockSpawn.mockReturnValue({ stderr: new Response(""), stdout: new Response(""), exited: Promise.resolve(0) });
		vi.mocked(git.createWorktree).mockResolvedValue({ worktreePath: "/tmp/new-wt", branchName: "dev3/resumed" } as any);
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
		});
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
		}));
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
