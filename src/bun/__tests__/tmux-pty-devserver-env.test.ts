import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Project, Task } from "../../shared/types";

/**
 * Where a caller's `--env` lands in the dev-server pane's environment, and how a
 * restart keeps it.
 *
 * The precedence is asserted at the CALL SITE — the `envGroups` array
 * `runDevServer` hands to `buildDevServerScript` — not on the script builder,
 * which cannot know what order the handler passes them in. Later group wins, so
 * the order IS the rule: project config < caller `--env` < lifecycle DEV3_* <
 * assigned ports. A caller that could move `DEV3_PORT0` would break `--wait`.
 */
// ---- Mocks ----

vi.mock("node:fs", () => ({
	existsSync: vi.fn(() => true),
	realpathSync: vi.fn((p: string) => p),
}));

vi.mock("../data", () => ({
	getProject: vi.fn(),
	getTask: vi.fn(),
}));

vi.mock("../pty-server", () => ({
	getSessionSocket: vi.fn(() => "dev3"),
	getSessionTmuxName: vi.fn((key: string) => `dev3-${key.slice(0, 8)}`),
	hasSession: vi.fn(() => false),
	hasDeadSession: vi.fn(() => false),
	destroySession: vi.fn(),
	capturePane: vi.fn(),
	listPaneIds: vi.fn(async () => []),
	tmuxSessionExists: vi.fn(async () => true),
	getPtyPort: vi.fn(() => 9999),
}));

// The handlers' tmux seam: mock the typed client singleton (the same pattern
// as mocking rpc.ts in renderer tests) — no raw spawn mocking anywhere.
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

vi.mock("../agents", () => ({}));
vi.mock("../repo-config", () => ({ resolveProjectEnv: vi.fn(async () => ({})) }));

vi.mock("../port-pool", () => ({
	getPortAssignments: vi.fn(() => []),
	allocatePorts: vi.fn(async () => []),
	buildPortEnv: vi.fn(() => ({})),
}));

vi.mock("../port-scanner", () => ({
	buildProcessTree: vi.fn(async () => new Map<number, number[]>()),
	clearDevServerSummaryForTask: vi.fn(),
	schedulePortScanSoon: vi.fn(),
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

vi.mock("../resource-monitor", () => ({
	getResourceUsage: vi.fn(() => undefined),
}));

vi.mock("../settings", () => ({
	loadSettings: vi.fn(async () => ({})),
	recordFavoriteUsages: vi.fn(),
}));

vi.mock("../shell-env", () => ({
	getUserShell: vi.fn(() => "/bin/zsh"),
}));

vi.mock("../spawn", () => ({
	spawn: vi.fn(() => ({ exited: Promise.resolve(0), stdout: undefined, stderr: undefined })),
}));

vi.mock("../agent-hooks", () => ({ setupAgentHooks: vi.fn() }));
vi.mock("../artifact-template", () => ({ ensureArtifactTemplateEnv: vi.fn() }));

vi.mock("../rpc-handlers/shared-pure", () => ({
	getPushMessage: vi.fn(() => null),
	isActive: vi.fn(() => true),
	buildAgentEnv: vi.fn(() => ({})),
	buildCmdScript: vi.fn(() => ""),
	buildEnvExports: vi.fn(() => []),
	buildScriptRunnerCommand: vi.fn(() => ""),
	buildTaskLifecycleEnv: vi.fn(() => ({})),
	escapeForDoubleQuotes: vi.fn((s: string) => s),
	// The dev-server pane writes and launches its wrapper through the dialect
	// (Seq 1546); the self-host refusal fires before either actually runs.
	generatedScriptName: vi.fn((base: string) => `${base}.sh`),
	generatedScriptLaunch: vi.fn((scriptPath: string) => ({ executable: "/bin/bash", argv: [scriptPath] })),
	writeLaunchScript: vi.fn(async () => {}),
	log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
	portableReadKey: vi.fn(() => ""),
	resolveBinaryPath: vi.fn(() => null),
	shellQuote: vi.fn((s: string) => s),
}));

vi.mock("../rpc-handlers/settings-config", () => ({
	resolveOperationalProjectConfig: vi.fn(async () => ({ devScript: "bun run dev", portCount: 0 })),
}));

// Mocked, not left real: the store touches the filesystem, and `node:fs` here is
// a two-export stub. Its own behaviour lives in `dev-server-env.test.ts`.
vi.mock("../dev-server-env-store", () => ({
	saveDevServerEnv: vi.fn(),
	readDevServerEnv: vi.fn(() => ({})),
	clearDevServerEnv: vi.fn(),
}));


vi.mock("../dev-server-script", () => ({
	buildDevServerScript: vi.fn(() => "#!/bin/bash\n"),
}));

// An in-memory stand-in for the on-disk store, so the handler's own read/save/
// clear ordering is what the restart tests exercise.
vi.mock("../dev-server-env-store", () => {
	const saved = new Map<string, Record<string, string>>();
	return {
		saveDevServerEnv: vi.fn((taskId: string, env: Record<string, string>) => {
			if (Object.keys(env).length === 0) saved.delete(taskId);
			else saved.set(taskId, env);
		}),
		readDevServerEnv: vi.fn((taskId: string) => saved.get(taskId) ?? {}),
		clearDevServerEnv: vi.fn((taskId: string) => { saved.delete(taskId); }),
		__saved: saved,
	};
});

import * as data from "../data";
import { buildDevServerScript } from "../dev-server-script";
import { clearDevServerEnv, readDevServerEnv, saveDevServerEnv } from "../dev-server-env-store";
import * as portPool from "../port-pool";
import { buildTaskLifecycleEnv } from "../rpc-handlers/shared-pure";
import { resolveOperationalProjectConfig } from "../rpc-handlers/settings-config";

const { runDevServer, restartDevServer, stopDevServer } = await import("../rpc-handlers/tmux-pty");

const TASK_ID = "aabbccdd-1111-2222-3333-444444444444";
const PROJECT_ENV = { SHARED: "from-project", PROJECT_ONLY: "1" };
const LIFECYCLE_ENV = { SHARED: "from-lifecycle", DEV3_TASK_ID: TASK_ID, DEV3_WORKTREE_ROOT: "/tmp/wt" };

function makeProject(): Project {
	return {
		id: "proj-1",
		name: "dev-3.0",
		path: "/tmp/dev-3.0",
		setupScript: "",
		devScript: "bun run dev",
		cleanupScript: "",
	} as Project;
}

function makeTask(): Task {
	return {
		id: TASK_ID,
		seq: 1,
		title: "t",
		description: "t",
		status: "in-progress",
		worktreePath: "/tmp/wt",
		tmuxSocket: "dev3",
	} as unknown as Task;
}

/** The groups `runDevServer` passed, in order, from the last build. */
function lastEnvGroups(): Record<string, string>[] {
	const calls = vi.mocked(buildDevServerScript).mock.calls;
	return calls[calls.length - 1][0].envGroups;
}

/** What the pane actually sees: later group wins, exactly as the exports do. */
function effectiveEnv(): Record<string, string> {
	return Object.assign({}, ...lastEnvGroups());
}

beforeEach(() => {
	vi.clearAllMocks();
	vi.mocked(clearDevServerEnv)(TASK_ID);
	vi.mocked(data.getProject).mockResolvedValue(makeProject());
	vi.mocked(data.getTask).mockResolvedValue(makeTask());
	vi.mocked(resolveOperationalProjectConfig).mockResolvedValue({
		devScript: "bun run dev",
		portCount: 1,
		env: PROJECT_ENV,
	} as unknown as Awaited<ReturnType<typeof resolveOperationalProjectConfig>>);
	vi.mocked(buildTaskLifecycleEnv).mockReturnValue(LIFECYCLE_ENV);
	vi.mocked(portPool.getPortAssignments).mockReturnValue([50001]);
	vi.mocked(portPool.buildPortEnv).mockImplementation((ports: number[]) => ({ DEV3_PORT0: String(ports[0]) }));
});

describe("dev-server --env precedence", () => {
	it("puts the caller's env after the project config and before lifecycle and ports", async () => {
		await runDevServer({ taskId: TASK_ID, projectId: "proj-1", env: { SHARED: "from-caller", MINE: "yes" } });

		expect(lastEnvGroups()).toEqual([
			PROJECT_ENV,
			{ SHARED: "from-caller", MINE: "yes" },
			LIFECYCLE_ENV,
			{ DEV3_PORT0: "50001" },
		]);
	});

	it("lets the caller override a project env entry", async () => {
		await runDevServer({ taskId: TASK_ID, projectId: "proj-1", env: { PROJECT_ONLY: "overridden" } });

		expect(effectiveEnv().PROJECT_ONLY).toBe("overridden");
	});

	it("never lets the caller move the task's identity", async () => {
		await runDevServer({
			taskId: TASK_ID,
			projectId: "proj-1",
			env: { SHARED: "from-caller", DEV3_TASK_ID: "someone-else" },
		});

		expect(effectiveEnv().SHARED).toBe("from-lifecycle");
		expect(effectiveEnv().DEV3_TASK_ID).toBe(TASK_ID);
	});

	// The one that would break `--wait`: it polls for a listener on DEV3_PORT0.
	it("never lets the caller move an assigned port", async () => {
		await runDevServer({ taskId: TASK_ID, projectId: "proj-1", env: { DEV3_PORT0: "1" } });

		expect(effectiveEnv().DEV3_PORT0).toBe("50001");
		// Dropped outright rather than merely outranked — it never reaches a group.
		expect(lastEnvGroups()[1]).toEqual({});
	});

	it("passes an empty caller group for an ordinary start", async () => {
		await runDevServer({ taskId: TASK_ID, projectId: "proj-1" });

		expect(lastEnvGroups()[1]).toEqual({});
	});
});

describe("dev-server --env across a restart", () => {
	it("remembers the env of the last start", async () => {
		await runDevServer({ taskId: TASK_ID, projectId: "proj-1", env: { DEV3_QA_SCOPE: "seeded" } });
		expect(saveDevServerEnv).toHaveBeenCalledWith(TASK_ID, { DEV3_QA_SCOPE: "seeded" });
		expect(readDevServerEnv(TASK_ID)).toEqual({ DEV3_QA_SCOPE: "seeded" });
	});

	// The UI's Restart button and a bare `dev3 dev-server restart` both land here.
	it("a restart with no env reuses the last start's env", async () => {
		await runDevServer({ taskId: TASK_ID, projectId: "proj-1", env: { DEV3_QA_SCOPE: "seeded" } });

		await restartDevServer({ taskId: TASK_ID, projectId: "proj-1" });

		expect(lastEnvGroups()[1]).toEqual({ DEV3_QA_SCOPE: "seeded" });
	});

	it("a restart with --env replaces it", async () => {
		await runDevServer({ taskId: TASK_ID, projectId: "proj-1", env: { DEV3_QA_SCOPE: "seeded" } });

		await restartDevServer({ taskId: TASK_ID, projectId: "proj-1", env: { DEV3_QA_SCOPE: "virgin" } });

		expect(lastEnvGroups()[1]).toEqual({ DEV3_QA_SCOPE: "virgin" });
	});

	it("a stop clears it, so the next plain start does not inherit it", async () => {
		await runDevServer({ taskId: TASK_ID, projectId: "proj-1", env: { DEV3_QA_SCOPE: "seeded" } });

		await stopDevServer({ taskId: TASK_ID, projectId: "proj-1" });
		expect(readDevServerEnv(TASK_ID)).toEqual({});

		await runDevServer({ taskId: TASK_ID, projectId: "proj-1" });
		expect(lastEnvGroups()[1]).toEqual({});
	});

	// A plain `start` defines its configuration whole — inheriting silently is
	// exactly the trap the `.dev3/config.local.json` recipe had.
	it("a plain start after an --env start clears the stored env", async () => {
		await runDevServer({ taskId: TASK_ID, projectId: "proj-1", env: { DEV3_QA_SCOPE: "seeded" } });

		await runDevServer({ taskId: TASK_ID, projectId: "proj-1" });

		expect(readDevServerEnv(TASK_ID)).toEqual({});
		expect(lastEnvGroups()[1]).toEqual({});
	});
});
