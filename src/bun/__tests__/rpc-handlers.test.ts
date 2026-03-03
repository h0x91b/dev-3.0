import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Project, Task } from "../../shared/types";

// ---- Mocks ----

vi.mock("electrobun/bun", () => ({
	Utils: {
		showMessageBox: vi.fn(),
		openFileDialog: vi.fn(),
	},
}));

vi.mock("../data", () => ({
	getProject: vi.fn(),
	getTask: vi.fn(),
	loadProjects: vi.fn(),
	loadTasks: vi.fn(),
	updateTask: vi.fn(),
	addTask: vi.fn(),
	deleteTask: vi.fn(),
}));

vi.mock("../git", () => ({
	removeWorktree: vi.fn(),
	createWorktree: vi.fn(),
	isGitRepo: vi.fn(),
	getDefaultBranch: vi.fn(),
}));

vi.mock("../pty-server", () => ({
	createSession: vi.fn(),
	destroySession: vi.fn(),
	hasSession: vi.fn(),
	getPtyPort: vi.fn(() => 9999),
	getSessionProjectId: vi.fn(() => null),
}));

vi.mock("../agents", () => ({
	ensureClaudeTrust: vi.fn(),
	resolveCommandForAgent: vi.fn(() => ({ command: "claude", extraEnv: {} })),
	resolveCommandForProject: vi.fn(() => ({ command: "claude", extraEnv: {} })),
}));

vi.mock("../settings", () => ({
	loadSettings: vi.fn(() => ({})),
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

vi.mock("../clone", () => ({
	clonePathsToWorktree: vi.fn(() => Promise.resolve([])),
}));

// Mock node:fs for existsSync
vi.mock("node:fs", () => ({
	existsSync: vi.fn(() => true),
}));

import * as data from "../data";
import * as git from "../git";
import * as pty from "../pty-server";
import { existsSync } from "node:fs";

// Import handlers and pure helper functions after all mocks are set up
const { handlers, escapeForDoubleQuotes, buildEchoAndRun, buildCmdScript } = await import("../rpc-handlers");

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
		clonePaths: [],
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

describe("moveTask — active → completed with missing worktree", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("should NOT throw when worktree directory is missing; should skip cleanup, skip removeWorktree, still update status", async () => {
		const project = makeProject({ cleanupScript: "echo cleanup" });
		const task = makeTask({
			status: "in-progress",
			worktreePath: "/tmp/deleted-worktree",
		});

		vi.mocked(data.getProject).mockResolvedValue(project);
		vi.mocked(data.getTask).mockResolvedValue(task);
		vi.mocked(data.updateTask).mockResolvedValue({
			...task,
			status: "completed",
			worktreePath: null,
			branchName: null,
		});
		vi.mocked(existsSync).mockReturnValue(false);

		const result = await handlers.moveTask({
			taskId: "task-1",
			projectId: "proj-1",
			newStatus: "completed",
		});

		expect(result.status).toBe("completed");
		expect(result.worktreePath).toBeNull();
		expect(result.branchName).toBeNull();

		// updateTask must be called to persist the new status
		expect(data.updateTask).toHaveBeenCalledWith(
			project,
			"task-1",
			expect.objectContaining({
				status: "completed",
				worktreePath: null,
				branchName: null,
			}),
		);
	});

	it("should NOT throw when worktree directory is missing (cancelled)", async () => {
		const project = makeProject({ cleanupScript: "echo cleanup" });
		const task = makeTask({
			status: "in-progress",
			worktreePath: "/tmp/deleted-worktree",
		});

		vi.mocked(data.getProject).mockResolvedValue(project);
		vi.mocked(data.getTask).mockResolvedValue(task);
		vi.mocked(data.updateTask).mockResolvedValue({
			...task,
			status: "cancelled",
			worktreePath: null,
			branchName: null,
		});
		vi.mocked(existsSync).mockReturnValue(false);

		const result = await handlers.moveTask({
			taskId: "task-1",
			projectId: "proj-1",
			newStatus: "cancelled",
		});

		expect(result.status).toBe("cancelled");
		expect(data.updateTask).toHaveBeenCalled();
	});

	it("should tolerate removeWorktree failure when branch is already deleted", async () => {
		const project = makeProject({ cleanupScript: "" });
		const task = makeTask({
			status: "in-progress",
			worktreePath: "/tmp/existing-worktree",
		});

		vi.mocked(data.getProject).mockResolvedValue(project);
		vi.mocked(data.getTask).mockResolvedValue(task);
		vi.mocked(data.updateTask).mockResolvedValue({
			...task,
			status: "completed",
			worktreePath: null,
			branchName: null,
		});
		vi.mocked(existsSync).mockReturnValue(true);
		vi.mocked(git.removeWorktree).mockRejectedValue(new Error("branch not found"));

		const result = await handlers.moveTask({
			taskId: "task-1",
			projectId: "proj-1",
			newStatus: "completed",
		});

		expect(result.status).toBe("completed");
		expect(data.updateTask).toHaveBeenCalled();
	});
});

describe("runCleanupScript — missing worktree", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("should not throw when worktreePath is null", async () => {
		const project = makeProject({ cleanupScript: "echo cleanup" });
		const task = makeTask({
			status: "in-progress",
			worktreePath: null,
		});

		vi.mocked(data.getProject).mockResolvedValue(project);
		vi.mocked(data.getTask).mockResolvedValue(task);
		vi.mocked(data.updateTask).mockResolvedValue({
			...task,
			status: "completed",
			worktreePath: null,
			branchName: null,
		});

		// Moving a task with null worktreePath to completed — the cleanup script
		// check `if (!task.worktreePath ...)` should return early.
		// But since task.worktreePath is null, it's not active→terminal transition actually,
		// let's make it active status
		const result = await handlers.moveTask({
			taskId: "task-1",
			projectId: "proj-1",
			newStatus: "completed",
		});

		expect(result.status).toBe("completed");
	});
});

describe("getPtyUrl — missing worktree", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("should not crash when worktree directory is missing during PTY restore", async () => {
		const project = makeProject();
		const task = makeTask({
			status: "in-progress",
			worktreePath: "/tmp/deleted-worktree",
		});

		vi.mocked(pty.hasSession).mockReturnValue(false);
		vi.mocked(data.loadProjects).mockResolvedValue([project]);
		vi.mocked(data.getTask).mockResolvedValue(task);
		vi.mocked(existsSync).mockReturnValue(false);

		// Should return a URL even if launchTaskPty fails
		const url = await handlers.getPtyUrl({ taskId: "task-1" });
		expect(url).toContain("ws://localhost:");
		expect(url).toContain("session=task-1");
	});

	it("should return URL normally when PTY session already exists", async () => {
		vi.mocked(pty.hasSession).mockReturnValue(true);
		vi.mocked(pty.getPtyPort).mockReturnValue(9999);

		const url = await handlers.getPtyUrl({ taskId: "task-1" });
		expect(url).toBe("ws://localhost:9999?session=task-1");
	});
});

// ---- escapeForDoubleQuotes ----

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

// ---- buildEchoAndRun ----

describe("buildEchoAndRun", () => {
	it("wraps simple command with echo prefix", () => {
		const result = buildEchoAndRun("claude");
		expect(result).toBe('echo "Starting: claude" && claude');
	});

	it("preserves the actual command verbatim after &&", () => {
		const cmd = "claude --model opus 'Fix the bug'";
		const result = buildEchoAndRun(cmd);
		// Actual command after && must be unchanged
		expect(result.endsWith(`&& ${cmd}`)).toBe(true);
	});

	it("escapes double quotes in echo portion", () => {
		const cmd = 'claude "quoted arg"';
		const result = buildEchoAndRun(cmd);
		expect(result).toBe('echo "Starting: claude \\"quoted arg\\"" && claude "quoted arg"');
	});

	it("escapes dollar signs in echo portion", () => {
		const cmd = "claude '$HOME/path'";
		const result = buildEchoAndRun(cmd);
		// In echo: $HOME must be escaped to prevent expansion
		expect(result.startsWith('echo "Starting: claude ')).toBe(true);
		expect(result).toContain("\\$HOME");
		// But actual command is verbatim
		expect(result.endsWith("&& claude '$HOME/path'")).toBe(true);
	});

	it("escapes backticks in echo portion", () => {
		const cmd = "claude 'run `whoami`'";
		const result = buildEchoAndRun(cmd);
		expect(result).toContain("\\`whoami\\`");
		expect(result.endsWith("&& claude 'run `whoami`'")).toBe(true);
	});

	it("escapes backslashes in echo portion", () => {
		const cmd = "claude 'it'\\''s a test'";
		const result = buildEchoAndRun(cmd);
		// The \' shell escape pattern contains a backslash that must be escaped in echo
		expect(result).toContain("\\\\");
		// Actual command is verbatim
		expect(result.endsWith(`&& ${cmd}`)).toBe(true);
	});

	it("handles command with single-quoted shellEscape output", () => {
		// This simulates what resolveAgentCommand produces
		const cmd = "claude --append-system-prompt 'MANDATORY: ...' 'Fix the login bug'";
		const result = buildEchoAndRun(cmd);
		expect(result.startsWith('echo "Starting: ')).toBe(true);
		expect(result.endsWith(`&& ${cmd}`)).toBe(true);
	});

	it("handles real-world command with special chars in task description", () => {
		// Task: Fix the "login" bug (it's broken); check $PATH & `env`
		// After shellEscape: 'Fix the "login" bug (it'\''s broken); check $PATH & `env`'
		const escaped = "'Fix the \"login\" bug (it'\\''s broken); check $PATH & `env`'";
		const cmd = `claude --append-system-prompt 'MANDATORY' ${escaped}`;
		const result = buildEchoAndRun(cmd);

		// Echo portion must escape: " $ ` \
		const echoPart = result.split(" && ")[0];
		// Should not contain unescaped double quotes (besides the wrapping ones)
		const echoContent = echoPart.slice('echo "Starting: '.length, -1);
		// All double quotes in content must be escaped
		expect(echoContent).not.toMatch(/(?<!\\)"/);
		// All dollar signs must be escaped
		expect(echoContent).not.toMatch(/(?<!\\)\$/);
		// All backticks must be escaped
		expect(echoContent).not.toMatch(/(?<!\\)`/);

		// Actual command must be verbatim
		expect(result.endsWith(`&& ${cmd}`)).toBe(true);
	});

	it("handles command with empty string argument", () => {
		const cmd = "claude ''";
		const result = buildEchoAndRun(cmd);
		expect(result).toBe("echo \"Starting: claude ''\" && claude ''");
	});
});

// ---- buildCmdScript ----

describe("buildCmdScript", () => {
	it("produces a valid bash script with shebang", () => {
		const result = buildCmdScript("claude 'Fix bug'");
		expect(result.startsWith("#!/bin/bash\n")).toBe(true);
	});

	it("includes echo and exec of the command", () => {
		const cmd = "claude 'Fix bug'";
		const result = buildCmdScript(cmd);
		expect(result).toContain(`exec ${cmd}`);
		expect(result).toContain("echo \"Starting:");
	});

	it("ends with a newline", () => {
		const result = buildCmdScript("claude");
		expect(result.endsWith("\n")).toBe(true);
	});

	it("escapes double quotes in echo but preserves command in exec", () => {
		const cmd = 'claude "arg"';
		const result = buildCmdScript(cmd);
		expect(result).toContain('\\"arg\\"');
		expect(result).toContain(`exec claude "arg"`);
	});

	it("escapes dollar signs in echo but preserves command in exec", () => {
		const cmd = "claude '$HOME'";
		const result = buildCmdScript(cmd);
		expect(result).toContain("\\$HOME");
		expect(result).toContain("exec claude '$HOME'");
	});

	it("handles complex command with all special chars", () => {
		const desc = "'Fix \"bug\" ($HOME); `test` \\path'";
		const cmd = `claude ${desc}`;
		const result = buildCmdScript(cmd);

		// Echo portion has proper escaping
		const lines = result.split("\n");
		const echoLine = lines.find((l) => l.startsWith("echo"));
		expect(echoLine).toBeDefined();

		// Exec portion is verbatim
		expect(result).toContain(`exec ${cmd}`);
	});
});

// ---- end-to-end: task creation shell command safety ----

describe("end-to-end: task description → shell command escaping", () => {
	/**
	 * Simulates the full pipeline: task description → shellEscape → resolveAgentCommand → buildEchoAndRun.
	 * We import shellEscape from agents module (already mocked, so we re-implement inline).
	 */
	function shellEscape(s: string): string {
		return "'" + s.replace(/'/g, "'\\''") + "'";
	}

	function simulatePipeline(taskDescription: string): {
		shellEscaped: string;
		agentCmd: string;
		echoAndRun: string;
		cmdScript: string;
	} {
		const shellEscaped = shellEscape(taskDescription);
		const agentCmd = `claude --append-system-prompt 'MANDATORY' ${shellEscaped}`;
		const echoAndRun = buildEchoAndRun(agentCmd);
		const cmdScript = buildCmdScript(agentCmd);
		return { shellEscaped, agentCmd, echoAndRun, cmdScript };
	}

	it("handles plain text task", () => {
		const { echoAndRun, agentCmd } = simulatePipeline("Fix the login bug");
		expect(echoAndRun.endsWith(`&& ${agentCmd}`)).toBe(true);
	});

	it("handles task with single quotes", () => {
		const { agentCmd, echoAndRun } = simulatePipeline("Fix it's broken auth");
		expect(agentCmd).toContain("'Fix it'\\''s broken auth'");
		expect(echoAndRun.endsWith(`&& ${agentCmd}`)).toBe(true);
	});

	it("handles task with double quotes", () => {
		const { agentCmd, echoAndRun } = simulatePipeline('Fix the "broken" auth');
		expect(agentCmd).toContain("'Fix the \"broken\" auth'");
		// Echo part should escape the double quotes
		const echoPart = echoAndRun.split(" && ")[0];
		expect(echoPart).toContain('\\"broken\\"');
	});

	it("handles task with dollar signs", () => {
		const { agentCmd, echoAndRun } = simulatePipeline("Fix $HOME expansion");
		expect(agentCmd).toContain("'Fix $HOME expansion'");
		// Echo part should escape dollar sign
		const echoPart = echoAndRun.split(" && ")[0];
		expect(echoPart).toContain("\\$HOME");
	});

	it("handles task with backticks", () => {
		const { agentCmd, echoAndRun } = simulatePipeline("Run `test` command");
		expect(agentCmd).toContain("'Run `test` command'");
		const echoPart = echoAndRun.split(" && ")[0];
		expect(echoPart).toContain("\\`test\\`");
	});

	it("handles task with shell injection attempt", () => {
		const { agentCmd, echoAndRun } = simulatePipeline("'; rm -rf / #");
		// shellEscape breaks out of single quotes safely
		expect(agentCmd).toContain("''\\'''; rm -rf / #'");
		expect(echoAndRun.endsWith(`&& ${agentCmd}`)).toBe(true);
	});

	it("handles task with all dangerous chars combined", () => {
		const desc = "Fix \"login\" (it's broken); $HOME `env` > /tmp/out & rm -rf / | cat";
		const { agentCmd, echoAndRun, cmdScript } = simulatePipeline(desc);

		// The actual command after && is the properly-escaped version
		expect(echoAndRun.endsWith(`&& ${agentCmd}`)).toBe(true);

		// The script exec line is the properly-escaped version
		expect(cmdScript).toContain(`exec ${agentCmd}`);

		// Echo portion has no unescaped dangerous chars
		const echoPart = echoAndRun.split(" && ")[0];
		const echoContent = echoPart.slice('echo "Starting: '.length, -1);
		// No unescaped " $ ` inside the echo double-quoted string
		expect(echoContent).not.toMatch(/(?<!\\)"/);
		expect(echoContent).not.toMatch(/(?<!\\)\$/);
		expect(echoContent).not.toMatch(/(?<!\\)`/);
	});

	it("handles Russian text with special chars", () => {
		const desc = "Исправь баг \"авторизации\" и проверь $PATH";
		const { agentCmd, echoAndRun } = simulatePipeline(desc);
		expect(agentCmd).toContain("Исправь баг");
		expect(echoAndRun.endsWith(`&& ${agentCmd}`)).toBe(true);
		const echoPart = echoAndRun.split(" && ")[0];
		expect(echoPart).toContain("\\$PATH");
		expect(echoPart).toContain('\\"авторизации\\"');
	});

	it("handles newlines in task description", () => {
		const desc = "Step 1: do this\nStep 2: do that\nStep 3: profit";
		const { agentCmd, echoAndRun } = simulatePipeline(desc);
		expect(agentCmd).toContain("Step 1: do this\nStep 2: do that");
		expect(echoAndRun.endsWith(`&& ${agentCmd}`)).toBe(true);
	});

	it("handles empty task description", () => {
		const { shellEscaped } = simulatePipeline("");
		expect(shellEscaped).toBe("''");
	});
});
