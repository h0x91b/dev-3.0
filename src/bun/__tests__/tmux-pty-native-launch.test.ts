/**
 * Backend routing of a task's PRIMARY terminal launch (seq 1292).
 *
 * The resolver (`../task-terminal-backend`) is REAL here — the task record is
 * what drives the branch, exactly as in production. Two properties matter: an
 * unmarked task takes the byte-for-byte legacy tmux path, and a task marked
 * `native` touches tmux nowhere and never silently degrades to it.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Project, Task } from "../../shared/types";

// ---- Mocks ----

vi.mock("../logger", () => ({
	createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

vi.mock("node:fs", () => ({
	existsSync: vi.fn(() => true),
	realpathSync: vi.fn((p: string) => p),
}));

vi.mock("../data", () => ({
	getProject: vi.fn(),
	getTask: vi.fn(),
	updateTask: vi.fn(async () => undefined),
}));

vi.mock("../pty-server", () => ({
	getSessionSocket: vi.fn(() => "dev3"),
	getSessionTmuxName: vi.fn((key: string) => `dev3-${key.slice(0, 8)}`),
	hasSession: vi.fn(() => false),
	hasDeadSession: vi.fn(() => false),
	createSession: vi.fn(),
	createNativeTaskSession: vi.fn(async () => undefined),
	destroySession: vi.fn(),
	capturePane: vi.fn(),
	listPaneIds: vi.fn(async () => ["%1"]),
	tmuxSessionExists: vi.fn(async () => true),
	getPtyPort: vi.fn(() => 9999),
}));

vi.mock("../tmux", () => {
	class MockTmuxError extends Error {
		exitCode = 1;
		stderr = "";
		constructor() { super("tmux failed"); this.name = "TmuxError"; }
	}
	class MockTmuxSpawnError extends Error {
		constructor() { super("tmux failed to spawn"); this.name = "TmuxSpawnError"; }
	}
	const format = { formatString: "", parse: () => [] };
	return {
		DEFAULT_TMUX_SOCKET: "dev3",
		TmuxError: MockTmuxError,
		TmuxSpawnError: MockTmuxSpawnError,
		isTmuxSpawnError: (err: unknown) => (err as { name?: string })?.name === "TmuxSpawnError",
		taskSessionName: (taskId: string) => `dev3-${taskId.slice(0, 8)}`,
		devServerSessionName: (taskId: string) => `dev3-dev-${taskId.slice(0, 8)}`,
		devServerSessionForTaskSession: (name: string) => `dev3-dev-${name.slice(5)}`,
		parseDev3SessionName: vi.fn(() => null),
		PANE_CWD_FORMAT: "#{pane_current_path}",
		PANE_ID_FORMAT: format,
		PANE_IN_MODE_FORMAT: format,
		PANE_START_COMMAND_FORMAT: format,
		PANE_CURRENT_COMMAND_FORMAT: format,
		PANE_SWITCHER_FORMAT: format,
		WINDOW_SWITCHER_FORMAT: format,
		SEARCH_STATE_FORMAT: format,
		SESSION_OVERVIEW_FORMAT: format,
		ALT_CLICK_PANE_FORMAT: format,
		altClickIneligibleReason: vi.fn(() => null),
		computeAltClickKeys: vi.fn(() => null),
		findAltClickPane: vi.fn(() => null),
		validAltClickPanes: vi.fn(() => []),
		tmux: {
			binaryPath: vi.fn(() => "/usr/bin/tmux"),
			hasSession: vi.fn(async () => true),
			listPanes: vi.fn(async () => []),
			listWindows: vi.fn(async () => []),
			listSessions: vi.fn(async () => []),
			displayMessage: vi.fn(async () => null),
			activePaneId: vi.fn(async () => null),
			splitWindow: vi.fn(async () => ({ paneId: null, stderr: "" })),
			newWindow: vi.fn(async () => ({ paneId: null, stderr: "" })),
			newSessionDetached: vi.fn(async () => ({ stderr: "" })),
			killSession: vi.fn(async () => undefined),
			killPane: vi.fn(async () => undefined),
			capturePane: vi.fn(async () => ""),
			sendKeys: vi.fn(async () => undefined),
			exitCopyMode: vi.fn(async () => undefined),
			selectPane: vi.fn(async () => undefined),
			selectWindow: vi.fn(async () => undefined),
			selectLayout: vi.fn(async () => undefined),
			nextLayout: vi.fn(async () => undefined),
			toggleZoom: vi.fn(async () => undefined),
			setOption: vi.fn(async () => undefined),
			setWindowHook: vi.fn(async () => undefined),
			setEnvironment: vi.fn(async () => undefined),
			removeEnvironment: vi.fn(async () => undefined),
			sourceFile: vi.fn(async () => undefined),
		},
	};
});

vi.mock("../agents", () => ({
	resolveCommandForAgent: vi.fn(async () => ({ command: "claude", extraEnv: {} })),
	resolveCommandForProject: vi.fn(async () => ({ command: "claude", extraEnv: {} })),
	supportsPreAssignedSessionId: vi.fn(() => false),
	getAllAgents: vi.fn(async () => []),
	ensureClaudeTrust: vi.fn(async () => undefined),
	ensureCodexTrust: vi.fn(async () => undefined),
	ensureGeminiTrust: vi.fn(async () => undefined),
}));

vi.mock("../../shared/agent-adapters/registry", () => ({
	getAgentAdapter: vi.fn(() => ({ trustKinds: [] })),
}));

vi.mock("../agent-prompt", () => ({ markAgentPane: vi.fn() }));
vi.mock("../temp-paths", () => ({
	dev3TaskTempPath: vi.fn((taskId: string, name?: string) => (name ? `/tmp/dev3/${taskId}/${name}` : `/tmp/dev3/${taskId}`)),
}));

vi.mock("../repo-config", () => ({}));

vi.mock("../port-pool", () => ({
	getPortAssignments: vi.fn(() => []),
	allocatePorts: vi.fn(async () => []),
	buildPortEnv: vi.fn(() => ({})),
}));

vi.mock("../port-scanner", () => ({
	buildProcessTree: vi.fn(async () => new Map<number, number[]>()),
	clearPortDataForTask: vi.fn(),
	collectDescendants: vi.fn(() => []),
	collectTaskPids: vi.fn(async () => new Set<number>()),
	findPortHolders: vi.fn(async () => []),
	getLsofOutput: vi.fn(async () => ""),
	getPortsForTask: vi.fn(() => []),
	getSessionPanePids: vi.fn(async () => [123]),
	parseLsofOutput: vi.fn(() => []),
	scanTaskPorts: vi.fn(async () => []),
	waitForPortsFree: vi.fn(async () => []),
}));

vi.mock("../process-reaper", () => ({
	getPidCwd: vi.fn(async () => null),
	terminatePidsVerified: vi.fn(async () => []),
}));

vi.mock("../resource-monitor", () => ({ getResourceUsage: vi.fn(() => undefined) }));

vi.mock("../settings", () => ({
	loadSettings: vi.fn(async () => ({})),
	recordFavoriteUsages: vi.fn(),
}));

vi.mock("../shell-env", () => ({ getUserShell: vi.fn(() => "/bin/zsh") }));

vi.mock("../spawn", () => ({
	spawn: vi.fn(() => ({ exited: Promise.resolve(0), stdout: undefined, stderr: undefined })),
}));

vi.mock("../agent-hooks", () => ({ setupAgentHooks: vi.fn() }));
vi.mock("../artifact-template", () => ({ ensureArtifactTemplateEnv: vi.fn(() => ({ DEV3_ARTIFACT_DIR: "/tmp/art" })) }));

vi.mock("../rpc-handlers/shared-pure", () => ({
	getPushMessage: vi.fn(() => null),
	getScriptShellPath: vi.fn((shellPath?: string) => shellPath || "/bin/zsh"),
	isActive: vi.fn(() => true),
	buildAgentEnv: vi.fn(() => ({ DEV3_AGENT: "claude" })),
	buildAgentRetryWrapper: vi.fn(() => "#!/bin/bash\n# retry\n"),
	buildCmdScript: vi.fn(() => "#!/bin/bash\n"),
	buildSetupStartupWrapper: vi.fn(() => "#!/bin/bash\n# startup\n"),
	buildEnvExports: vi.fn(() => []),
	buildScriptRunnerCommand: vi.fn((scriptPath: string) => `/bin/zsh ${scriptPath}`),
	buildTaskLifecycleEnv: vi.fn((_p: Project, task: Task) => ({ DEV3_TASK_ID: task.id })),
	escapeForDoubleQuotes: vi.fn((s: string) => s),
	log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
	portableReadKey: vi.fn(() => ""),
	resolveBinaryPath: vi.fn(() => ({ resolvedPath: "/usr/local/bin/claude" })),
	shellQuote: vi.fn((s: string) => s),
	writeLaunchScript: vi.fn(async () => undefined),
}));

vi.mock("../rpc-handlers/settings-config", () => ({
	resolveOperationalProjectConfig: vi.fn(async () => ({ devScript: "", portCount: 0 })),
}));

import * as pty from "../pty-server";
import * as sharedPure from "../rpc-handlers/shared-pure";
import { tmux } from "../tmux";

const { launchTaskPty } = await import("../rpc-handlers/tmux-pty");

// ---- Fixtures ----

const TASK_ID = "aabbccdd-1111-2222-3333-444444444444";
const WORKTREE = "/tmp/wt";
const RUN_SCRIPT = `/tmp/dev3/${TASK_ID}/run.sh`;
const EXPECTED_ENV = { DEV3_TASK_ID: TASK_ID, DEV3_AGENT: "claude", DEV3_ARTIFACT_DIR: "/tmp/art" };
const SETUP_SCRIPT = `/tmp/dev3/${TASK_ID}-setup.sh`;
const CMD_SCRIPT = `/tmp/dev3/${TASK_ID}-cmd.sh`;

// The generated wrapper scripts are the product here, so capture their bodies
// instead of the no-op Bun.write stub the bun test setup installs.
const written = new Map<string, string>();
vi.spyOn(Bun, "write").mockImplementation(async (path: unknown, content: unknown) => {
	written.set(String(path), String(content));
	return 0;
});

function makeProject(overrides: Partial<Project> = {}): Project {
	return {
		id: "proj-1",
		name: "dev-3.0",
		path: "/tmp/dev-3.0",
		setupScript: "",
		devScript: "",
		cleanupScript: "",
		...overrides,
	} as Project;
}

function makeTask(overrides: Record<string, unknown> = {}): Task {
	return {
		id: TASK_ID,
		seq: 1,
		projectId: "proj-1",
		title: "t",
		description: "t",
		status: "in-progress",
		worktreePath: WORKTREE,
		...overrides,
	} as unknown as Task;
}

/** Every tmux client method the handlers could reach, as one assertable list. */
function tmuxCalls(): string[] {
	return Object.entries(tmux)
		.filter(([, fn]) => vi.isMockFunction(fn) && fn.mock.calls.length > 0)
		.map(([name]) => name);
}

beforeEach(() => {
	vi.clearAllMocks();
	written.clear();
});

describe("unmarked task — the legacy tmux path is untouched", () => {
	it("creates a tmux PTY session and never a native one", async () => {
		await launchTaskPty(makeProject(), makeTask(), WORKTREE);

		expect(pty.createSession).toHaveBeenCalledTimes(1);
		expect(pty.createNativeTaskSession).not.toHaveBeenCalled();
	});

	it("passes the wrapper command, env, and socket to createSession", async () => {
		await launchTaskPty(makeProject(), makeTask(), WORKTREE);

		expect(pty.createSession).toHaveBeenCalledWith(
			TASK_ID,
			"proj-1",
			WORKTREE,
			`/bin/zsh ${RUN_SCRIPT}`,
			EXPECTED_ENV,
			"dev3",
		);
	});

	it("still gates the launch on the tmux session actually appearing", async () => {
		await launchTaskPty(makeProject(), makeTask(), WORKTREE);

		expect(pty.tmuxSessionExists).toHaveBeenCalledWith(TASK_ID, "dev3");
	});

	it("still probes tmux for a virtual project's pre-existing session", async () => {
		await launchTaskPty(makeProject({ kind: "virtual" }), makeTask(), WORKTREE);

		expect(tmux.hasSession).toHaveBeenCalledWith(`dev3-${TASK_ID.slice(0, 8)}`, { socket: "dev3" });
	});
});

describe("native task — tmux is not involved at all", () => {
	it("creates the native session with the same wrapper script as an explicit launch spec", async () => {
		await launchTaskPty(makeProject(), makeTask({ terminalBackend: "native" }), WORKTREE);

		expect(pty.createNativeTaskSession).toHaveBeenCalledWith(
			TASK_ID,
			"proj-1",
			WORKTREE,
			{ executable: "/bin/zsh", argv: [RUN_SCRIPT] },
			EXPECTED_ENV,
		);
	});

	it("hands the native session the same env the tmux path would get", async () => {
		await launchTaskPty(makeProject(), makeTask(), WORKTREE);
		await launchTaskPty(makeProject(), makeTask({ terminalBackend: "native" }), WORKTREE);

		const tmuxEnv = vi.mocked(pty.createSession).mock.calls[0][4];
		const nativeEnv = vi.mocked(pty.createNativeTaskSession).mock.calls[0][4];
		expect(nativeEnv).toEqual(tmuxEnv);
	});

	it("never creates or probes a tmux session", async () => {
		await launchTaskPty(makeProject(), makeTask({ terminalBackend: "native" }), WORKTREE);

		expect(pty.createSession).not.toHaveBeenCalled();
		expect(pty.tmuxSessionExists).not.toHaveBeenCalled();
		expect(tmuxCalls()).toEqual([]);
	});

	it("skips the virtual-project side shell instead of splitting a tmux pane", async () => {
		await launchTaskPty(makeProject({ kind: "virtual" }), makeTask({ terminalBackend: "native" }), WORKTREE);

		expect(pty.createNativeTaskSession).toHaveBeenCalledTimes(1);
		expect(tmuxCalls()).toEqual([]);
	});

	it("propagates a native launch failure without falling back to tmux", async () => {
		vi.mocked(pty.createNativeTaskSession).mockRejectedValueOnce(new Error("no native host runtime"));

		await expect(
			launchTaskPty(makeProject(), makeTask({ terminalBackend: "native" }), WORKTREE),
		).rejects.toThrow(/no native host runtime/);
		expect(pty.createSession).not.toHaveBeenCalled();
		expect(tmuxCalls()).toEqual([]);
	});
});

// The tmux flavour of the setup wrapper starts the agent with a bare
// `tmux split-window`, which only works inside a dev3 tmux pane. A native task has
// one view and no $TMUX, so a shelled-out `tmux` would hit the user's own default
// socket and the agent would never start at all. The wrapper TEXT of both flavours
// is pinned in `platform-launch-posix-golden.test.ts`; here only the routing —
// which flavour a task asks for — is under test.
describe("setup-script wrapper — one flavour per backend", () => {
	const setupProject = (overrides: Partial<Project> = {}) =>
		makeProject({ setupScript: "bun install\n", ...overrides });

	it("asks for the native flavour and keeps the launch free of any tmux call", async () => {
		await launchTaskPty(setupProject(), makeTask({ terminalBackend: "native" }), WORKTREE, null, null, true);

		expect(vi.mocked(sharedPure.buildSetupStartupWrapper)).toHaveBeenCalledWith(
			expect.objectContaining({
				setupPath: SETUP_SCRIPT,
				cmdPath: CMD_SCRIPT,
				worktreePath: WORKTREE,
				nativeBackend: true,
				launchMode: "parallel",
			}),
		);
		expect(pty.createNativeTaskSession).toHaveBeenCalledTimes(1);
		expect(pty.createSession).not.toHaveBeenCalled();
		expect(tmuxCalls()).toEqual([]);
	});

	it("asks for the tmux flavour for an unmarked task", async () => {
		await launchTaskPty(setupProject(), makeTask(), WORKTREE, null, null, true);

		expect(vi.mocked(sharedPure.buildSetupStartupWrapper)).toHaveBeenCalledWith(
			expect.objectContaining({ nativeBackend: false, launchMode: "parallel" }),
		);
		expect(pty.createSession).toHaveBeenCalledTimes(1);
	});

	// Windows stamps new tasks native at creation; an explicitly tmux-marked task
	// there must still be routed to tmux — which then fails on its POSIX-only
	// guard — never quietly switched to the backend that happens to work.
	it("keeps an explicitly tmux task on the tmux path on Windows", async () => {
		const realPlatform = process.platform;
		Object.defineProperty(process, "platform", { value: "win32", writable: true });
		try {
			await launchTaskPty(setupProject(), makeTask({ terminalBackend: "tmux" }), WORKTREE, null, null, true)
				.catch(() => undefined);
		} finally {
			Object.defineProperty(process, "platform", { value: realPlatform, writable: true });
		}

		expect(pty.createNativeTaskSession).not.toHaveBeenCalled();
		expect(vi.mocked(sharedPure.buildSetupStartupWrapper)).toHaveBeenCalledWith(
			expect.objectContaining({ nativeBackend: false }),
		);
	});

	it("forwards the project's blocking launch mode", async () => {
		await launchTaskPty(
			setupProject({ setupScriptLaunchMode: "blocking" }),
			makeTask(),
			WORKTREE,
			null,
			null,
			true,
		);

		expect(vi.mocked(sharedPure.buildSetupStartupWrapper)).toHaveBeenCalledWith(
			expect.objectContaining({ nativeBackend: false, launchMode: "blocking" }),
		);
	});
});
