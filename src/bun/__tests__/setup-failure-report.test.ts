/**
 * A `setupScript` runs inside the pane, so its exit code never reaches bun on
 * its own. These cover the whole channel that replaces that missing return
 * value: the wrapper's fail branch records the code and pings the CLI, and the
 * CLI's socket method turns the recorded code into task state.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Project, Task, CliRequest } from "../../shared/types";
import { buildSetupStartupWrapper } from "../rpc-handlers/shared-pure";
import { setupExitCodePath } from "../temp-paths";

const WRAPPER_ARGS = {
	setupPath: "/tmp/dev3-T-setup.sh",
	cmdPath: "/tmp/dev3-T-cmd.sh",
	worktreePath: "/w/t",
	shellPath: "/bin/zsh",
	setupExitPath: "/tmp/dev3-T-setup-exit",
	dev3CliPath: "/Users/x/.dev3.0/bin/dev3",
};

function withPlatform<T>(platform: NodeJS.Platform, fn: () => T): T {
	const real = process.platform;
	const realSystemRoot = process.env.SystemRoot;
	Object.defineProperty(process, "platform", { value: platform, writable: true });
	// Without it PowerShell 5.1 cannot be located at all and the builder throws.
	if (platform === "win32") process.env.SystemRoot = "C:\\Windows";
	try {
		return fn();
	} finally {
		Object.defineProperty(process, "platform", { value: real, writable: true });
		if (realSystemRoot === undefined) delete process.env.SystemRoot;
		else process.env.SystemRoot = realSystemRoot;
	}
}

describe("setup wrapper — reporting a failed setupScript", () => {
	it("records the exit code and pings the CLI before dropping to a shell", () => {
		const script = buildSetupStartupWrapper({ ...WRAPPER_ARGS, nativeBackend: true, launchMode: "parallel" });
		const lines = script.split("\n").map((l) => l.trim());

		const write = lines.findIndex((l) => l === `printf '%s' "$S" > '/tmp/dev3-T-setup-exit'`);
		const ping = lines.findIndex((l) => l === `'/Users/x/.dev3.0/bin/dev3' 'hook' 'setup-failed'`);
		const shell = lines.findIndex((l) => l === "exec '/bin/zsh'");

		expect(write).toBeGreaterThan(-1);
		// The exec never returns, so both must precede it, and the file must exist
		// before the app is told to read it.
		expect(ping).toBeGreaterThan(write);
		expect(shell).toBeGreaterThan(ping);
	});

	it("guards the ping on the CLI existing, so a missing dev3 cannot break the launch", () => {
		const script = buildSetupStartupWrapper({ ...WRAPPER_ARGS, nativeBackend: true, launchMode: "parallel" });
		expect(script).toContain(`if command -v '/Users/x/.dev3.0/bin/dev3' &>/dev/null; then`);
	});

	it("reports nothing on the success path", () => {
		const script = buildSetupStartupWrapper({ ...WRAPPER_ARGS, nativeBackend: true, launchMode: "parallel" });
		const afterFailBranch = script.slice(script.indexOf("✓ Setup done"));
		expect(afterFailBranch).not.toContain("setup-failed");
		expect(afterFailBranch).not.toContain("dev3-T-setup-exit");
	});

	// Windows has no `printf ... >` and no `command -v`; PowerShell 5.1's `>` would
	// also write UTF-16LE. Assert the PowerShell spellings, not just that "some"
	// reporting happens.
	it("uses the PowerShell spellings on win32", () => {
		const script = withPlatform("win32", () =>
			buildSetupStartupWrapper({ ...WRAPPER_ARGS, nativeBackend: true, launchMode: "parallel" }),
		);
		expect(script).toContain("[System.IO.File]::WriteAllText('/tmp/dev3-T-setup-exit', [string]$S)");
		expect(script).toContain("Get-Command '/Users/x/.dev3.0/bin/dev3' -ErrorAction SilentlyContinue");
		expect(script).not.toContain("command -v");
	});
});

// ---- Socket method ----

vi.mock("../data", () => ({
	loadProjects: vi.fn(),
	getProject: vi.fn(),
	loadTasks: vi.fn(),
	getTask: vi.fn(),
	addTask: vi.fn(),
	updateTask: vi.fn(),
	updateProject: vi.fn(),
}));

vi.mock("../git", () => ({ createWorktree: vi.fn(), removeWorktree: vi.fn() }));
vi.mock("../pty-server", () => ({ destroySession: vi.fn() }));
vi.mock("../rpc-handlers/tmux-pty", () => ({
	runDevServer: vi.fn(),
	stopDevServer: vi.fn(),
	restartDevServer: vi.fn(),
	getDevServerStatus: vi.fn(),
}));
vi.mock("../rpc-handlers", () => ({
	isActive: vi.fn(() => true),
	activateTask: vi.fn(),
	moveTask: vi.fn(),
	runCleanupScript: vi.fn(),
	emitTaskSound: vi.fn(),
	getPushMessage: vi.fn(() => null),
	triggerColumnAgentIfNeeded: vi.fn(),
	notifyWatchedTaskStatusChange: vi.fn(),
}));
vi.mock("../logger", () => ({
	createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock("../paths", () => ({ DEV3_HOME: "/tmp/test-dev3" }));
vi.mock("../socket-backpressure", () => ({
	flushAndEnd: vi.fn(),
	drainSocket: vi.fn(),
	pendingWrites: new Map(),
}));
vi.mock("../settings", () => ({
	loadSettings: vi.fn(() => ({ updateChannel: "stable", taskSortOrder: "oldest-first" })),
	saveSettings: vi.fn(),
	recordFavoriteUsages: vi.fn(),
}));
vi.mock("node:fs", () => ({
	existsSync: vi.fn(() => false),
	readdirSync: vi.fn(() => []),
	readFileSync: vi.fn(() => { throw new Error("ENOENT"); }),
	unlinkSync: vi.fn(),
	mkdirSync: vi.fn(),
	writeFileSync: vi.fn(),
	lstatSync: vi.fn(() => { throw new Error("ENOENT"); }),
	statSync: vi.fn(() => ({ isFile: () => true })),
	readlinkSync: vi.fn(() => { throw new Error("EINVAL"); }),
	realpathSync: vi.fn((p: string) => p),
	symlinkSync: vi.fn(),
	accessSync: vi.fn(),
}));

import { readFileSync } from "node:fs";
import * as data from "../data";
import { getPushMessage } from "../rpc-handlers";

const { handleRequest } = await import("../cli-socket-server");

const TASK_ID = "task-abc12345-1111-2222-3333-444444444444";

function makeProject(): Project {
	return {
		id: "proj-1",
		name: "Test Project",
		path: "/tmp/test-project",
		setupScript: "bun install",
		devScript: "",
		cleanupScript: "",
		defaultBaseBranch: "main",
		createdAt: new Date().toISOString(),
	};
}

function makeTask(overrides?: Partial<Task>): Task {
	return {
		id: TASK_ID,
		seq: 1,
		projectId: "proj-1",
		title: "Test task",
		description: "A test task",
		status: "in-progress",
		baseBranch: "main",
		worktreePath: "/tmp/wt",
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

function request(): CliRequest {
	return { id: "req-1", method: "task.setupFailed", params: { taskId: "task-abc12345", projectId: "proj-1" } };
}

/** Pretend the wrapper recorded `value` at the task's exit-code path. */
function recordedExit(value: string): void {
	vi.mocked(readFileSync).mockImplementation(((path: string) => {
		if (path === setupExitCodePath(TASK_ID)) return value;
		throw new Error("ENOENT");
	}) as unknown as typeof readFileSync);
}

describe("task.setupFailed", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.mocked(data.getProject).mockResolvedValue(makeProject());
		vi.mocked(data.loadTasks).mockResolvedValue([makeTask()]);
		vi.mocked(data.updateTask).mockImplementation(
			async (_p, _id, updates) => ({ ...makeTask(), ...updates }) as Task,
		);
		vi.mocked(readFileSync).mockImplementation((() => { throw new Error("ENOENT"); }) as unknown as typeof readFileSync);
	});

	it("stores the exit code the wrapper recorded", async () => {
		recordedExit("127");
		const resp = await handleRequest(request());

		expect(resp.ok).toBe(true);
		expect(vi.mocked(data.updateTask)).toHaveBeenCalledWith(
			expect.anything(),
			TASK_ID,
			{ setupFailedExitCode: 127 },
		);
	});

	it("falls back to 1 when the recorded code is missing or unreadable", async () => {
		const resp = await handleRequest(request());

		expect(resp.ok).toBe(true);
		expect(vi.mocked(data.updateTask)).toHaveBeenCalledWith(
			expect.anything(),
			TASK_ID,
			{ setupFailedExitCode: 1 },
		);
	});

	// A recorded 0 would mean "failed with success" — the wrapper only writes from
	// its fail branch, so a 0 here is corruption, not a passing setup.
	it("never stores 0", async () => {
		recordedExit("0");
		await handleRequest(request());

		expect(vi.mocked(data.updateTask)).toHaveBeenCalledWith(
			expect.anything(),
			TASK_ID,
			{ setupFailedExitCode: 1 },
		);
	});

	it("pushes the updated task so an open pane reacts without a refetch", async () => {
		const push = vi.fn();
		vi.mocked(getPushMessage).mockReturnValue(push);
		recordedExit("2");

		await handleRequest(request());

		expect(push).toHaveBeenCalledWith(
			"taskUpdated",
			expect.objectContaining({ task: expect.objectContaining({ setupFailedExitCode: 2 }) }),
		);
	});
});
