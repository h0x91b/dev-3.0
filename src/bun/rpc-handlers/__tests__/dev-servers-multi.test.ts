/**
 * Several dev servers on one task: which one a command means, what each start
 * puts in front of the user, and what a stop leaves running.
 *
 * The seam is the RPC handler with the tmux singleton mocked — the same one the
 * backend-matrix suite uses — so every assertion is about an observable outcome:
 * which tmux session was created, which pane it split, what the wrapper script
 * was handed, and what the returned status says.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
	// data
	getProject: vi.fn(),
	getTask: vi.fn(),
	// settings-config
	resolveOperationalProjectConfig: vi.fn(),
	// task-terminal-backend
	taskTerminalBackendIdentity: vi.fn(),
	// task-aux-panes seam
	auxPaneAlive: vi.fn(),
	closeAuxPane: vi.fn(),
	findAuxPane: vi.fn(),
	nativeAuxPaneShellPid: vi.fn(),
	openAuxPane: vi.fn(),
	// port pool / scanner / reaper
	getPortAssignments: vi.fn(() => [] as number[]),
	allocatePorts: vi.fn(),
	buildPortEnv: vi.fn((_ports: number[]) => ({}) as Record<string, string>),
	buildNamedPortEnv: vi.fn((_named: Record<string, number>) => ({}) as Record<string, string>),
	buildProcessTree: vi.fn(async () => new Map<number, number[]>()),
	collectDescendants: vi.fn(() => [] as number[]),
	collectTaskPids: vi.fn(async () => new Set<number>()),
	findPortHolders: vi.fn(async () => []),
	getLsofOutput: vi.fn(async () => ""),
	getPortsForTask: vi.fn(() => []),
	getSessionPanePids: vi.fn(async () => [] as number[]),
	parseLsofOutput: vi.fn(() => []),
	scanTaskPorts: vi.fn(async () => []),
	waitForPortsFree: vi.fn(async () => []),
	clearPortDataForTask: vi.fn(),
	clearDevServerSummaryForTask: vi.fn(),
	schedulePortScanSoon: vi.fn(),
	getPidCwd: vi.fn(async () => null),
	terminatePidsVerified: vi.fn(async () => [] as number[]),
	getResourceUsage: vi.fn(() => undefined),
	writeLaunchScript: vi.fn(async () => {}),
	// tmux singleton — every method the dev-server paths could reach
	tmuxHasSession: vi.fn(async (_session: string) => false),
	// How a tmux task's live dev servers are enumerated: one session per server.
	tmuxListSessions: vi.fn(async () => [] as Array<{ name: string }>),
	tmuxNewSessionDetached: vi.fn(async (_opts: { sessionName: string }) => ({ stdout: "", stderr: "" })),
	tmuxSplitWindow: vi.fn(async (_opts: { target: string; orientation: string }) => ({ paneId: "%7", stdout: "", stderr: "" })),
	tmuxKillSession: vi.fn(async (_session: string, _opts?: unknown) => {}),
	tmuxKillPane: vi.fn(async () => {}),
	tmuxSelectPane: vi.fn(async () => {}),
	tmuxSetOption: vi.fn(async () => {}),
	tmuxListPanes: vi.fn(async () => []),
	tmuxBinaryPath: vi.fn(() => "/opt/homebrew/bin/tmux"),
}));

vi.mock("../../data", () => ({ getProject: mocks.getProject, getTask: mocks.getTask }));
vi.mock("../settings-config", () => ({ resolveOperationalProjectConfig: mocks.resolveOperationalProjectConfig }));
vi.mock("../../task-terminal-backend", () => ({ taskTerminalBackendIdentity: mocks.taskTerminalBackendIdentity }));

vi.mock("../../task-aux-panes", () => ({
	auxPaneAlive: mocks.auxPaneAlive,
	auxPaneTitle: (purpose: string) => (purpose === "devServer" ? "Dev Server" : "Git"),
	closeAuxPane: mocks.closeAuxPane,
	findAuxPane: mocks.findAuxPane,
	nativeAuxPaneShellPid: mocks.nativeAuxPaneShellPid,
	openAuxPane: mocks.openAuxPane,
}));

vi.mock("../../port-pool", () => ({
	getPortAssignments: mocks.getPortAssignments,
	allocatePorts: mocks.allocatePorts,
	buildPortEnv: mocks.buildPortEnv,
	buildNamedPortEnv: mocks.buildNamedPortEnv,
}));

vi.mock("../../port-scanner", () => ({
	buildProcessTree: mocks.buildProcessTree,
	clearPortDataForTask: mocks.clearPortDataForTask,
	clearDevServerSummaryForTask: mocks.clearDevServerSummaryForTask,
	schedulePortScanSoon: mocks.schedulePortScanSoon,
	collectDescendants: mocks.collectDescendants,
	collectTaskPids: mocks.collectTaskPids,
	findPortHolders: mocks.findPortHolders,
	getLsofOutput: mocks.getLsofOutput,
	getPortsForTask: mocks.getPortsForTask,
	getSessionPanePids: mocks.getSessionPanePids,
	parseLsofOutput: mocks.parseLsofOutput,
	scanTaskPorts: mocks.scanTaskPorts,
	waitForPortsFree: mocks.waitForPortsFree,
}));

vi.mock("../../process-reaper", () => ({ getPidCwd: mocks.getPidCwd, terminatePidsVerified: mocks.terminatePidsVerified }));
vi.mock("../../resource-monitor", () => ({ getResourceUsage: mocks.getResourceUsage }));

vi.mock("../../pty-server", () => ({}));
vi.mock("../../agents", () => ({}));
vi.mock("../../repo-config", () => ({}));
vi.mock("../../settings", () => ({ loadSettings: vi.fn(), recordFavoriteUsages: vi.fn() }));
vi.mock("../../shell-env", () => ({ getUserShell: vi.fn(() => "/bin/bash") }));
vi.mock("../../spawn", () => ({ spawn: vi.fn() }));
vi.mock("../../agent-hooks", () => ({ setupAgentHooks: vi.fn() }));
vi.mock("../../agent-transcripts", () => ({ resolveResumableSessionId: vi.fn() }));
vi.mock("../../artifact-template", () => ({ ensureArtifactTemplateEnv: vi.fn() }));
vi.mock("../../agent-prompt", () => ({ markAgentPane: vi.fn() }));
vi.mock("../../native-task-panes", () => ({
	nativeTaskPanesAlive: vi.fn(async () => false),
	// How a native task's live dev servers are enumerated: each pane carries its
	// server's script path in its launch command.
	nativeTaskPaneCommands: vi.fn(async () => []),
}));

vi.mock("../../dev-server-script", () => ({ buildDevServerScript: vi.fn(() => "#!/bin/bash\n") }));

vi.mock("../shared-pure", async (importOriginal) => ({
	...(await importOriginal<typeof import("../shared-pure")>()),
	writeLaunchScript: mocks.writeLaunchScript,
}));

vi.mock("../../tmux", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../tmux")>()),
	tmux: {
		hasSession: mocks.tmuxHasSession,
		listSessions: mocks.tmuxListSessions,
		newSessionDetached: mocks.tmuxNewSessionDetached,
		splitWindow: mocks.tmuxSplitWindow,
		killSession: mocks.tmuxKillSession,
		killPane: mocks.tmuxKillPane,
		selectPane: mocks.tmuxSelectPane,
		setOption: mocks.tmuxSetOption,
		listPanes: mocks.tmuxListPanes,
		binaryPath: mocks.tmuxBinaryPath,
	},
}));

import { buildDevServerScript } from "../../dev-server-script";
import { runDevServer, stopDevServer, restartDevServer, getDevServerStatus } from "../tmux-pty";

const TASK_ID = "abcdef12-0000-0000-0000-000000000001";
const TASK_SESSION = "dev3-abcdef12";
const PROJECT = { id: "proj-1", name: "p", path: "/repo" } as any;
const TASK = { id: TASK_ID, title: "Multi server task", branchName: "feat/x", worktreePath: "/repo/wt", tmuxSocket: "dev3" } as any;

/** The config cascade's answer for this task — what the handler resolves from. */
function declare(config: Record<string, unknown>) {
	mocks.resolveOperationalProjectConfig.mockResolvedValue({ devScript: "", portCount: 0, env: {}, ...config });
}

/** Which tmux sessions the task currently has, as `list-sessions` would report. */
function liveSessions(...names: string[]) {
	mocks.tmuxListSessions.mockResolvedValue(names.map((name) => ({ name })));
}

/** The sessions `new-session -d` was asked to create, in order. */
function createdSessions(): string[] {
	return mocks.tmuxNewSessionDetached.mock.calls.map((call) => call[0].sessionName);
}

/** The env groups the wrapper script of the nth start was built from. */
function envGroupsOf(call: number): Record<string, string>[] {
	return vi.mocked(buildDevServerScript).mock.calls[call][0].envGroups;
}

beforeEach(() => {
	vi.clearAllMocks();
	mocks.taskTerminalBackendIdentity.mockReturnValue("tmux");
	mocks.getProject.mockResolvedValue(PROJECT);
	mocks.getTask.mockResolvedValue(TASK);
	declare({ devScript: "bun run dev" });
	mocks.getPortAssignments.mockReturnValue([]);
	mocks.getLsofOutput.mockResolvedValue("");
	mocks.buildProcessTree.mockResolvedValue(new Map());
	mocks.collectDescendants.mockReturnValue([]);
	mocks.terminatePidsVerified.mockResolvedValue([]);
	mocks.waitForPortsFree.mockResolvedValue([]);
	mocks.findPortHolders.mockResolvedValue([]);
	mocks.tmuxHasSession.mockResolvedValue(false);
	mocks.tmuxListSessions.mockResolvedValue([]);
	mocks.tmuxNewSessionDetached.mockResolvedValue({ stdout: "", stderr: "" });
	mocks.tmuxSplitWindow.mockResolvedValue({ paneId: "%7", stdout: "", stderr: "" });
});

describe("which server a command means", () => {
	it("an unnamed start runs the default server", async () => {
		declare({ devScript: "bun run dev", devServers: { api: { script: "bun run api" } } });

		await runDevServer({ taskId: TASK_ID, projectId: PROJECT.id });

		expect(createdSessions()).toEqual(["dev3-dev-abcdef12"]);
	});

	// A single-server project should never have to spell its server's name.
	it("an unnamed start runs the only server when there is no default", async () => {
		declare({ devServers: { api: { script: "bun run api" } } });

		await runDevServer({ taskId: TASK_ID, projectId: PROJECT.id });

		expect(createdSessions()).toEqual(["dev3-dev-abcdef12-api"]);
	});

	// Guessing here would start the wrong process, so the refusal carries the
	// names and a code the CLI turns into its own exit status.
	it("an unnamed start refuses between several servers and names them", async () => {
		declare({ devServers: { api: { script: "x" }, web: { script: "y" } } });

		await expect(runDevServer({ taskId: TASK_ID, projectId: PROJECT.id }))
			.rejects.toThrow(/DEV3_DEV_SERVER_NAME_REQUIRED.*api, web/);
		expect(mocks.tmuxNewSessionDetached).not.toHaveBeenCalled();
	});

	it("a named start runs that server in its own session", async () => {
		declare({ devScript: "bun run dev", devServers: { "back-office": { script: "bun run bo" } } });

		await runDevServer({ taskId: TASK_ID, projectId: PROJECT.id, server: "back-office" });

		expect(createdSessions()).toEqual(["dev3-dev-abcdef12-back-office"]);
	});

	it("--all starts every declared server", async () => {
		declare({ devScript: "bun run dev", devServers: { api: { script: "x" }, web: { script: "y" } } });

		await runDevServer({ taskId: TASK_ID, projectId: PROJECT.id, all: true });

		expect(createdSessions()).toEqual(["dev3-dev-abcdef12", "dev3-dev-abcdef12-api", "dev3-dev-abcdef12-web"]);
	});
});

describe("panes", () => {
	it("splits the task window for the first server and the server column for the next", async () => {
		declare({ devScript: "bun run dev", devServers: { api: { script: "x" } } });
		mocks.tmuxSplitWindow.mockResolvedValue({ paneId: "%7", stdout: "", stderr: "" });

		await runDevServer({ taskId: TASK_ID, projectId: PROJECT.id });
		// The first server is now live, and its viewer pane is the one the second
		// splits — so the agent keeps the left half whatever else starts.
		liveSessions("dev3-dev-abcdef12");
		await runDevServer({ taskId: TASK_ID, projectId: PROJECT.id, server: "api" });

		const [first, second] = mocks.tmuxSplitWindow.mock.calls.map((call) => call[0]);
		expect(first).toMatchObject({ target: TASK_SESSION, orientation: "horizontal" });
		expect(second).toMatchObject({ target: "%7", orientation: "vertical" });
	});
});

describe("ports", () => {
	it("hands every server every named port of the task", async () => {
		declare({
			portCount: 1,
			devScript: "bun run dev",
			devServers: { api: { script: "x", ports: ["api"] } },
		});
		mocks.getPortAssignments.mockReturnValue([10001, 10002]);
		mocks.buildPortEnv.mockImplementation((ports: number[]) => ({ DEV3_PORT0: String(ports[0]) }));
		mocks.buildNamedPortEnv.mockImplementation((named: Record<string, number>) => (
			Object.fromEntries(Object.entries(named).map(([name, port]) => [`DEV3_PORT_${name.toUpperCase()}`, String(port)]))
		));

		await runDevServer({ taskId: TASK_ID, projectId: PROJECT.id, all: true });

		// The front end declares no port of its own and still learns where the API is.
		for (const call of [0, 1]) {
			const env = Object.assign({}, ...envGroupsOf(call));
			expect(env.DEV3_PORT0).toBe("10001");
			expect(env.DEV3_PORT_API).toBe("10002");
		}
	});

	it("allocates one pool port per named port on top of the positional block", async () => {
		declare({
			portCount: 2,
			devServers: { api: { script: "x", ports: ["api"] }, web: { script: "y", ports: ["web"] } },
		});
		mocks.getPortAssignments.mockReturnValue([]);

		await runDevServer({ taskId: TASK_ID, projectId: PROJECT.id, all: true });

		expect(mocks.allocatePorts).toHaveBeenCalledWith(TASK_ID, 4);
	});
});

describe("refused declarations", () => {
	it("refuses to start anything while two servers claim one named port", async () => {
		declare({ devServers: { api: { script: "x", ports: ["http"] }, web: { script: "y", ports: ["http"] } } });

		await expect(runDevServer({ taskId: TASK_ID, projectId: PROJECT.id, all: true }))
			.rejects.toThrow(/claimed by both/);
		expect(mocks.tmuxNewSessionDetached).not.toHaveBeenCalled();
	});

	it("refuses to start while `dev` is declared twice", async () => {
		declare({ devScript: "bun run dev", devServers: { dev: { script: "something else" } } });

		await expect(runDevServer({ taskId: TASK_ID, projectId: PROJECT.id }))
			.rejects.toThrow(/declared twice/);
	});
});

describe("stopping", () => {
	it("stops only the named server and leaves the others alone", async () => {
		declare({ devScript: "bun run dev", devServers: { api: { script: "x" } } });
		liveSessions("dev3-dev-abcdef12", "dev3-dev-abcdef12-api");

		await stopDevServer({ taskId: TASK_ID, projectId: PROJECT.id, server: "api" });

		expect(mocks.tmuxKillSession).toHaveBeenCalledWith("dev3-dev-abcdef12-api", expect.anything());
		expect(mocks.tmuxKillSession).not.toHaveBeenCalledWith("dev3-dev-abcdef12", expect.anything());
		// A server still running keeps the pane border that titles its viewer.
		expect(mocks.tmuxSetOption).not.toHaveBeenCalled();
	});

	it("--all stops every server of the task", async () => {
		declare({ devScript: "bun run dev", devServers: { api: { script: "x" } } });
		liveSessions("dev3-dev-abcdef12", "dev3-dev-abcdef12-api");

		await stopDevServer({ taskId: TASK_ID, projectId: PROJECT.id, all: true });

		const killed = mocks.tmuxKillSession.mock.calls.map((call) => call[0]);
		expect(killed).toEqual(expect.arrayContaining(["dev3-dev-abcdef12", "dev3-dev-abcdef12-api"]));
	});

	// A server whose declaration was deleted while it ran is still somebody's
	// process holding somebody's port.
	it("--all also stops a server that is live but no longer declared", async () => {
		declare({ devScript: "bun run dev" });
		liveSessions("dev3-dev-abcdef12", "dev3-dev-abcdef12-ghost");

		await stopDevServer({ taskId: TASK_ID, projectId: PROJECT.id, all: true });

		expect(mocks.tmuxKillSession).toHaveBeenCalledWith("dev3-dev-abcdef12-ghost", expect.anything());
	});

	it("restarting one server does not touch another", async () => {
		declare({ devScript: "bun run dev", devServers: { api: { script: "x" } } });
		liveSessions("dev3-dev-abcdef12", "dev3-dev-abcdef12-api");

		await restartDevServer({ taskId: TASK_ID, projectId: PROJECT.id, server: "api" });

		expect(mocks.tmuxKillSession).not.toHaveBeenCalledWith("dev3-dev-abcdef12", expect.anything());
		expect(createdSessions()).toEqual(["dev3-dev-abcdef12-api"]);
	});
});

describe("status", () => {
	it("reports one entry per declared server, with the default first", async () => {
		declare({ devScript: "bun run dev", devServers: { api: { script: "x", ports: ["api"] } } });
		mocks.tmuxHasSession.mockImplementation(async (session: string) => session === "dev3-dev-abcdef12-api");

		const status = await getDevServerStatus({ taskId: TASK_ID, projectId: PROJECT.id });

		expect(status.servers.map((entry) => [entry.name, entry.running])).toEqual([["dev", false], ["api", true]]);
		expect(status.servers[0].isDefault).toBe(true);
		// The task is "running" when any of its servers is.
		expect(status.running).toBe(true);
	});

	it("carries a broken declaration instead of hiding it", async () => {
		declare({ devServers: { api: { script: "x", ports: ["http"] }, web: { script: "y", ports: ["http"] } } });

		const status = await getDevServerStatus({ taskId: TASK_ID, projectId: PROJECT.id });

		expect(status.configErrors.join(" ")).toContain("claimed by both");
	});
});
